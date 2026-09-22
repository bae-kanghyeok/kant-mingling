import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { closePool, getPool } from '@/server/db/pool';
import { runCommand, type CommandResult } from '@/server/db/tx';
import { executeAdminCommand } from '@/server/services/admin-service';
import { settleBlocks } from '@/server/services/block-service';
import type { GlobalConfig, TeamSettings } from '@/server/game/settings';
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent, type TestSession } from './helpers';

let event: TestEvent;
let host: TestSession;
let operatorB: TestSession;
beforeEach(async () => {
  event = await createTestEvent();
  [host, operatorB] = await Promise.all([createTestSession(event, event.operators[0]), createTestSession(event, event.operators[1])]);
});
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

function success<T>(result: CommandResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.status} ${result.code}`);
  return result.data;
}

async function version(teamKey?: string) {
  return (await getPool().query<{ version: number }>(`SELECT CASE WHEN $2::text IS NULL THEN e.session_version ELSE tb.team_version END AS version
    FROM events e LEFT JOIN teams t ON t.event_id=e.id AND t.team_key=$2
    LEFT JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block WHERE e.id=$1`, [event.id, teamKey ?? null])).rows[0].version;
}

async function submit(actor: TestSession, body: { command: string; expectedVersion: number; teamKey?: string; args?: Record<string, unknown> }, requestId = randomUUID()) {
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command: 'admin', payload: body, requestId, receipt: true }, async (ctx) => {
    const data = await executeAdminCommand(ctx, body);
    await settleBlocks(ctx);
    return data;
  });
}

async function admin(command: string, args: Record<string, unknown> = {}, teamKey?: string, actor = host) {
  return success(await submit(actor, { command, args, teamKey, expectedVersion: await version(teamKey) }), `${command}/${teamKey ?? 'host'}`);
}

async function startEvent() {
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT $1,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order+q)%7<4 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1`, [event.id]);
  await getPool().query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  await admin('assign-teams');
  await admin('publish-teams');
  await admin('start-game1');
}

async function game(teamKey: string) {
  return (await getPool().query<{ id: string; game_no: number; config_snapshot: TeamSettings }>(`SELECT g.id,g.game_no,g.config_snapshot FROM games g
    JOIN team_blocks tb ON tb.current_game_id=g.id JOIN teams t ON t.id=tb.team_id
    JOIN events e ON e.id=g.event_id WHERE e.id=$1 AND t.team_key=$2 AND tb.block_no=e.current_block`, [event.id, teamKey])).rows[0];
}

async function eventConfig() {
  return (await getPool().query<{ phase: string; current_block: number; config_json: GlobalConfig; pending_config_json: GlobalConfig | null }>(
    'SELECT phase,current_block,config_json,pending_config_json FROM events WHERE id=$1', [event.id])).rows[0];
}

it('T22 freezes current GAME settings, applies team changes next GAME and global changes next BLOCK', async () => {
  await startEvent();
  const first = await game('A');
  const oldGlobal = (await eventConfig()).config_json;
  const nextTeam: TeamSettings = { ...first.config_snapshot, preset: 'custom', rareFromRealOrdinal: 9, noiseCap: 2 };
  const nextGlobal: GlobalConfig = { ...oldGlobal, moveCountPerTeam: 2, blockTargetMinutes: [13, 14, 16], pollIdleMs: 6000 };
  await admin('update-team-settings', { settings: nextTeam }, 'A');
  await admin('update-global-settings', { settings: nextGlobal });
  expect((await game('A')).config_snapshot).toEqual(first.config_snapshot);
  expect(await eventConfig()).toMatchObject({ phase: 'BLOCK', current_block: 1, config_json: oldGlobal, pending_config_json: nextGlobal });

  await admin('force-end-game', {}, 'A');
  await admin('next-game', {}, 'A');
  const second = await game('A');
  expect(second.game_no).toBe(2);
  expect(second.config_snapshot).toEqual(nextTeam);
  expect((await eventConfig()).config_json).toEqual(oldGlobal);

  // Complete the existing block through real commands so the delayed global
  // settings must survive all GAME transitions and apply only at publication.
  for (const key of ['A', 'B', 'C']) {
    for (let gameNo = key === 'A' ? 2 : 1; gameNo <= 3; gameNo++) {
      await admin('force-end-game', {}, key);
      if (gameNo < 3) await admin('next-game', {}, key);
    }
  }
  expect(await eventConfig()).toMatchObject({ phase: 'BREAK', current_block: 1, config_json: oldGlobal, pending_config_json: nextGlobal });
  await admin('publish-next-block');
  expect(await eventConfig()).toMatchObject({ phase: 'BLOCK', current_block: 2, config_json: nextGlobal, pending_config_json: null });
  const moved = (await getPool().query<{ team_key: string; moved: number }>(`SELECT t.team_key,count(*) FILTER (WHERE a.team_id<>b.team_id)::integer AS moved
    FROM block_assignments a JOIN block_assignments b ON b.event_id=a.event_id AND b.participant_id=a.participant_id AND b.block_no=2
    JOIN teams t ON t.id=a.team_id WHERE a.event_id=$1 AND a.block_no=1 AND a.seat_no>0 GROUP BY t.team_key ORDER BY t.team_key`, [event.id])).rows;
  expect(moved).toEqual(['A', 'B', 'C'].map((team_key) => ({ team_key, moved: 2 })));
  await admin('start-block-game', {}, 'A');
  expect((await game('A')).config_snapshot).toEqual(nextTeam);
  expect((await getPool().query<{ config_snapshot: TeamSettings }>('SELECT config_snapshot FROM games WHERE id=$1', [first.id])).rows[0].config_snapshot).toEqual(first.config_snapshot);
}, 120_000);

it('T27 distinct host and team-operator sessions concurrently starting next GAME create exactly one GAME', async () => {
  await startEvent();
  await admin('force-end-game', {}, 'B', operatorB);
  const body = { command: 'next-game', teamKey: 'B', expectedVersion: await version('B'), args: {} };
  const requestIds = [randomUUID(), randomUUID()];
  expect(host.id).not.toBe(operatorB.id);
  expect(requestIds[0]).not.toBe(requestIds[1]);
  const results = await Promise.all([submit(host, body, requestIds[0]), submit(operatorB, body, requestIds[1])]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false, status: 409, code: 'STALE_VERSION' });
  const games = (await getPool().query<{ id: string; game_no: number }>(`SELECT g.id,g.game_no FROM games g JOIN teams t ON t.id=g.team_id
    WHERE g.event_id=$1 AND t.team_key='B' ORDER BY g.game_no`, [event.id])).rows;
  expect(games.map((row) => row.game_no)).toEqual([1, 2]);
  expect((await game('B')).id).toBe(games[1].id);
  expect((await getPool().query('SELECT id FROM games WHERE event_id=$1', [event.id])).rowCount).toBe(4);
}, 60_000);
