import { developmentConnectionString } from "../db/database-target.mjs";

// Kept in the shared server/CLI helper so both reset paths create the same fixture.
// The integration test checks this against the ordinary game's default settings.
export const SYNTHETIC_REHEARSAL_CONFIG = {
  studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
  operatorTeamByName: { "운영진A": "A", "운영진B": "B", "운영진C": "C" },
  blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24,
  presenceWindowSeconds: 15, pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30,
};

export function isSyntheticRehearsalRoster(people) {
  if (people.length !== 21) return false;
  return [...people].sort((a, b) => a.roster_order - b.roster_order).every((person, index) => {
    const student = index < 18;
    return person.active && person.roster_order === index + 1 &&
      person.display_name === (student ? `학생${String(index + 1).padStart(2, "0")}` : `운영진${"ABC"[index - 18]}`) &&
      person.role === (student ? "student" : "operator");
  });
}

/** Caller must own a transaction. Never deletes the event, identities or codes.
 * @param {import("pg").PoolClient | import("pg").Client} client
 * @param {{slug: string, preserveSessionId?: string | null}} options
 */
export async function restartSyntheticRehearsal(client, { slug, preserveSessionId = null }) {
  if (process.env.REHEARSAL_ENABLED !== "true" || process.env.VERCEL_ENV === "production" ||
      (process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "preview") ||
      !/^dev-[a-z0-9][a-z0-9-]{0,74}$/.test(slug) || process.env.REHEARSAL_EVENT_SLUG !== slug) {
    throw new Error("Only the explicitly configured synthetic rehearsal can be restarted.");
  }
  developmentConnectionString();
  const marker = await client.query("SELECT name FROM public.app_environment WHERE singleton=true");
  if (marker.rows[0]?.name !== "development") throw new Error("Development marker required.");
  const event = (await client.query("SELECT * FROM events WHERE slug=$1 FOR UPDATE", [slug])).rows[0];
  if (!event) throw new Error("Synthetic rehearsal not found.");
  const roster = (await client.query("SELECT id,display_name,role,roster_order,active FROM participants WHERE event_id=$1 ORDER BY roster_order", [event.id])).rows;
  if (!isSyntheticRehearsalRoster(roster) || !roster.some(person => person.id === event.host_participant_id && person.role === "operator")) {
    throw new Error("Exact synthetic identities and a current host are required.");
  }
  if (preserveSessionId && !(await client.query(`SELECT 1 FROM sessions WHERE id=$1 AND event_id=$2
      AND participant_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
  [preserveSessionId, event.id, event.host_participant_id])).rowCount) throw new Error("A valid host session is required.");
  // Explicit ordering breaks the two cross-cascade references before removing games.
  await client.query("DELETE FROM ground_truths WHERE game_id IN (SELECT id FROM games WHERE event_id=$1)", [event.id]);
  await client.query("UPDATE team_blocks SET current_game_id=NULL WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM games WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM team_blocks WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM teams WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM pair_history WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM intro_seen WHERE participant_id IN (SELECT id FROM participants WHERE event_id=$1)", [event.id]);
  await client.query("DELETE FROM command_receipts WHERE event_id=$1", [event.id]);
  await client.query("DELETE FROM operation_logs WHERE event_id=$1", [event.id]);
  // Auth rate limits deliberately survive a reset; resetting cannot erase throttling.
  await client.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE event_id=$1 AND id IS DISTINCT FROM $2::uuid AND revoked_at IS NULL", [event.id, preserveSessionId]);
  await client.query("DELETE FROM profile_answers WHERE event_id=$1", [event.id]);
  await client.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(n::text,2,'0'),CASE WHEN (p.roster_order*7+n*3+(p.roster_order*n)%5)%11<6 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) n WHERE p.event_id=$1`, [event.id]);
  await client.query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp(),profile_locked_at=NULL,owner_count=0 WHERE event_id=$1", [event.id]);
  const restored = await client.query(`UPDATE events SET phase='SETUP',current_block=0,config_json=$2,
    session_version=session_version+1,teams_published_at=NULL,next_block_plan=NULL,started_at=NULL,ended_at=NULL,
    pending_config_json=NULL,pending_roster_json=NULL,draft_assignments=NULL WHERE id=$1 RETURNING *`,
  [event.id, JSON.stringify(SYNTHETIC_REHEARSAL_CONFIG)]);
  await client.query("INSERT INTO operation_logs(event_id,command) VALUES($1,'restart-synthetic-rehearsal')", [event.id]);
  return restored.rows[0];
}
