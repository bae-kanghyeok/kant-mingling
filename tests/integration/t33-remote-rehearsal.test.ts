import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/rehearsal/route";
import { apiHandler } from "@/server/http/handlers";
import { getState } from "@/server/dto/state-dto";
import { getPool, closePool } from "@/server/db/pool";
import { hashSessionToken } from "@/server/auth/session";
import { DEFAULT_TEAM_SETTINGS } from "@/server/game/settings";
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
  expect(Object.keys(initial).sort()).toEqual(["canEnable", "enabled", "expiresAt", "hostParticipantId", "ok", "roster", "selectedParticipantId"].sort());
  expect((await command({ action: "switch", participantId: randomUUID() })).status).toBe(404);
  await command({ action: "switch", participantId: event.students[0] });
  const studentToken = cookies.get("km_session")!;
  const student = await getState(event.slug, hashSessionToken(studentToken));
  expect(student.me).toMatchObject({ participantId: event.students[0], role: "student", isHost: false }); expect(student.admin).toBeUndefined();
  const adminResponse = await apiHandler("admin")(request({ command: "assign-teams", expectedVersion: student.versions.session, requestId: randomUUID() }));
  expect(adminResponse.status).toBe(403);
  await command({ action: "switch", participantId: event.operators[0] });
  await expect(getState(event.slug, hashSessionToken(studentToken))).rejects.toMatchObject({ status: 401 });
  expect((await getState(event.slug, hashSessionToken(cookies.get("km_session")!))).me?.isHost).toBe(true);
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
  const student = await createTestSession(event, event.students[0]); cookies.set("km_session", student.token);
  await enable();
  await command({ action: "switch", participantId: event.students[1] });
  const selectedToken = cookies.get("km_session")!; const supervisor = cookies.get("km_rehearsal")!;
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
    const current = await getState(event.slug, hashSessionToken(cookies.get("km_session")!));
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
