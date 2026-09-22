import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { RehearsalState } from "@/lib/rehearsal-contracts";
import { getPool } from "../db/pool";
import type { EventRow, SessionRow, TxContext } from "../db/types";
import { createSessionToken, getRequestTokenHash, hashSessionToken, sessionCookieHeader, clearSessionCookieHeader } from "../auth/session";
import { authenticateOperator, bootstrapSession } from "../services/registration";
import { consumeRateLimit } from "../auth/rate-limit";
import { verifyOperatorCode } from "../auth/operator-code";
import { executeAdminCommand } from "../services/admin-service";
import { executeGameCommand } from "../services/game-service";
import { settleBlocks } from "../services/block-service";
import { settleDeadlines } from "../db/tx";
import { CommandRejected, json, reject } from "../http/respond";
import { assertRehearsalDeployment, assertSyntheticRehearsalRoster, type RehearsalPerson } from "./guards";
import { cookieValue, operatorCodeDigest, parseSupervisorGrant, signSupervisorGrant, supervisorCookieHeader,
  SUPERVISOR_COOKIE, SUPERVISOR_MAX_AGE_SECONDS, type SupervisorGrant } from "./supervisor";
import { restartSyntheticRehearsal } from "./reset-fixture.mjs";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ slug: z.string(), action: z.literal("enable"), code: z.string().min(1).max(128) }).strict(),
  z.object({ slug: z.string(), action: z.literal("switch"), participantId: z.uuid() }).strict(),
  z.object({ slug: z.string(), action: z.literal("assist") }).strict(),
  z.object({ slug: z.string(), action: z.literal("disable") }).strict(),
  z.object({ slug: z.string(), action: z.literal("reset"), confirm: z.literal("RESET") }).strict(),
  z.object({ slug: z.string(), action: z.literal("start") }).strict(),
  z.object({ slug: z.string(), action: z.literal("focus-turn") }).strict(),
]);
interface Context { client: PoolClient; event: EventRow; roster: RehearsalPerson[]; now: Date }
interface HostSession extends SessionRow { operator_code_hash: string }

async function transaction<T>(slug: string, work: (context: Context) => Promise<T>): Promise<T> {
  assertRehearsalDeployment(slug);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
    const marker = await client.query("SELECT name FROM public.app_environment WHERE singleton=true");
    if (marker.rows[0]?.name !== "development") reject(404, "NOT_FOUND");
    const event = (await client.query<EventRow>("SELECT * FROM events WHERE slug=$1 FOR UPDATE", [slug])).rows[0];
    if (!event) reject(404, "NOT_FOUND");
    const roster = (await client.query<RehearsalPerson>("SELECT id,display_name,role,roster_order,active FROM participants WHERE event_id=$1 ORDER BY roster_order", [event.id])).rows;
    assertSyntheticRehearsalRoster(roster);
    if (!roster.some(person => person.id === event.host_participant_id && person.role === "operator")) reject(404, "NOT_FOUND");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
    const result = await work({ client, event, roster, now });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (error instanceof CommandRejected && error.preserveWrites) await client.query("COMMIT");
    else await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  finally { client.release(); }
}

async function validHostSession(context: Context, tokenHash: string | null): Promise<HostSession | null> {
  if (!tokenHash) return null;
  const { client, event, now } = context;
  return (await client.query<HostSession>(`SELECT s.*,p.role,p.display_name,p.operator_code_hash FROM sessions s
    JOIN participants p ON p.id=s.participant_id AND p.event_id=s.event_id
    WHERE s.event_id=$1 AND s.token_hash=$2 AND s.participant_id=$3 AND s.revoked_at IS NULL
      AND s.expires_at>$4 AND p.active AND p.role='operator' AND p.operator_code_hash IS NOT NULL`,
  [event.id, tokenHash, event.host_participant_id, now])).rows[0] ?? null;
}
async function validateGrant(context: Context, request: Request) {
  const grant = parseSupervisorGrant(cookieValue(request, SUPERVISOR_COOKIE), context.event.slug, context.now.getTime());
  if (!grant || grant.eventId !== context.event.id || grant.hostParticipantId !== context.event.host_participant_id) return null;
  const host = await validHostSession(context, hashSessionToken(grant.hostToken));
  if (!host || operatorCodeDigest(host.operator_code_hash) !== grant.codeDigest) return null;
  return { grant, host };
}
async function selectedParticipant(context: Context, request: Request) {
  const hash = getRequestTokenHash(request);
  if (!hash) return null;
  return (await context.client.query<{ participant_id: string }>(`SELECT participant_id FROM sessions
    WHERE event_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>$3`,
  [context.event.id, hash, context.now])).rows[0]?.participant_id ?? null;
}
function state(context: Context, selectedId: string | null, enabled: boolean, canEnable: boolean, expiresAt: number | null): RehearsalState {
  return { ok: true, enabled, canEnable, selectedParticipantId: selectedId, hostParticipantId: context.event.host_participant_id!,
    eventPhase: context.event.phase,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    roster: context.roster.map(person => ({ participantId: person.id, displayName: person.display_name, role: person.role })) };
}

export async function rehearsalState(request: Request, slug: string) {
  return transaction(slug, async context => {
    const supervisor = await validateGrant(context, request);
    const selected = await selectedParticipant(context, request);
    const host = await validHostSession(context, getRequestTokenHash(request));
    return state(context, selected, !!supervisor, !!host, supervisor?.grant.expiresAt ?? null);
  });
}

async function enable(request: Request, slug: string, code: string) {
  // Authenticate through the normal login services, even when an old selected
  // actor cookie remains after the supervisor session expires.
  const target = await transaction(slug, async context => ({ hostId: context.event.host_participant_id!, phase: context.event.phase }));
  const hostId = target.hostId;
  const ip = process.env.VERCEL === "1" ? (request.headers.get("x-vercel-forwarded-for") ?? "unknown") : "local";
  const ipHash = hashSessionToken(`ip:${ip.split(",")[0].trim()}`);
  if (target.phase === "ENDED") return enableEnded(request, slug, code, ipHash);
  const session = await bootstrapSession({ slug, ipHash });
  if (!session.token) reject(401, "UNAUTHENTICATED");
  const token = session.token;
  const authenticated = await authenticateOperator({ slug, tokenHash: hashSessionToken(token), requestId: randomUUID() }, { participantId: hostId, code });
  if (!authenticated.ok) throw new CommandRejected(authenticated.status, authenticated.code);
  return transaction(slug, async context => {
    const host = await validHostSession(context, hashSessionToken(token));
    if (!host) reject(401, "UNAUTHENTICATED");
    await context.client.query("UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND token_hash=$2 AND id<>$4 AND revoked_at IS NULL",
      [context.event.id, getRequestTokenHash(request), context.now, host.id]);
    return enabledResponse(context, host, token);
  });
}

function enabledResponse(context: Context, host: HostSession, token: string) {
  const expiresAt = Math.min(host.expires_at.getTime(), context.now.getTime() + SUPERVISOR_MAX_AGE_SECONDS * 1000);
  const grant: SupervisorGrant = { version: 1, slug: context.event.slug, eventId: context.event.id,
    hostParticipantId: context.event.host_participant_id!, hostToken: token,
    codeDigest: operatorCodeDigest(host.operator_code_hash), expiresAt };
  const maxAge = (expiresAt - context.now.getTime()) / 1000;
  const headers = new Headers();
  headers.append("Set-Cookie", supervisorCookieHeader(signSupervisorGrant(grant), maxAge));
  headers.append("Set-Cookie", sessionCookieHeader(token, maxAge));
  return json(state(context, grant.hostParticipantId, true, true, expiresAt), 200, headers);
}

/** Re-enter only the guarded synthetic fixture after its ordinary event has ended. */
async function enableEnded(request: Request, slug: string, code: string, ipHash: string) {
  return transaction(slug, async context => {
    const { client, event, now } = context;
    if (event.phase !== "ENDED") reject(409, "WRONG_PHASE");
    await consumeRateLimit(client, event.id, `rehearsal-ended-ip:${ipHash}`, 5, 300, now);
    await consumeRateLimit(client, event.id, `rehearsal-ended-host:${event.host_participant_id}`, 30, 300, now);
    const person = (await client.query<{ operator_code_hash: string }>(
      "SELECT operator_code_hash FROM participants WHERE id=$1 AND event_id=$2 AND active AND role='operator' FOR UPDATE",
      [event.host_participant_id, event.id])).rows[0];
    if (!person || !await verifyOperatorCode(code, person.operator_code_hash)) reject(401, "BAD_CODE", true);
    const token = createSessionToken();
    await client.query(`UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND revoked_at IS NULL
      AND (participant_id=$2 OR token_hash=$4)`, [event.id, event.host_participant_id, now, getRequestTokenHash(request)]);
    await client.query("INSERT INTO sessions(event_id,participant_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
      [event.id, event.host_participant_id, hashSessionToken(token), new Date(now.getTime() + SUPERVISOR_MAX_AGE_SECONDS * 1000)]);
    const host = await validHostSession(context, hashSessionToken(token));
    if (!host) reject(401, "UNAUTHENTICATED");
    return enabledResponse(context, host, token);
  });
}

async function switchParticipant(context: Context, request: Request, host: HostSession, grant: SupervisorGrant, participantId: string) {
  const person = context.roster.find(person => person.id === participantId);
  if (!person) reject(404, "NOT_FOUND");
  // Only the original host session survives a role change.
  await context.client.query("UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND token_hash=$2 AND id<>$4 AND revoked_at IS NULL",
    [context.event.id, getRequestTokenHash(request), context.now, host.id]);
  let token = grant.hostToken;
  if (person.id !== grant.hostParticipantId) {
    token = createSessionToken();
    await context.client.query("UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND participant_id=$2 AND revoked_at IS NULL", [context.event.id, person.id, context.now]);
    await context.client.query("INSERT INTO sessions(event_id,participant_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
      [context.event.id, person.id, hashSessionToken(token), new Date(grant.expiresAt)]);
  }
  return json(state(context, person.id, true, person.id === grant.hostParticipantId, grant.expiresAt), 200,
    { "Set-Cookie": sessionCookieHeader(token, (grant.expiresAt - context.now.getTime()) / 1000) });
}

async function quickStart(context: Context, host: HostSession) {
  if (context.event.phase === "BLOCK") return;
  if (context.event.phase !== "SETUP") reject(409, "WRONG_PHASE");
  const ctx: TxContext = { ...context, session: host };
  async function command(name: string) {
    await executeAdminCommand(ctx, { command: name, expectedVersion: ctx.event.session_version });
    ctx.event = (await ctx.client.query<EventRow>("SELECT * FROM events WHERE id=$1", [ctx.event.id])).rows[0];
  }
  if (!ctx.event.teams_published_at) {
    if (!Array.isArray(ctx.event.draft_assignments)) await command("assign-teams");
    await command("publish-teams");
  }
  await command("start-game1");
  context.event = ctx.event;
}

/** Calls only ordinary game commands; never selects guesses using private answers. */
async function assist(context: Context, host: HostSession, selectedId: string) {
  const { client, event, now } = context;
  if (event.phase !== "BLOCK") return 0;
  const ctx: TxContext = { client, event, now, session: host };
  await settleDeadlines(ctx);
  const game = (await client.query<{ id: string; phase: string; game_version: number; ensemble_sharer_id: string | null }>(`SELECT g.id,g.phase,g.game_version,g.ensemble_sharer_id
    FROM block_assignments a JOIN team_blocks tb ON tb.event_id=a.event_id AND tb.team_id=a.team_id AND tb.block_no=a.block_no
    JOIN games g ON g.id=tb.current_game_id
    WHERE a.event_id=$1 AND a.participant_id=$2 AND a.block_no=$3 AND tb.paused_at IS NULL AND g.phase<>'REVEALED'`,
  [event.id, selectedId, event.current_block])).rows[0];
  if (!game) return 0;
  const members = (await client.query<RehearsalPerson>(`SELECT p.id,p.display_name,p.role,p.roster_order,p.active FROM game_members m
    JOIN participants p ON p.id=m.participant_id WHERE m.game_id=$1 ORDER BY p.roster_order`, [game.id])).rows;
  const others = members.filter(person => person.id !== selectedId);
  let completed = 0;
  // All actors remain inside the fixed, checked synthetic roster. The existing
  // command validates membership and current stage again within this transaction.
  async function asActor(person: RehearsalPerson, command: string, args: Record<string, unknown>) {
    const actorContext: TxContext = { ...ctx, session: { ...host, participant_id: person.id, role: person.role, display_name: person.display_name } };
    await executeGameCommand(actorContext, command, { gameId: game.id, gameVersion: game.game_version, ...args });
    completed++;
  }
  for (const person of others) {
    const pending = (await client.query<{ kind: string }>(`SELECT kind FROM (
      SELECT 'noise'::text AS kind WHERE (SELECT count(*) FROM data_cards WHERE game_id=$1)>=3
        AND EXISTS(SELECT 1 FROM data_cards WHERE game_id=$1 AND is_noise)
      UNION ALL SELECT 'ensemble' WHERE EXISTS(SELECT 1 FROM games WHERE id=$1 AND (ensemble_done OR phase LIKE 'ENSEMBLE_%'))
      UNION ALL SELECT 'ground_truth' WHERE EXISTS(SELECT 1 FROM games WHERE id=$1 AND gt_status='announced')
      ) applicable WHERE NOT EXISTS(SELECT 1 FROM game_overlay_seen o WHERE o.game_id=$1 AND o.participant_id=$2 AND o.kind=applicable.kind)`,
    [game.id, person.id])).rows;
    for (const overlay of pending) await asActor(person, "intro-ack", { introKey: overlay.kind });
  }
  const sharer = others.find(person => person.id === game.ensemble_sharer_id);
  if (game.phase === "ENSEMBLE_SHARE" && sharer) {
    await asActor(sharer, "ensemble-shared", {});
    // One click performs one stage. It does not also manufacture votes.
  } else if (game.phase === "ENSEMBLE_VOTE") {
    const voted = new Set((await client.query<{ voter_id: string }>("SELECT voter_id FROM ensemble_votes WHERE game_id=$1", [game.id])).rows.map(row => row.voter_id));
    for (const person of others) {
      if (!voted.has(person.id)) {
        const pick = members[person.roster_order % members.length];
        await asActor(person, "ensemble-vote", { pickId: pick.id, revision: 0 });
      }
    }
  } else if (game.phase === "ENSEMBLE_DISCUSS" && sharer) await asActor(sharer, "ensemble-end-discussion", {});
  await settleBlocks(ctx);
  return completed;
}

export async function rehearsalCommand(request: Request, input: unknown) {
  const command = commandSchema.parse(input);
  assertRehearsalDeployment(command.slug);
  if (command.action === "enable") return enable(request, command.slug, command.code);
  return transaction(command.slug, async context => {
    const supervisor = await validateGrant(context, request);
    if (!supervisor) reject(401, "UNAUTHENTICATED");
    const { host, grant } = supervisor;
    const selected = await selectedParticipant(context, request);
    if (command.action === "disable") {
      await context.client.query("UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND revoked_at IS NULL AND (id=$2 OR token_hash=$4)",
        [context.event.id, host.id, context.now, getRequestTokenHash(request)]);
      const headers = new Headers();
      headers.append("Set-Cookie", supervisorCookieHeader("", 0)); headers.append("Set-Cookie", clearSessionCookieHeader());
      return json(state(context, null, false, false, null), 200, headers);
    }
    if (command.action === "switch") {
      return switchParticipant(context, request, host, grant, command.participantId);
    }
    if (command.action === "reset") {
      context.event = await restartSyntheticRehearsal(context.client, { slug: command.slug, preserveSessionId: host.id });
      return switchParticipant(context, request, host, grant, grant.hostParticipantId);
    }
    if (command.action === "start") {
      await quickStart(context, host);
      return switchParticipant(context, request, host, grant, grant.hostParticipantId);
    }
    if (command.action === "focus-turn") {
      if (!selected) reject(401, "UNAUTHENTICATED");
      const turn = (await context.client.query<{ participant_id: string | null }>(`SELECT
        CASE WHEN g.phase IN ('ENSEMBLE_SHARE','ENSEMBLE_DISCUSS') THEN g.ensemble_sharer_id ELSE g.turn_lead_participant_id END AS participant_id
        FROM block_assignments a JOIN team_blocks tb ON tb.event_id=a.event_id AND tb.team_id=a.team_id AND tb.block_no=a.block_no
        JOIN games g ON g.id=tb.current_game_id WHERE a.event_id=$1 AND a.participant_id=$2 AND a.block_no=$3
        AND g.phase<>'REVEALED'`, [context.event.id, selected, context.event.current_block])).rows[0];
      if (!turn?.participant_id) reject(409, "WRONG_PHASE");
      return switchParticipant(context, request, host, grant, turn.participant_id);
    }
    if (!selected) reject(401, "UNAUTHENTICATED");
    const assistedActions = await assist(context, host, selected);
    return json({ ...state(context, selected, true, selected === grant.hostParticipantId, grant.expiresAt), assistedActions });
  });
}
