import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { closePool } from "@/server/db/pool";
import { apiHandler } from "@/server/http/handlers";
import { sessionCookieName } from "@/server/auth/session";
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent } from "./helpers";

const events: TestEvent[] = [];
afterEach(async () => { for (const event of events.splice(0)) await cleanupTestEvent(event); });
afterAll(closePool);

async function fixture() {
  const event = await createTestEvent({ studentCount: 3, teamCount: 1, moveCountPerTeam: 0 });
  events.push(event); return event;
}
function browser() {
  const cookies = new Map<string, string>();
  return { cookies, async call(event: TestEvent, action: string, body: Record<string, unknown> = {}) {
    const url = `https://example.test/api/${action}?slug=${event.slug}`;
    const response = await apiHandler(action)(new Request(url, {
      method: action === "state" ? "GET" : "POST",
      headers: { origin: "https://example.test", "Content-Type": "application/json", cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
      ...(action === "state" ? {} : { body: JSON.stringify({ slug: event.slug, requestId: randomUUID(), ...body }) }),
    }));
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0], split = pair.indexOf("=");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { status: response.status, body: await response.json() };
  } };
}

it("T37 one browser can register at A, visit B, and return to its original A profile without NAME_LOCKED", async () => {
  const a = await fixture(), b = await fixture(), client = browser();
  expect((await client.call(a, "bootstrap")).status).toBe(200);
  expect((await client.call(a, "claim", { participantId: a.students[0] })).status).toBe(200);
  expect((await client.call(a, "profile", { questionId: "Q01", option: "A", revision: 0 })).status).toBe(200);
  const before = await client.call(a, "state");
  expect(before.body.me.participantId).toBe(a.students[0]);
  expect((await client.call(b, "bootstrap")).status).toBe(200);
  expect((await client.call(b, "claim", { participantId: b.students[0] })).status).toBe(200);
  const bView = await client.call(b, "state");
  expect(bView.body.me.participantId).toBe(b.students[0]);
  expect((await client.call(a, "bootstrap")).status).toBe(200);
  const recovered = await client.call(a, "state");
  expect(recovered.status).toBe(200);
  expect(recovered.body.me.participantId).toBe(a.students[0]);
  expect(JSON.stringify(recovered.body.profile) === JSON.stringify(before.body.profile)).toBe(true);
  expect(client.cookies.has(sessionCookieName(a.slug))).toBe(true);
  expect(client.cookies.has(sessionCookieName(b.slug))).toBe(true);
  expect((await client.call(b, "state")).body.me.participantId).toBe(b.students[0]);
});

it("T37 an existing legacy session survives visiting another event after the deployment", async () => {
  const a = await fixture(), b = await fixture(), client = browser();
  const legacy = await createTestSession(a, a.students[0]);
  client.cookies.set("km_session", legacy.token);
  expect((await client.call(a, "bootstrap")).status).toBe(200);
  expect((await client.call(b, "bootstrap")).status).toBe(200);
  expect((await client.call(b, "claim", { participantId: b.students[0] })).status).toBe(200);
  expect((await client.call(a, "state")).body.me.participantId).toBe(a.students[0]);
  expect((await client.call(b, "state")).body.me.participantId).toBe(b.students[0]);
  expect(client.cookies.get("km_session") === legacy.token).toBe(true);
});
