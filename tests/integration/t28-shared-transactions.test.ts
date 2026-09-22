import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { runCommand } from "@/server/db/tx";
import { saveProfileAnswer, submitProfile } from "@/server/services/profile";
import { createTestEvent, createTestSession, cleanupTestEvent, testRequest, seedProfileAnswers, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";

let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("T28 independent shared commands enter concurrently while an existing event SHARE lock is held", async () => {
  const firstSession = await createTestSession(event, event.students[0]);
  const secondSession = await createTestSession(event, event.students[1]);
  const entered = signal();
  const finish = signal();
  const first = runCommand({ ...testRequest(event, firstSession), command: "profile-save", payload: {} }, async () => {
    entered.resolve(); await finish.promise; return {};
  });
  try {
    await entered.promise;
    const second = await runCommand({ ...testRequest(event, secondSession), command: "intro-ack", payload: {} }, async () => ({}));
    expect(second).toEqual({ ok: true, data: {} });
  } finally { finish.resolve(); await first; }
});

it("T28 two shared profile submissions with the same receipt return one persisted result", async () => {
  const session = await createTestSession(event, event.students[0]);
  await seedProfileAnswers(event, event.students[0]);
  const request = testRequest(event, session);
  expect(await Promise.all([submitProfile(request), submitProfile(request)])).toEqual([{ ok: true, data: {} }, { ok: true, data: {} }]);
  expect((await getPool().query("SELECT count(*)::int AS n FROM command_receipts WHERE actor_session_id=$1 AND request_id=$2", [session.id, request.requestId])).rows[0].n).toBe(1);
});

it("T28 rejected shared commands still commit deadline reconciliation after releasing their locks", async () => {
  const fixture = await createVisibilityFixture(event);
  const game = fixture.groups[0].game;
  await getPool().query("UPDATE games SET phase='ENSEMBLE_VOTE',vote_deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [game]);
  const result = await saveProfileAnswer(testRequest(event, fixture.byPerson.get(event.students[0])!), { questionId: "Q21", option: "A", revision: 0 });
  expect(result).toEqual({ ok: false, status: 422, code: "INVALID_REQUEST" });
  expect((await getPool().query("SELECT phase,game_version FROM games WHERE id=$1", [game])).rows[0]).toEqual({ phase: "ENSEMBLE_DISCUSS", game_version: 1 });
  await getPool().query("UPDATE games SET phase='ENSEMBLE_VOTE',vote_deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [game]);
  const outcomes = await Promise.all(event.students.slice(0, 8).map((id) => runCommand({
    slug: event.slug, tokenHash: fixture.byPerson.get(id)!.tokenHash, command: "sync", requestId: randomUUID(), payload: {},
  }, async () => ({}))));
  expect(outcomes.every((value) => value.ok)).toBe(true);
  expect((await getPool().query("SELECT phase,game_version FROM games WHERE id=$1", [game])).rows[0]).toEqual({ phase: "ENSEMBLE_DISCUSS", game_version: 2 });
}, 60000);
