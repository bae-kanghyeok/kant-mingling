import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { bootstrapSession, claimParticipant } from "@/server/services/registration";
import { createTestEvent, createTestSession, cleanupTestEvent, testRequest, type TestEvent } from "./helpers";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T01 two sessions claiming one name have exactly one winner", async () => {
  const sessions = await Promise.all([createTestSession(event), createTestSession(event)]);
  const requests = sessions.map((session) => testRequest(event, session));
  const results = await Promise.all(requests.map((request) => claimParticipant(request, event.students[0])));
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false, status: 409, code: "NAME_LOCKED" });
  const winner = results.findIndex((result) => result.ok);
  expect(await claimParticipant(requests[winner], event.students[0])).toEqual(results[winner]);
  expect(await claimParticipant({ ...requests[winner], requestId: crypto.randomUUID() }, event.students[1]))
    .toEqual({ ok: false, status: 409, code: "ALREADY_CLAIMED" });
  expect((await getPool().query("SELECT COUNT(*)::int AS n FROM sessions WHERE participant_id=$1 AND revoked_at IS NULL", [event.students[0]])).rows[0].n).toBe(1);
});

it("T01 expired sessions do not keep a name locked and active bootstrap resumes the same session", async () => {
  const old = await createTestSession(event, event.students[0]);
  await getPool().query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
  const next = await createTestSession(event);
  expect((await claimParticipant(testRequest(event, next), event.students[0])).ok).toBe(true);
  expect((await getPool().query("SELECT revoked_at FROM sessions WHERE id=$1", [old.id])).rows[0].revoked_at).not.toBeNull();
  const resumed = await bootstrapSession({ slug: event.slug, tokenHash: next.tokenHash, ipHash: "synthetic-test" });
  expect(resumed.sessionId).toBe(next.id);
  expect(resumed.token).toBeUndefined();
});

it("T01 claims cannot promote a student or target an inactive name", async () => {
  const session = await createTestSession(event);
  expect(await claimParticipant(testRequest(event, session), event.operators[0])).toEqual({ ok: false, status: 403, code: "OPERATOR_CODE_REQUIRED" });
  await getPool().query("UPDATE participants SET active=false WHERE id=$1", [event.students[0]]);
  expect(await claimParticipant(testRequest(event, session), event.students[0])).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
});
