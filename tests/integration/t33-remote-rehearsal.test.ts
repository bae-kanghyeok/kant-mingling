import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/rehearsal/route";
import { apiHandler } from "@/server/http/handlers";
import { getState } from "@/server/dto/state-dto";
import { getPool, closePool } from "@/server/db/pool";
import { hashSessionToken, sessionCookieName } from "@/server/auth/session";
import { DEFAULT_GLOBAL_CONFIG, DEFAULT_TEAM_SETTINGS } from "@/server/game/settings";
import { SYNTHETIC_REHEARSAL_CONFIG } from "@/server/rehearsal/reset-fixture.mjs";
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent } from "./helpers";

let event: TestEvent;
let originalSlug: string;
let cookies = new Map<string, string>();
const base = "http://localhost:3000";
function request(body?: Record<string, unknown>, origin = base) {
  return new Request(`${base}/api/rehearsal?slug=${event.slug}`, { method: body ? "POST" : "GET",
    headers: { origin, "sec-fetch-site": "same-origin", cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify({ slug: event.slug, ...body }) } : {}) });
}
function acceptCookies(response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]; const index = pair.indexOf("=");
    if (pair.slice(index + 1)) cookies.set(pair.slice(0, index), pair.slice(index + 1)); else cookies.delete(pair.slice(0, index));
  }
}
async function command(body: Record<string, unknown>) { const response = await POST(request(body)); if (response.ok) acceptCookies(response); return response; }
async function enable() {
  const response = await command({ action: "enable", code: event.operatorCodes[0] });
  expect(response.status).toBe(200); return response.json();
}
beforeEach(async () => {
  event = await createTestEvent(); originalSlug = event.slug; event.slug = `dev-${randomUUID()}`;
  await getPool().query("UPDATE events SET slug=$2 WHERE id=$1", [event.id, event.slug]);
  cookies = new Map();
  vi.stubEnv("REHEARSAL_ENABLED", "true"); vi.stubEnv("REHEARSAL_EVENT_SLUG", event.slug);
  vi.stubEnv("VERCEL", "0"); vi.stubEnv("VERCEL_ENV", "preview");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (event) { await getPool().query("UPDATE events SET slug=$2 WHERE id=$1", [event.id, originalSlug]); event.slug = originalSlug; await cleanupTestEvent(event); }
});
afterAll(closePool);

it("authenticates only the real host code; switches normal role permissions and revokes old actor sessions", async () => {
  const denied = await command({ action: "enable", code: event.operatorCodes[1] }); expect(denied.status).toBe(401);
  expect((await command({ action: "switch", participantId: event.students[0] })).status).toBe(401);
  const initial = await enable(); expect(initial).toMatchObject({ enabled: true, selectedParticipantId: event.operators[0] });
  expect(initial.roster).toHaveLength(21);
  expect(Object.keys(initial).sort()).toEqual(["canEnable", "enabled", "eventPhase", "expiresAt", "hostParticipantId", "ok", "roster", "selectedParticipantId"].sort());
  expect((await command({ action: "switch", participantId: randomUUID() })).status).toBe(404);
  await command({ action: "switch", participantId: event.students[0] });
  const studentToken = cookies.get(sessionCookieName(event.slug))!;
  const student = await getState(event.slug, hashSessionToken(studentToken));
  expect(student.me).toMatchObject({ participantId: event.students[0], role: "student", isHost: false }); expect(student.admin).toBeUndefined();
  const adminResponse = await apiHandler("admin")(request({ command: "assign-teams", expectedVersion: student.versions.session, requestId: randomUUID() }));
  expect(adminResponse.status).toBe(403);
  await command({ action: "switch", participantId: event.operators[0] });
  await expect(getState(event.slug, hashSessionToken(studentToken))).rejects.toMatchObject({ status: 401 });
  expect((await getState(event.slug, hashSessionToken(cookies.get(sessionCookieName(event.slug))!))).me?.isHost).toBe(true);
});

it("restarts only the authorized fixture and preserves identity, codes and the supervisor while clearing game progress", async () => {
  expect(SYNTHETIC_REHEARSAL_CONFIG).toEqual(DEFAULT_GLOBAL_CONFIG);
  expect((await command({ action: "reset", confirm: "RESET" })).status).toBe(401);
  const unrelated = await createTestEvent();
  try {
    const unrelatedBefore = await getPool().query("SELECT row_to_json(e)::text AS snapshot FROM events e WHERE id=$1", [unrelated.id]);
    const peopleBefore = (await getPool().query("SELECT id,operator_code_hash FROM participants WHERE event_id=$1 ORDER BY roster_order", [event.id])).rows;
    await enable();
    const originalHostToken = cookies.get(sessionCookieName(event.slug))!;
    expect((await command({ action: "reset" })).status).toBe(422);
    const prepared = await command({ action: "reset", confirm: "RESET" });
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ eventPhase: "SETUP", selectedParticipantId: event.operators[0], enabled: true });
    const start = await command({ action: "start" });
    expect(start.status).toBe(200); expect(await start.json()).toMatchObject({ eventPhase: "BLOCK" });
    const gameIds = (await getPool().query("SELECT id FROM games WHERE event_id=$1 ORDER BY id", [event.id])).rows;
    expect(gameIds).toHaveLength(3);
    expect((await command({ action: "start" })).status).toBe(200);
    expect((await getPool().query("SELECT id FROM games WHERE event_id=$1 ORDER BY id", [event.id])).rows).toEqual(gameIds);
    const focus = await command({ action: "focus-turn" });
    expect(focus.status).toBe(200);
    const focusBody = await focus.json();
    const turn = (await getPool().query(`SELECT g.turn_lead_participant_id FROM games g JOIN teams t ON t.id=g.team_id
      WHERE g.event_id=$1 AND t.team_key='A' AND g.game_no=1`, [event.id])).rows[0];
    expect(focusBody.selectedParticipantId).toBe(turn.turn_lead_participant_id);
    await command({ action: "switch", participantId: event.students[0] });
    const oldStudentToken = cookies.get(sessionCookieName(event.slug))!;
    await getPool().query("INSERT INTO intro_seen(participant_id,intro_key) VALUES($1,'tutorial') ON CONFLICT DO NOTHING", [event.students[0]]);
    await getPool().query(`INSERT INTO ground_truths(game_id,card_id) SELECT game_id,id FROM data_cards WHERE game_id=$1 LIMIT 1`, [gameIds[0].id]);
    const reset = await command({ action: "reset", confirm: "RESET" });
    expect(reset.status).toBe(200); expect(await reset.json()).toMatchObject({ eventPhase: "SETUP", selectedParticipantId: event.operators[0] });
    expect(cookies.get(sessionCookieName(event.slug)) === originalHostToken).toBe(true);
    expect((await GET(request())).status).toBe(200);
    await expect(getState(event.slug, hashSessionToken(oldStudentToken))).rejects.toMatchObject({ status: 401 });
    const summary = (await getPool().query(`SELECT
      (SELECT count(*) FROM games WHERE event_id=$1)::int AS games,
      (SELECT count(*) FROM teams WHERE event_id=$1)::int AS teams,
      (SELECT count(*) FROM block_assignments WHERE event_id=$1)::int AS assignments,
      (SELECT count(*) FROM pair_history WHERE event_id=$1)::int AS pairs,
      (SELECT count(*) FROM command_receipts WHERE event_id=$1)::int AS receipts,
      (SELECT count(*) FROM profile_answers WHERE event_id=$1)::int AS answers,
      (SELECT count(*) FROM participants WHERE event_id=$1 AND profile_completed_at IS NOT NULL AND profile_locked_at IS NULL AND owner_count=0)::int AS ready,
      (SELECT count(*) FROM intro_seen WHERE participant_id IN (SELECT id FROM participants WHERE event_id=$1))::int AS intros`, [event.id])).rows[0];
    expect(summary).toEqual({ games: 0, teams: 0, assignments: 0, pairs: 0, receipts: 0, answers: 420, ready: 21, intros: 0 });
    expect((await getPool().query("SELECT id,operator_code_hash FROM participants WHERE event_id=$1 ORDER BY roster_order", [event.id])).rows).toEqual(peopleBefore);
    expect((await getPool().query("SELECT row_to_json(e)::text AS snapshot FROM events e WHERE id=$1", [unrelated.id])).rows).toEqual(unrelatedBefore.rows);
    expect((await command({ action: "focus-turn" })).status).toBe(409);
    expect((await command({ action: "start" })).status).toBe(200);
  } finally { await cleanupTestEvent(unrelated); }
});

it("allows a rate-limited synthetic host to re-enter an ended rehearsal and reset, without reopening ordinary login", async () => {
  await getPool().query("UPDATE events SET phase='ENDED',ended_at=clock_timestamp() WHERE id=$1", [event.id]);
  const ordinary = await apiHandler("bootstrap")(request({}));
  expect(ordinary.status).toBe(410);
  expect((await command({ action: "enable", code: event.operatorCodes[1] })).status).toBe(401);
  const loggedIn = await enable(); expect(loggedIn.eventPhase).toBe("ENDED");
  expect((await command({ action: "start" })).status).toBe(409);
  expect((await command({ action: "reset", confirm: "RESET" })).status).toBe(200);
  expect((await command({ action: "disable" })).status).toBe(200);
  await getPool().query("UPDATE events SET phase='ENDED' WHERE id=$1", [event.id]);
  // The successful re-entry and reset did not erase authentication attempts.
  for (let index = 0; index < 3; index++) expect((await command({ action: "enable", code: "invalid" })).status).toBe(401);
  expect((await command({ action: "enable", code: event.operatorCodes[0] })).status).toBe(429);
});

it("rechecks host authority and synthetic identity and does not grant cross-origin mutations", async () => {
  await enable();
  expect((await POST(request({ action: "switch", participantId: event.students[0] }, "https://other.example"))).status).toBe(403);
  await getPool().query("UPDATE events SET host_participant_id=$2 WHERE id=$1", [event.id, event.operators[1]]);
  expect((await command({ action: "switch", participantId: event.students[0] })).status).toBe(401);
  await getPool().query("UPDATE participants SET display_name='Actual attendee' WHERE id=$1", [event.students[0]]);
  expect((await GET(request())).status).toBe(404);
});

it("can reauthenticate from a claimed student cookie and disable both current-role and supervisor access", async () => {
  const student = await createTestSession(event, event.students[0]); cookies.set(sessionCookieName(event.slug), student.token);
  await enable();
  await command({ action: "switch", participantId: event.students[1] });
  const selectedToken = cookies.get(sessionCookieName(event.slug))!; const supervisor = cookies.get("km_rehearsal")!;
  const stopped = await command({ action: "disable" }); expect(stopped.status).toBe(200); expect(cookies.size).toBe(0);
  await expect(getState(event.slug, hashSessionToken(selectedToken))).rejects.toMatchObject({ status: 401 });
  cookies.set("km_rehearsal", supervisor);
  expect((await command({ action: "switch", participantId: event.students[0] })).status).toBe(401);
});

it("assists only other members of the selected team, through real Ensemble and Ground Truth commands", async () => {
  await enable();
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT $1,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order+q)%3=0 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1`, [event.id]);
  await getPool().query("UPDATE participants SET profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  async function admin(name: string) {
    const current = await getState(event.slug, hashSessionToken(cookies.get(sessionCookieName(event.slug))!));
    const response = await apiHandler("admin")(request({ command: name, expectedVersion: current.versions.session, requestId: randomUUID() }));
    expect(response.status).toBe(200);
  }
  await admin("assign-teams"); await admin("publish-teams");
  await getPool().query("UPDATE teams SET settings_json=$2 WHERE event_id=$1", [event.id, JSON.stringify({ ...DEFAULT_TEAM_SETTINGS, ensembleTriggerOverride: 1 })]);
  await admin("start-game1");
  const game = (await getPool().query<{ id: string; ensemble_sharer_id: string; phase: string }>(`SELECT g.id,g.ensemble_sharer_id,g.phase FROM games g
    JOIN teams t ON t.id=g.team_id WHERE g.event_id=$1 AND t.team_key='A' AND g.game_no=1`, [event.id])).rows[0];
  expect(game.phase).toBe("ENSEMBLE_SHARE");
  const members = (await getPool().query<{ participant_id: string }>("SELECT participant_id FROM game_members WHERE game_id=$1 ORDER BY participant_id", [game.id])).rows;
  const selected = members.find(person => person.participant_id !== game.ensemble_sharer_id)!.participant_id;
  await command({ action: "switch", participantId: selected });
  const share = await command({ action: "assist" }); expect(share.status).toBe(200);
  const shareBody = await share.json(); expect(shareBody.assistedActions).toBeGreaterThan(0);
  expect(shareBody).not.toHaveProperty("game"); expect(shareBody).not.toHaveProperty("ownerParticipantId");
  expect((await getPool().query("SELECT phase FROM games WHERE id=$1", [game.id])).rows[0].phase).toBe("ENSEMBLE_VOTE");
  const others = (await getPool().query("SELECT phase FROM games WHERE event_id=$1 AND id<>$2", [event.id, game.id])).rows;
  expect(others.every(row => row.phase === "ENSEMBLE_SHARE")).toBe(true);
  expect((await getPool().query("SELECT * FROM ensemble_votes WHERE game_id=$1", [game.id])).rowCount).toBe(0);
  const vote = await command({ action: "assist" }); expect(vote.status).toBe(200);
  const ballots = (await getPool().query<{ voter_id: string }>("SELECT voter_id FROM ensemble_votes WHERE game_id=$1", [game.id])).rows;
  expect(ballots).toHaveLength(6); expect(ballots.some(row => row.voter_id === selected)).toBe(false);
  const repeat = await command({ action: "assist" }); expect((await repeat.json()).assistedActions).toBe(0);
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [game.id]);
  expect((await command({ action: "assist" })).status).toBe(200);
  expect((await getPool().query("SELECT phase FROM games WHERE id=$1", [game.id])).rows[0].phase).toBe("TURN");
  // A GT announcement fixture exercises the ordinary per-game acknowledgement
  // path without exposing or selecting the private owner in the helper API.
  await getPool().query("UPDATE games SET gt_status='announced' WHERE id=$1", [game.id]);
  expect((await command({ action: "assist" })).status).toBe(200);
  const acknowledgements = (await getPool().query<{ participant_id: string }>("SELECT participant_id FROM game_overlay_seen WHERE game_id=$1 AND kind='ground_truth'", [game.id])).rows;
  expect(acknowledgements).toHaveLength(6); expect(acknowledgements.some(row => row.participant_id === selected)).toBe(false);
});
