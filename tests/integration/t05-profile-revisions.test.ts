import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { saveProfileAnswer, submitProfile } from "@/server/services/profile";
import { releaseParticipant } from "@/server/services/registration";
import { createTestEvent, createTestSession, cleanupTestEvent, testRequest, seedProfileAnswers, type TestEvent } from "./helpers";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T05 completion requires 20 answers; stale saves cannot overwrite a newer answer", async () => {
  const session = await createTestSession(event, event.students[0]);
  await seedProfileAnswers(event, event.students[0], 19);
  expect(await submitProfile(testRequest(event, session))).toEqual({ ok: false, status: 422, code: "INCOMPLETE" });
  const edit = { questionId: "Q01", option: "B" as const, revision: 1 };
  expect(await saveProfileAnswer(testRequest(event, session), edit)).toEqual({ ok: true, data: { revision: 2 } });
  expect(await saveProfileAnswer(testRequest(event, session), edit)).toEqual({ ok: true, data: { revision: 2 } });
  expect(await saveProfileAnswer(testRequest(event, session), { ...edit, option: "A" })).toEqual({ ok: false, status: 409, code: "STALE_REVISION" });
  expect((await getPool().query("SELECT option,revision FROM profile_answers WHERE participant_id=$1 AND question_id='Q01'", [event.students[0]])).rows[0])
    .toEqual({ option: "B", revision: 2 });
  await saveProfileAnswer(testRequest(event, session), { questionId: "Q20", option: "A", revision: 0 });
  expect((await submitProfile(testRequest(event, session))).ok).toBe(true);
  expect(await releaseParticipant(testRequest(event, session))).toEqual({ ok: false, status: 409, code: "PROFILE_COMPLETE" });
});

it("T05 late completion locks the profile while incomplete registration can be released", async () => {
  const session = await createTestSession(event, event.students[0]);
  await saveProfileAnswer(testRequest(event, session), { questionId: "Q01", option: "A", revision: 0 });
  expect((await releaseParticipant(testRequest(event, session))).ok).toBe(true);
  expect((await getPool().query("SELECT COUNT(*)::int AS n FROM profile_answers WHERE participant_id=$1", [event.students[0]])).rows[0].n).toBe(0);
  const late = await createTestSession(event, event.students[0]);
  await seedProfileAnswers(event, event.students[0]);
  await getPool().query("UPDATE events SET phase='BLOCK', current_block=1 WHERE id=$1", [event.id]);
  expect((await submitProfile(testRequest(event, late))).ok).toBe(true);
  expect(await saveProfileAnswer(testRequest(event, late), { questionId: "Q01", option: "B", revision: 1 }))
    .toEqual({ ok: false, status: 409, code: "PROFILE_LOCKED" });
});
