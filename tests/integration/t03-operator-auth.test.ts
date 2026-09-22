import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { authenticateOperator } from "@/server/services/registration";
import { saveProfileAnswer } from "@/server/services/profile";
import { getRequestTokenHash, sessionCookieHeader } from "@/server/auth/session";
import { createTestEvent, createTestSession, cleanupTestEvent, testRequest, type TestEvent } from "./helpers";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T03 failed codes keep counters, while a separate session with the valid code can enter", async () => {
  const bad = await createTestSession(event);
  for (let index = 0; index < 5; index++) {
    expect(await authenticateOperator(testRequest(event, bad), { participantId: event.operators[0], code: "incorrect" }))
      .toEqual({ ok: false, status: 401, code: "BAD_CODE" });
  }
  expect(await authenticateOperator(testRequest(event, bad), { participantId: event.operators[0], code: event.operatorCodes[0] }))
    .toEqual({ ok: false, status: 429, code: "RATE_LIMITED" });
  const good = await createTestSession(event);
  const input = { participantId: event.operators[0], code: event.operatorCodes[0] };
  const request = testRequest(event, good);
  expect((await authenticateOperator(request, input)).ok).toBe(true);
  expect((await authenticateOperator(request, input)).ok).toBe(true);
  const receipt = (await getPool().query("SELECT * FROM command_receipts WHERE actor_session_id=$1", [good.id])).rows;
  expect(receipt).toHaveLength(1);
  expect(JSON.stringify(receipt)).not.toContain(input.code);
  expect((await saveProfileAnswer(testRequest(event, good), { questionId: "Q01", option: "A", revision: 0 })).ok).toBe(true);
});

it("T03 operator recovery rotates the old session and cookie parsing uses only an opaque token", async () => {
  const old = await createTestSession(event, event.operators[0]);
  const next = await createTestSession(event);
  expect((await authenticateOperator(testRequest(event, next), { participantId: event.operators[0], code: event.operatorCodes[0] })).ok).toBe(true);
  expect(await saveProfileAnswer(testRequest(event, old), { questionId: "Q01", option: "A", revision: 0 }))
    .toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  const header = sessionCookieHeader(next.token, 3600);
  expect(header).toContain("HttpOnly; SameSite=Lax");
  expect(header).not.toContain(event.operators[0]);
  expect(getRequestTokenHash(new Request("https://example.test", { headers: { cookie: header.split(";")[0] } }))).toBe(next.tokenHash);
  expect(getRequestTokenHash(new Request("https://example.test", { headers: { cookie: `km_session=${event.operators[0]}` } }))).toBeNull();
});
