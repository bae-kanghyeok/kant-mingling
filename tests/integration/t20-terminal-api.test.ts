import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool } from "@/server/db/pool";
import { POST as admin } from "@/app/api/admin/route";
import { GET as state } from "@/app/api/state/route";
import { POST as bootstrap } from "@/app/api/session/bootstrap/route";
import { POST as guess } from "@/app/api/game/guess/route";
import { sessionCookieHeader } from "@/server/auth/session";
import { getQuestion } from "@/content/catalog";
import { createTestEvent, cleanupTestEvent, createTestSession, type TestEvent, type TestSession } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);
function post(path: string, session: TestSession | null, body: Record<string, unknown> = {}) {
  return new Request(`https://example.test/api/${path}`, { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json",
    ...(session ? { cookie: sessionCookieHeader(session.token, 3600).split(";")[0] } : {}) }, body: JSON.stringify({ slug: event.slug, ...body }) });
}
function get(session: TestSession) {
  return new Request(`https://example.test/api/state?slug=${event.slug}`, { headers: { cookie: sessionCookieHeader(session.token, 3600).split(";")[0] } });
}

it("T20 actual routes deliver the final reveal only to a returning GAME member and reject further play or new entry", async () => {
  const fixture = await createVisibilityFixture(event);
  const host = fixture.byPerson.get(event.operators[0])!;
  const student = fixture.byPerson.get(event.students[4])!;
  const anonymous = await createTestSession(event);
  const end = await admin(post("admin", host, { requestId: randomUUID(), command: "end-session", expectedVersion: 0,
    args: { confirm: true, emergency: true, confirmEmergency: true } }));
  expect(end.status).toBe(200);
  const reconnect = await bootstrap(post("session/bootstrap", student));
  expect(reconnect.status).toBe(200);
  expect(reconnect.headers.get("set-cookie")).toBeNull();
  const response = await state(get(student));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  const terminal = await response.json();
  expect(terminal.event.phase).toBe("ENDED");
  expect(terminal.allowedActions).toEqual([]);
  expect(terminal).not.toHaveProperty("profile");
  expect(terminal).not.toHaveProperty("admin");
  expect(terminal.lastReveal.reveal.owner.participantId).toBe(event.students[1]);
  expect(terminal.lastReveal.reveal.endReason).toBe("session_end");
  expect(terminal.lastReveal.cards[0].text).toBe(getQuestion("Q01").options.A);
  expect(JSON.stringify(terminal)).not.toContain(getQuestion("Q04").options.A);
  expect((await bootstrap(post("session/bootstrap", null))).status).toBe(410);
  expect((await bootstrap(post("session/bootstrap", anonymous))).status).toBe(410);
  expect((await state(get(anonymous))).status).toBe(410);
  const blocked = await guess(post("game/guess", student, { requestId: randomUUID(), gameId: fixture.groups[0].game,
    gameVersion: 0, ownerPick: event.students[1], noisePicks: [2] }));
  expect(blocked.status).toBe(410);
}, 60000);
