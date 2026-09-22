import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { closePool, getPool } from '@/server/db/pool';
import { runCommand } from '@/server/db/tx';
import { createGame, executeGameCommand, forceReveal } from '@/server/services/game-service';
import { executeAdminCommand } from '@/server/services/admin-service';
import { DEFAULT_TEAM_SETTINGS, type TeamSettings } from '@/server/game/settings';
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent, type TestSession } from './helpers';

let event: TestEvent;
let host: TestSession;
const sessions = new Map<string, TestSession>();
beforeEach(async () => {
  event = await createTestEvent();
  sessions.clear();
  for (const id of [event.operators[0], ...event.students.slice(0, 6)]) sessions.set(id, await createTestSession(event, id));
  host = sessions.get(event.operators[0])!;
});
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

async function setupGame(gameNo = 1, completeCount = 7, settings: TeamSettings = DEFAULT_TEAM_SETTINGS) {
  const memberIds = [event.operators[0], ...event.students.slice(0, 6)];
  const completed = memberIds.slice(0, completeCount);
  const pool = getPool();
  await pool.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT $1,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.ord+q)%7<4 THEN 'A' ELSE 'B' END,1
    FROM unnest($2::uuid[]) WITH ORDINALITY AS p(id,ord) CROSS JOIN generate_series(1,20) q`, [event.id, completed]);
  await pool.query("UPDATE participants SET profile_completed_at=clock_timestamp(),attendance='present' WHERE id=ANY($1::uuid[])", [completed]);
  const blockNo = Math.ceil(gameNo / 3);
  const teamId = (await pool.query<{ id: string }>("INSERT INTO teams(event_id,team_key,operator_participant_id) VALUES($1,'A',$2) RETURNING id", [event.id, event.operators[0]])).rows[0].id;
  await pool.query(`INSERT INTO block_assignments(event_id,block_no,participant_id,team_id,seat_no)
    SELECT $1,$2,p.id,$3,p.ord-1 FROM unnest($4::uuid[]) WITH ORDINALITY AS p(id,ord)`, [event.id, blockNo, teamId, memberIds]);
  const teamBlockId = (await pool.query<{ id: string }>(`INSERT INTO team_blocks(event_id,block_no,team_id,phase,settings_json)
    VALUES($1,$2,$3,'SEATING',$4) RETURNING id`, [event.id, blockNo, teamId, JSON.stringify(settings)])).rows[0].id;
  await pool.query("UPDATE events SET phase='BLOCK',current_block=$2 WHERE id=$1", [event.id, blockNo]);
  const result = await runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: 'test-create', requestId: randomUUID(), receipt: true, payload: { teamBlockId, gameNo } }, async (ctx) => ({ gameId: await createGame(ctx, { teamBlockId, gameNo }) }));
  return { result, teamBlockId };
}

async function loadGame(gameId: string) {
  return (await getPool().query<{ id: string; game_version: number; turn_lead_participant_id: string; owner_participant_id: string; phase: string; guess_locked: boolean; ensemble_sharer_id: string; gt_status: string; vote_deadline: Date | null; paused_ms_total: number }>('SELECT * FROM games WHERE id=$1', [gameId])).rows[0];
}

async function action(gameId: string, command: string, extra: Record<string, unknown> = {}, actor?: TestSession) {
  const game = await loadGame(gameId);
  const session = actor ?? sessions.get(game.turn_lead_participant_id)!;
  const args = { gameId, gameVersion: game.game_version, ...extra };
  return runCommand({ slug: event.slug, tokenHash: session.tokenHash, command, payload: args, requestId: randomUUID(), receipt: command !== 'ensemble-vote' && command !== 'intro-ack' }, (ctx) => executeGameCommand(ctx, command, args));
}

it('T06 cannot force-create a GAME with fewer than two completed members', async () => {
  const { result } = await setupGame(1, 1);
  expect(result).toEqual({ ok: false, status: 409, code: 'INSUFFICIENT_MEMBERS' });
  expect((await getPool().query('SELECT id FROM games WHERE event_id=$1', [event.id])).rows).toHaveLength(0);
});

it('T12/T14 concurrent more-data commits one card, wrong guesses lock until a new card', async () => {
  const { result } = await setupGame();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { gameId } = result.data;
  const initial = await loadGame(gameId);
  const wrongPick = [event.operators[0], ...event.students.slice(0, 6)].find((id) => id !== initial.owner_participant_id)!;
  expect(await action(gameId, 'guess', { ownerPick: wrongPick, noisePicks: [] })).toEqual({ ok: true, data: { correct: false } });
  expect((await loadGame(gameId)).guess_locked).toBe(true);
  expect(await action(gameId, 'guess', { ownerPick: initial.owner_participant_id, noisePicks: [] })).toEqual({ ok: false, status: 409, code: 'GUESS_LOCKED' });
  const current = await loadGame(gameId);
  const session = sessions.get(current.turn_lead_participant_id)!;
  const args = { gameId, gameVersion: current.game_version, expectedCardCount: 1 };
  const submit = () => runCommand({ slug: event.slug, tokenHash: session.tokenHash, command: 'more-data', payload: args, requestId: randomUUID(), receipt: true }, (ctx) => executeGameCommand(ctx, 'more-data', args));
  const results = await Promise.all([submit(), submit()]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toEqual({ ok: false, status: 409, code: 'STALE_VERSION' });
  expect((await getPool().query('SELECT id FROM data_cards WHERE game_id=$1', [gameId])).rows).toHaveLength(2);
  expect((await loadGame(gameId)).guess_locked).toBe(false);
  expect(await action(gameId, 'guess', { ownerPick: initial.owner_participant_id, noisePicks: [] })).toEqual({ ok: true, data: { correct: true } });
  expect((await loadGame(gameId)).phase).toBe('REVEALED');
});

it('T17/T18 votes use revisions, deadline transitions once, and GT is real and acknowledged per GAME', async () => {
  const { result } = await setupGame(4);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { gameId } = result.data;
  for (let expectedCardCount = 1; expectedCardCount < 4; expectedCardCount++) expect((await action(gameId, 'more-data', { expectedCardCount })).ok).toBe(true);
  expect((await loadGame(gameId)).phase).toBe('ENSEMBLE_SHARE');
  expect((await action(gameId, 'ensemble-shared', {}, host)).ok).toBe(true);
  const pickId = event.students[0];
  expect(await action(gameId, 'ensemble-vote', { pickId, revision: 0 }, host)).toEqual({ ok: true, data: { revision: 1 } });
  expect(await action(gameId, 'ensemble-vote', { pickId: event.students[1], revision: 1 }, host)).toEqual({ ok: true, data: { revision: 2 } });
  expect(await action(gameId, 'ensemble-vote', { pickId, revision: 0 }, host)).toEqual({ ok: false, status: 409, code: 'STALE_REVISION' });
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [gameId]);
  expect((await action(gameId, 'ensemble-end-discussion', {}, host)).ok).toBe(false); // sync first changes gameVersion
  expect((await action(gameId, 'ensemble-end-discussion', {}, host)).ok).toBe(true);
  const after = await loadGame(gameId);
  expect(after.phase).toBe('TURN');
  expect(after.gt_status).toBe('announced');
  const gt = (await getPool().query<{ is_noise: boolean }>('SELECT c.is_noise FROM ground_truths gt JOIN data_cards c ON c.id=gt.card_id WHERE gt.game_id=$1', [gameId])).rows;
  expect(gt).toEqual([{ is_noise: false }]);
  expect(await action(gameId, 'more-data', { expectedCardCount: 4 })).toEqual({ ok: false, status: 409, code: 'INTRO_REQUIRED' });
  expect((await action(gameId, 'intro-ack', { introKey: 'ground_truth' })).ok).toBe(true);
  expect((await action(gameId, 'more-data', { expectedCardCount: 4 })).ok).toBe(true);
  expect((await getPool().query('SELECT * FROM ground_truths WHERE game_id=$1', [gameId])).rows).toHaveLength(1);
});

it('T20 forced reveal during pause clears pause and preserves elapsed accounting for the next GAME', async () => {
  const { result, teamBlockId } = await setupGame();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { gameId } = result.data;
  await getPool().query("UPDATE team_blocks SET paused_at=clock_timestamp()-interval '2 seconds' WHERE id=$1", [teamBlockId]);
  const forced = await runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: 'test-force', payload: { gameId } }, async (ctx) => { await forceReveal(ctx, gameId, 'forced'); return {}; });
  expect(forced.ok).toBe(true);
  expect((await getPool().query('SELECT phase,paused_at FROM team_blocks WHERE id=$1', [teamBlockId])).rows[0]).toEqual({ phase: 'REVEAL', paused_at: null });
  expect((await loadGame(gameId)).paused_ms_total).toBeGreaterThanOrEqual(2000);
  const next = await runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: 'test-next', payload: {} }, async (ctx) => ({ gameId: await createGame(ctx, { teamBlockId, gameNo: 2 }) }));
  expect(next.ok).toBe(true);
  if (next.ok) {
    expect((await loadGame(next.data.gameId)).phase).toBe('TURN');
    expect((await loadGame(next.data.gameId)).paused_ms_total).toBe(0);
  }
});

it('T17 pause freezes the server vote deadline and resume restores its remaining time', async () => {
  const { result, teamBlockId } = await setupGame(4, 7, { ...DEFAULT_TEAM_SETTINGS, ensembleTriggerOverride: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { gameId } = result.data;
  expect((await loadGame(gameId)).phase).toBe('ENSEMBLE_SHARE');
  expect((await action(gameId, 'ensemble-shared', {}, host)).ok).toBe(true);
  const admin = async (command: 'pause' | 'resume') => {
    const version = (await getPool().query<{ team_version: number }>('SELECT team_version FROM team_blocks WHERE id=$1', [teamBlockId])).rows[0].team_version;
    const body = { command, teamKey: 'A', expectedVersion: version };
    return runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: 'admin', payload: body }, (ctx) => executeAdminCommand(ctx, body));
  };
  expect((await admin('pause')).ok).toBe(true);
  const paused = (await getPool().query<{ vote_deadline: Date | null; vote_remaining_ms: number }>('SELECT vote_deadline,vote_remaining_ms FROM games WHERE id=$1', [gameId])).rows[0];
  expect(paused.vote_deadline).toBeNull();
  expect(paused.vote_remaining_ms).toBeGreaterThan(0);
  expect(paused.vote_remaining_ms).toBeLessThanOrEqual(30_000);
  expect(await action(gameId, 'ensemble-vote', { pickId: event.students[0], revision: 0 }, host)).toEqual({ ok: false, status: 409, code: 'PAUSED' });
  await getPool().query("UPDATE team_blocks SET paused_at=clock_timestamp()-interval '2 seconds' WHERE id=$1", [teamBlockId]);
  expect((await admin('resume')).ok).toBe(true);
  const resumed = (await getPool().query<{ remaining: number; paused_ms_total: number; phase: string; vote_remaining_ms: number | null }>(`SELECT extract(epoch FROM (vote_deadline-clock_timestamp()))*1000 AS remaining,
    paused_ms_total,phase,vote_remaining_ms FROM games WHERE id=$1`, [gameId])).rows[0];
  expect(Number(resumed.remaining)).toBeGreaterThan(paused.vote_remaining_ms - 5000);
  expect(Number(resumed.remaining)).toBeLessThanOrEqual(paused.vote_remaining_ms);
  expect(resumed.vote_remaining_ms).toBeNull();
  expect(resumed.paused_ms_total).toBeGreaterThanOrEqual(2000);
  expect(resumed.phase).toBe('ENSEMBLE_VOTE');
  expect((await action(gameId, 'ensemble-vote', { pickId: event.students[0], revision: 0 }, host)).ok).toBe(true);
});
