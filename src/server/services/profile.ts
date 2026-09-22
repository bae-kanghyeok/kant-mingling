import "server-only";
import { runCommand } from "../db/tx";
import { reject } from "../http/respond";
import type { SessionRequest } from "./registration";

export function saveProfileAnswer(request: SessionRequest, input: { questionId: string; option: "A" | "B"; revision: number }) {
  return runCommand({ ...request, command: "profile-save", payload: input, receipt: false }, async ({ client, session, event, now }) => {
    if (event.phase === "ENDED") reject(410, "ENDED");
    if (!session.participant_id) reject(401, "UNAUTHENTICATED");
    if (!/^Q(0[1-9]|1[0-9]|20)$/.test(input.questionId) || !["A", "B"].includes(input.option) || !Number.isInteger(input.revision) || input.revision < 0) reject(422, "INVALID_REQUEST");
    const participant = await client.query<{ profile_locked_at: Date | null }>(
      "SELECT profile_locked_at FROM participants WHERE id = $1 AND event_id = $2 FOR UPDATE", [session.participant_id, event.id],
    );
    if (!participant.rows[0]) reject(401, "UNAUTHENTICATED");
    if (participant.rows[0].profile_locked_at) reject(409, "PROFILE_LOCKED");
    const previous = await client.query<{ option: "A" | "B"; revision: number }>(
      "SELECT option, revision FROM profile_answers WHERE participant_id = $1 AND question_id = $2 FOR UPDATE", [session.participant_id, input.questionId],
    );
    const answer = previous.rows[0];
    if (answer && answer.revision === input.revision + 1 && answer.option === input.option) return { revision: answer.revision };
    if ((answer?.revision ?? 0) !== input.revision) reject(409, "STALE_REVISION");
    const revision = input.revision + 1;
    await client.query(`INSERT INTO profile_answers(event_id, participant_id, question_id, option, revision, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (participant_id, question_id) DO UPDATE
      SET option = EXCLUDED.option, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`,
    [event.id, session.participant_id, input.questionId, input.option, revision, now]);
    return { revision };
  });
}

export function submitProfile(request: SessionRequest) {
  return runCommand({ ...request, command: "profile-submit", payload: {}, receipt: true }, async ({ client, session, event, now }) => {
    if (event.phase === "ENDED") reject(410, "ENDED");
    if (!session.participant_id) reject(401, "UNAUTHENTICATED");
    const participant = await client.query<{ profile_locked_at: Date | null; profile_completed_at: Date | null }>(
      "SELECT profile_locked_at, profile_completed_at FROM participants WHERE id = $1 AND event_id = $2 FOR UPDATE", [session.participant_id, event.id],
    );
    if (!participant.rows[0]) reject(401, "UNAUTHENTICATED");
    if (participant.rows[0].profile_completed_at) return {};
    if (participant.rows[0].profile_locked_at) reject(409, "PROFILE_LOCKED");
    const answers = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM profile_answers WHERE participant_id = $1 AND event_id = $2", [session.participant_id, event.id],
    );
    if (answers.rows[0].count !== 20) reject(422, "INCOMPLETE");
    await client.query(`UPDATE participants SET profile_completed_at = $1,
      profile_locked_at = CASE WHEN $2 <> 'SETUP' THEN $1 ELSE profile_locked_at END
      WHERE id = $3`, [now, event.phase, session.participant_id]);
    return {};
  });
}
