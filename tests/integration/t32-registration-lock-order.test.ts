import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { closePool, getPool } from '@/server/db/pool';
import { claimParticipant, releaseParticipant } from '@/server/services/registration';
import { saveProfileAnswer } from '@/server/services/profile';
import { cleanupTestEvent, createTestEvent, createTestSession, seedProfileAnswers, testRequest, type TestEvent } from './helpers';

let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

/** Observe a real PostgreSQL wait; do not guess the race with a fixed sleep. */
async function waitingBehind(blockerPid: number, queryFragment: string): Promise<number> {
  const until = Date.now() + 2500;
  do {
    const result = await getPool().query<{ pid: number }>(`SELECT a.pid FROM pg_stat_activity a
      WHERE $1::integer=ANY(pg_blocking_pids(a.pid)) AND position($2::text IN a.query)>0 LIMIT 1`, [blockerPid, queryFragment]);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < until);
  throw new Error('Expected database lock wait was not observed.');
}

it('T32 release serializes the same session before profile-save can retain the old participant identity', async () => {
  const person = event.students[0];
  const session = await createTestSession(event, person);
  await seedProfileAnswers(event, person, 1);
  const lock = await getPool().connect();
  const pending: Promise<unknown>[] = [];
  try {
    await lock.query('BEGIN');
    const blocker = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT id FROM participants WHERE id=$1 FOR UPDATE', [person]);
    const releasing = releaseParticipant(testRequest(event, session));
    releasing.catch(() => {});
    pending.push(releasing);
    // Release owns S and is blocked on P. The concurrent save must wait on S,
    // then read its newly released identity, rather than caching the old P.
    const releasePid = await waitingBehind(blocker, 'SELECT profile_completed_at, profile_locked_at FROM participants');
    const saving = saveProfileAnswer(testRequest(event, session), { questionId: 'Q02', option: 'B', revision: 0 });
    saving.catch(() => {});
    pending.push(saving);
    await waitingBehind(releasePid, 'FROM sessions s');
    await lock.query('COMMIT');
    expect(await releasing).toEqual({ ok: true, data: {} });
    expect(await saving).toEqual({ ok: false, status: 401, code: 'UNAUTHENTICATED' });
    expect((await getPool().query('SELECT participant_id FROM sessions WHERE id=$1', [session.id])).rows[0].participant_id).toBeNull();
    expect((await getPool().query('SELECT question_id FROM profile_answers WHERE participant_id=$1', [person])).rows).toEqual([]);
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    lock.release();
    await Promise.allSettled(pending);
  }
});

it('T32 claim skips a locked expired session and succeeds after its holder finishes', async () => {
  const person = event.students[0];
  const previous = await createTestSession(event, person);
  const next = await createTestSession(event);
  await getPool().query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [previous.id]);
  const lock = await getPool().connect();
  try {
    await lock.query('BEGIN');
    // Represents a command that began just before expiry and still owns S.
    await lock.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [previous.id]);
    expect(await claimParticipant(testRequest(event, next), person)).toEqual({ ok: false, status: 409, code: 'NAME_LOCKED' });
    await lock.query('COMMIT');
    expect(await claimParticipant(testRequest(event, next), person)).toEqual({ ok: true, data: {} });
    expect((await getPool().query('SELECT participant_id FROM sessions WHERE id=$1', [next.id])).rows[0].participant_id).toBe(person);
    expect((await getPool().query('SELECT revoked_at FROM sessions WHERE id=$1', [previous.id])).rows[0].revoked_at).toBeInstanceOf(Date);
    expect((await getPool().query('SELECT id FROM sessions WHERE participant_id=$1 AND revoked_at IS NULL', [person])).rows).toEqual([{ id: next.id }]);
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    lock.release();
  }
});
