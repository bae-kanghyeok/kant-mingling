import "server-only";
import { getPool } from "../db/pool";
import { runCommand } from "../db/tx";
import { CommandRejected, reject } from "../http/respond";
import { createSessionToken, hashSessionToken } from "../auth/session";
import { verifyOperatorCode } from "../auth/operator-code";
import { consumeRateLimit } from "../auth/rate-limit";

export type SessionRequest = { slug: string; tokenHash: string; requestId?: string };

export async function bootstrapSession(input: { slug: string; tokenHash?: string | null; ipHash: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '8s'");
    const found = await client.query<{ id: string; phase: string; config_json: { sessionTtlHours?: number } }>(
      "SELECT id, phase, config_json FROM events WHERE slug = $1 FOR SHARE", [input.slug],
    );
    const event = found.rows[0];
    if (!event) reject(404, "NOT_FOUND");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
    const maxAgeSeconds = Math.floor((event.config_json.sessionTtlHours ?? 24) * 3600);
    if (input.tokenHash) {
      const current = await client.query<{ id: string; participant_id: string | null }>(
        `SELECT s.id,s.participant_id FROM sessions s LEFT JOIN participants p ON p.id = s.participant_id AND p.event_id = s.event_id
         WHERE s.event_id = $1 AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > $3
         AND (s.participant_id IS NULL OR p.active = true)`,
        [event.id, input.tokenHash, now],
      );
      if (current.rows[0]) {
        if (event.phase === "ENDED" && !current.rows[0].participant_id) reject(410, "ENDED");
        await client.query("COMMIT");
        return { sessionId: current.rows[0].id, maxAgeSeconds };
      }
    }
    if (event.phase === "ENDED") reject(410, "ENDED");
    await consumeRateLimit(client, event.id, `bootstrap:${input.ipHash}`, 30, 60, now);
    const token = createSessionToken();
    const created = await client.query<{ id: string }>(
      "INSERT INTO sessions(event_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id",
      [event.id, hashSessionToken(token), new Date(now.getTime() + maxAgeSeconds * 1000)],
    );
    await client.query("COMMIT");
    return { token, sessionId: created.rows[0].id, maxAgeSeconds };
  } catch (error) {
    if (error instanceof CommandRejected && error.preserveWrites) await client.query("COMMIT");
    else await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function claimParticipant(request: SessionRequest, participantId: string) {
  return runCommand({ ...request, command: "claim", payload: { participantId }, receipt: true }, async ({ client, session, event, now }) => {
    if (event.phase === "ENDED") reject(410, "ENDED");
    if (session.participant_id) reject(409, "ALREADY_CLAIMED");
    const found = await client.query<{ id: string; role: string }>(
      "SELECT id, role FROM participants WHERE id = $1 AND event_id = $2 AND active = true FOR UPDATE", [participantId, event.id],
    );
    const target = found.rows[0];
    if (!target) reject(404, "NOT_FOUND");
    if (target.role !== "student") reject(403, "OPERATOR_CODE_REQUIRED");
    // An expiring session may still be finishing a command with S -> P locks.
    // Skip its S lock here to avoid a P -> S cycle; NAME_LOCKED permits a retry.
    await client.query(`WITH expired AS (
      SELECT id FROM sessions WHERE participant_id=$2 AND revoked_at IS NULL AND expires_at<=$1::timestamptz
      FOR UPDATE SKIP LOCKED
    ) UPDATE sessions s SET revoked_at=$1::timestamptz FROM expired e WHERE s.id=e.id`, [now, participantId]);
    const active = await client.query("SELECT id FROM sessions WHERE participant_id = $1 AND revoked_at IS NULL", [participantId]);
    if (active.rowCount) reject(409, "NAME_LOCKED");
    await client.query("UPDATE sessions SET participant_id = $1 WHERE id = $2", [participantId, session.id]);
    await client.query("UPDATE participants SET attendance = 'present' WHERE id = $1", [participantId]);
    return {};
  });
}

export function authenticateOperator(request: SessionRequest, input: { participantId: string; code: string }) {
  return runCommand({ ...request, command: "operator", payload: input, receipt: true }, async ({ client, session, event, now }) => {
    if (event.phase === "ENDED") reject(410, "ENDED");
    if (session.participant_id && session.participant_id !== input.participantId) reject(409, "ALREADY_CLAIMED");
    await consumeRateLimit(client, event.id, `operator-session:${session.id}:${input.participantId}`, 5, 300, now);
    await consumeRateLimit(client, event.id, `operator-name:${input.participantId}`, 30, 300, now);
    const found = await client.query<{ id: string; role: string; operator_code_hash: string | null }>(
      "SELECT id, role, operator_code_hash FROM participants WHERE id = $1 AND event_id = $2 AND active = true FOR UPDATE", [input.participantId, event.id],
    );
    const target = found.rows[0];
    if (!target || target.role !== "operator" || !await verifyOperatorCode(input.code, target.operator_code_hash)) reject(401, "BAD_CODE", true);
    await client.query("UPDATE sessions SET revoked_at = $1 WHERE participant_id = $2 AND id <> $3 AND revoked_at IS NULL", [now, target.id, session.id]);
    await client.query("UPDATE sessions SET participant_id = $1 WHERE id = $2", [target.id, session.id]);
    await client.query("UPDATE participants SET attendance = 'present' WHERE id = $1", [target.id]);
    return {};
  });
}

export function releaseParticipant(request: SessionRequest) {
  return runCommand({ ...request, command: "release", payload: {}, receipt: true }, async ({ client, session, event }) => {
    if (event.phase === "ENDED") reject(410, "ENDED");
    if (!session.participant_id) return {};
    const participant = await client.query<{ profile_completed_at: Date | null; profile_locked_at: Date | null }>(
      "SELECT profile_completed_at, profile_locked_at FROM participants WHERE id = $1 AND event_id = $2 FOR UPDATE", [session.participant_id, event.id],
    );
    if (participant.rows[0]?.profile_completed_at || participant.rows[0]?.profile_locked_at) reject(409, "PROFILE_COMPLETE");
    await client.query("DELETE FROM profile_answers WHERE participant_id = $1", [session.participant_id]);
    await client.query("UPDATE participants SET attendance = 'unknown' WHERE id = $1", [session.participant_id]);
    await client.query("UPDATE sessions SET participant_id = NULL WHERE id = $1", [session.id]);
    return {};
  });
}
