import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, it } from 'vitest';
import { closePool, getPool } from '@/server/db/pool';
import { runCommand, type CommandResult } from '@/server/db/tx';
import { executeAdminCommand } from '@/server/services/admin-service';
import { executeGameCommand } from '@/server/services/game-service';
import { settleBlocks } from '@/server/services/block-service';
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent, type TestSession } from './helpers';

let event: TestEvent;
let host: TestSession;
const sessions = new Map<string, TestSession>();
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

interface GameSnapshot {
  id: string; game_no: number; phase: string; game_version: number; turn_lead_participant_id: string;
  owner_participant_id: string; ensemble_done: boolean; ensemble_trigger_no: number; gt_status: string;
  card_count: number; noise_picks: number[]; member_ids: string[];
}

function success<T>(result: CommandResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.status} ${result.code}`);
  return result.data;
}

async function admin(command: string, args: Record<string, unknown> = {}, teamKey?: string) {
  const version = (await getPool().query<{ version: number }>(`SELECT CASE WHEN $2::text IS NULL THEN e.session_version ELSE tb.team_version END AS version
    FROM events e LEFT JOIN teams t ON t.event_id=e.id AND t.team_key=$2
    LEFT JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block WHERE e.id=$1`, [event.id, teamKey ?? null])).rows[0].version;
  const body = { command, args, teamKey, expectedVersion: version };
  const result = await runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: 'admin', payload: body, requestId: randomUUID(), receipt: true }, async (ctx) => {
    const data = await executeAdminCommand(ctx, body);
    await settleBlocks(ctx);
    return data;
  });
  success(result, `${teamKey ?? 'host'} ${command}`);
}

async function snapshot(teamKey: string): Promise<GameSnapshot> {
  return (await getPool().query<GameSnapshot>(`SELECT g.id,g.game_no,g.phase,g.game_version,g.turn_lead_participant_id,
    g.owner_participant_id,g.ensemble_done,g.ensemble_trigger_no,g.gt_status,
    (SELECT count(*)::integer FROM data_cards c WHERE c.game_id=g.id) AS card_count,
    ARRAY(SELECT c.card_no::integer FROM data_cards c WHERE c.game_id=g.id AND c.is_noise ORDER BY c.card_no) AS noise_picks,
    ARRAY(SELECT gm.participant_id FROM game_members gm WHERE gm.game_id=g.id ORDER BY gm.participant_id) AS member_ids
    FROM events e JOIN teams t ON t.event_id=e.id AND t.team_key=$2
    JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block
    JOIN games g ON g.id=tb.current_game_id WHERE e.id=$1`, [event.id, teamKey])).rows[0];
}

async function gameAction(game: GameSnapshot, command: string, args: Record<string, unknown> = {}, actor = sessions.get(game.turn_lead_participant_id)!) {
  const body = { gameId: game.id, gameVersion: game.game_version, ...args };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command, payload: body, requestId: randomUUID(), receipt: !['intro-ack', 'ensemble-vote'].includes(command) }, async (ctx) => {
    const result = await executeGameCommand(ctx, command, body);
    await settleBlocks(ctx);
    return result;
  });
}

async function finishGame(teamKey: string, gameNo: number) {
  let game = await snapshot(teamKey);
  expect(game.game_no).toBe(gameNo);
  expect(game.member_ids).toHaveLength(7);
  expect(game.ensemble_trigger_no).toBe(4);
  while (game.phase === 'TURN' && !game.ensemble_done) {
    success(await gameAction(game, 'more-data', { expectedCardCount: game.card_count }), `${teamKey}/${gameNo} more-data`);
    game = await snapshot(teamKey);
  }
  expect(game.phase).toBe('ENSEMBLE_SHARE');
  success(await gameAction(game, 'intro-ack', { introKey: 'ensemble' }), 'ensemble intro');
  success(await gameAction(game, 'ensemble-shared', {}, host), 'ensemble shared');
  game = await snapshot(teamKey);
  success(await gameAction(game, 'ensemble-vote', { pickId: game.owner_participant_id, revision: 0 }), 'ensemble vote');
  if (teamKey === 'A' && gameNo === 1) {
    await admin('pause', {}, teamKey);
    game = await snapshot(teamKey);
    expect(await gameAction(game, 'ensemble-vote', { pickId: game.owner_participant_id, revision: 1 })).toMatchObject({ ok: false, code: 'PAUSED' });
    expect((await getPool().query('SELECT vote_deadline FROM games WHERE id=$1', [game.id])).rows[0].vote_deadline).toBeNull();
    await admin('resume', {}, teamKey);
    expect((await getPool().query('SELECT vote_deadline FROM games WHERE id=$1', [game.id])).rows[0].vote_deadline).toBeInstanceOf(Date);
  }
  // Advance the fixture's deadline instead of waiting 27 × 30 seconds. Only
  // the production runCommand deadline settlement changes the GAME phase.
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [game.id]);
  game = await snapshot(teamKey);
  expect(await gameAction(game, 'ensemble-vote', { pickId: game.owner_participant_id, revision: 1 })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  game = await snapshot(teamKey);
  expect(game.phase).toBe('ENSEMBLE_DISCUSS');
  success(await gameAction(game, 'ensemble-end-discussion', {}, host), 'end discussion');
  game = await snapshot(teamKey);
  expect(game.ensemble_done).toBe(true);
  expect(game.phase).toBe('TURN');
  if (gameNo >= 4) {
    while (game.gt_status === 'pending' && game.card_count < 20) {
      success(await gameAction(game, 'more-data', { expectedCardCount: game.card_count }), 'pending GT more-data');
      game = await snapshot(teamKey);
    }
    expect(game.gt_status).toBe('announced');
    success(await gameAction(game, 'intro-ack', { introKey: 'ground_truth' }), 'GT intro');
  } else expect(game.gt_status).toBe('none');
  if (gameNo === 1) expect(game.noise_picks).toEqual([]);
  else {
    expect(game.noise_picks.length).toBeGreaterThanOrEqual(1);
    success(await gameAction(game, 'intro-ack', { introKey: 'noise' }), 'Noise intro');
  }
  const answer = success(await gameAction(game, 'guess', { ownerPick: game.owner_participant_id, noisePicks: game.noise_picks }), `${teamKey}/${gameNo} correct guess`);
  expect(answer).toEqual({ correct: true });
  const revealed = (await getPool().query<{ phase: string; end_reason: string }>('SELECT phase,end_reason FROM games WHERE id=$1', [game.id])).rows[0];
  expect(revealed).toEqual({ phase: 'REVEALED', end_reason: 'correct' });
}

it('T29 three teams complete all nine games, two seat rotations and host closure through server commands', async () => {
  event = await createTestEvent();
  sessions.clear();
  await Promise.all([...event.students, ...event.operators].map(async (id) => sessions.set(id, await createTestSession(event, id))));
  host = sessions.get(event.operators[0])!;
  await admin('assign-teams');
  await admin('publish-teams');
  // Synthetic complete profiles are fixture data; every gameplay transition
  // below uses the same transactional commands as the HTTP routes.
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT $1,a.participant_id,'Q'||lpad(q::text,2,'0'),CASE WHEN (a.seat_no+q)%7<4 THEN 'A' ELSE 'B' END,1
    FROM block_assignments a CROSS JOIN generate_series(1,20) q WHERE a.event_id=$1 AND a.block_no=1`, [event.id]);
  await getPool().query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  await admin('start-game1');
  for (let block = 1; block <= 3; block++) {
    for (const key of ['A', 'B', 'C']) {
      if (block > 1) await admin('start-block-game', {}, key);
      for (let offset = 0; offset < 3; offset++) {
        if (offset > 0) await admin('next-game', {}, key);
        await finishGame(key, (block - 1) * 3 + offset + 1);
      }
    }
    const state = (await getPool().query<{ phase: string; current_block: number }>('SELECT phase,current_block FROM events WHERE id=$1', [event.id])).rows[0];
    expect(state).toEqual({ phase: block < 3 ? 'BREAK' : 'BLOCK', current_block: block });
    expect((await getPool().query("SELECT id FROM team_blocks WHERE event_id=$1 AND block_no=$2 AND phase='BLOCK_DONE'", [event.id, block])).rowCount).toBe(3);
    if (block < 3) {
      await admin('publish-next-block');
      const moved = (await getPool().query<{ team_key: string; moved: number }>(`SELECT t.team_key,count(*) FILTER (WHERE a.team_id<>b.team_id)::integer AS moved
        FROM block_assignments a JOIN block_assignments b ON b.event_id=a.event_id AND b.participant_id=a.participant_id AND b.block_no=a.block_no+1
        JOIN teams t ON t.id=a.team_id WHERE a.event_id=$1 AND a.block_no=$2 AND a.seat_no>0 GROUP BY t.team_key ORDER BY t.team_key`, [event.id, block])).rows;
      expect(moved).toEqual(['A', 'B', 'C'].map((team_key) => ({ team_key, moved: 3 })));
    }
    process.stdout.write(`Rehearsal: BLOCK ${block}, ${block * 9}/27 games verified.\n`);
  }
  await admin('end-session', { confirm: true });
  const totals = (await getPool().query<{ games: number; revealed: number; gt: number; attempts: number }>(`SELECT
    (SELECT count(*)::integer FROM games WHERE event_id=$1) AS games,
    (SELECT count(*)::integer FROM games WHERE event_id=$1 AND phase='REVEALED') AS revealed,
    (SELECT count(*)::integer FROM ground_truths gt JOIN games g ON g.id=gt.game_id WHERE g.event_id=$1) AS gt,
    (SELECT count(*)::integer FROM guess_attempts ga JOIN games g ON g.id=ga.game_id WHERE g.event_id=$1 AND ga.correct) AS attempts`, [event.id])).rows[0];
  expect(totals).toEqual({ games: 27, revealed: 27, gt: 18, attempts: 27 });
  expect((await getPool().query('SELECT phase FROM events WHERE id=$1', [event.id])).rows[0].phase).toBe('ENDED');
}, 900_000);
