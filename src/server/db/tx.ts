import "server-only";
import { createHash } from "node:crypto";
import { getPool } from "./pool";
import { CommandRejected, reject } from "../http/respond";
import type { EventRow, SessionRow, TxContext } from "./types";
export type { TxContext } from "./types";
export interface CommandRequest {
  slug: string; tokenHash: string; command: string; requestId?: string;
  payload: unknown; receipt?: boolean;
}
export type CommandResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
const sharedCommands = new Set(["claim", "release", "profile-save", "profile-submit", "intro-ack", "ensemble-vote", "sync"]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export async function settleDeadlines(ctx: Pick<TxContext, "client" | "event" | "now">) {
  await ctx.client.query(`UPDATE games g SET phase='ENSEMBLE_DISCUSS',game_version=g.game_version+1
    FROM team_blocks tb WHERE g.team_block_id=tb.id AND g.event_id=$1
    AND g.phase='ENSEMBLE_VOTE' AND g.vote_deadline <= $2 AND tb.paused_at IS NULL`, [ctx.event.id, ctx.now]);
}

/** No application round trip occurs while this statement holds the event lock. */
async function settleAfterSharedCommand(eventId: string) {
  const query = { text: `WITH e AS MATERIALIZED (
      SELECT id FROM events WHERE id=$1 FOR UPDATE
    ) UPDATE games g SET phase='ENSEMBLE_DISCUSS',game_version=g.game_version+1
    FROM team_blocks tb,e WHERE g.event_id=e.id AND g.team_block_id=tb.id
      AND g.phase='ENSEMBLE_VOTE' AND g.vote_deadline<=clock_timestamp() AND tb.paused_at IS NULL`,
  values: [eventId], query_timeout: 8000 };
  try { await getPool().query(query); }
  catch { throw new CommandRejected(503, "DB_UNAVAILABLE"); }
}

export async function runCommand<T>(req: CommandRequest, execute: (ctx: TxContext) => Promise<T>): Promise<CommandResult<T>> {
  const client = await getPool().connect();
  const shared = sharedCommands.has(req.command);
  let begun = false;
  let committed = false;
  let ctx: TxContext | undefined;
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '8s'"); begun = true;
    const event = (await client.query<EventRow>(`SELECT * FROM events WHERE slug=$1 FOR ${shared ? "SHARE" : "UPDATE"}`, [req.slug])).rows[0];
    if (!event) reject(404, "NOT_FOUND");
    // Re-read after acquiring the event lock: unlock/host transfer may have committed while waiting.
    // Shared commands serialize one actor before reading its identity, including
    // profile saves racing registration release. Other actors remain concurrent.
    const sessionResult = (await client.query<SessionRow & { server_now: Date; deadline_settlement_needed: boolean }>(`SELECT
      s.id,s.event_id,s.participant_id,s.expires_at,s.revoked_at,p.role,p.display_name,clock_timestamp() AS server_now,
      $3::boolean AND EXISTS(SELECT 1 FROM games g JOIN team_blocks tb ON tb.id=g.team_block_id
        WHERE g.event_id=$2 AND g.phase='ENSEMBLE_VOTE' AND g.vote_deadline<=clock_timestamp() AND tb.paused_at IS NULL) AS deadline_settlement_needed
      FROM sessions s LEFT JOIN participants p ON p.id=s.participant_id
      WHERE s.token_hash=$1 AND s.event_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (s.participant_id IS NULL OR (p.active=true AND p.event_id=s.event_id))
      ${shared ? "FOR UPDATE OF s" : ""}`, [req.tokenHash,event.id,shared])).rows[0];
    if (!sessionResult) reject(401, "UNAUTHENTICATED");
    const { server_now: now, deadline_settlement_needed, ...session } = sessionResult;
    ctx = { client, event, session, now, deadlineSettlementNeeded: shared && deadline_settlement_needed };
    if (!shared) await settleDeadlines(ctx);
    const hash = createHash("sha256").update(canonical({ command: req.command, payload: req.payload })).digest("hex");
    if (req.receipt && req.requestId) {
      const prior = (await client.query<{ payload_hash: string; result_json: T }>(`SELECT payload_hash,result_json FROM command_receipts
        WHERE event_id=$1 AND actor_session_id=$2 AND request_id=$3`, [event.id,session.id,req.requestId])).rows[0];
      if (prior) {
        await client.query("COMMIT"); begun = false; committed = true;
        if (prior.payload_hash !== hash) return { ok: false, status: 409, code: "REQUEST_ID_REUSED" };
        return { ok: true, data: prior.result_json };
      }
    }
    await client.query("SAVEPOINT cmd");
    let result: CommandResult<T>;
    try {
      const data = await execute(ctx);
      if (req.receipt && req.requestId) await client.query(`INSERT INTO command_receipts
        (event_id,actor_session_id,request_id,command,payload_hash,result_json) VALUES($1,$2,$3,$4,$5,$6)`,
        [event.id,session.id,req.requestId,req.command,hash,JSON.stringify(data ?? {})]);
      result = { ok: true, data };
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      if (!error.preserveWrites) await client.query("ROLLBACK TO SAVEPOINT cmd");
      result = { ok: false, status: error.status, code: error.code };
    }
    await client.query("COMMIT"); begun = false; committed = true;
    return result;
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof CommandRejected) return { ok: false, status: error.status, code: error.code };
    throw new CommandRejected(503, "DB_UNAVAILABLE");
  } finally {
    client.release();
    // Also runs after a rejected command whose SAVEPOINT was rolled back. The
    // shared transaction has ended, so there is no SHARE -> UPDATE lock upgrade.
    if (shared && committed && ctx?.deadlineSettlementNeeded) await settleAfterSharedCommand(ctx.event.id);
  }
}
