import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { getPool, closePool } from "@/server/db/pool";
import { runCommand, type CommandResult } from "@/server/db/tx";
import { getState } from "@/server/dto/state-dto";
import { executeAdminCommand } from "@/server/services/admin-service";
import { executeGameCommand } from "@/server/services/game-service";
import { settleBlocks } from "@/server/services/block-service";
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent, type TestSession } from "./helpers";

let event: TestEvent;
let host: TestSession;
const sessions = new Map<string, TestSession>();
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

interface GameSnapshot {
  id: string; game_no: number; phase: string; game_version: number; turn_lead_participant_id: string;
  owner_participant_id: string; ensemble_trigger_no: number; ensemble_done: boolean; gt_status: string;
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
  success(await runCommand({ slug: event.slug, tokenHash: host.tokenHash, command: "admin", payload: body, requestId: randomUUID(), receipt: true }, async ctx => {
    const result = await executeAdminCommand(ctx, body); await settleBlocks(ctx); return result;
  }), command);
}
async function snapshot(): Promise<GameSnapshot> {
  return (await getPool().query<GameSnapshot>(`SELECT g.id,g.game_no,g.phase,g.game_version,g.turn_lead_participant_id,
    g.owner_participant_id,g.ensemble_trigger_no,g.ensemble_done,g.gt_status,
    (SELECT count(*)::integer FROM data_cards c WHERE c.game_id=g.id) AS card_count,
    ARRAY(SELECT card_no::integer FROM data_cards WHERE game_id=g.id AND is_noise ORDER BY card_no) AS noise_picks,
    ARRAY(SELECT participant_id FROM game_members WHERE game_id=g.id ORDER BY participant_id) AS member_ids
    FROM events e JOIN team_blocks tb ON tb.event_id=e.id AND tb.block_no=e.current_block
    JOIN games g ON g.id=tb.current_game_id WHERE e.id=$1`, [event.id])).rows[0];
}
async function gameAction(game: GameSnapshot, command: string, args: Record<string, unknown> = {}, actor = sessions.get(game.turn_lead_participant_id)!) {
  const body = { gameId: game.id, gameVersion: game.game_version, ...args };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command, payload: body, requestId: randomUUID(), receipt: !["intro-ack", "ensemble-vote"].includes(command) }, async ctx => {
    const result = await executeGameCommand(ctx, command, body); await settleBlocks(ctx); return result;
  });
}
async function finishGame(gameNo: number) {
  let game = await snapshot();
  expect(game.game_no).toBe(gameNo);
  expect(game.member_ids).toHaveLength(6);
  expect(game.member_ids).toContain(event.operators[0]);
  // Six participants, including the host, naturally trigger Ensemble at card 3.
  expect(game.ensemble_trigger_no).toBe(3);
  while (game.phase === "TURN" && !game.ensemble_done) {
    success(await gameAction(game, "more-data", { expectedCardCount: game.card_count }), "more data");
    game = await snapshot();
  }
  expect(game.phase).toBe("ENSEMBLE_SHARE");
  success(await gameAction(game, "intro-ack", { introKey: "ensemble" }), "ensemble intro");
  success(await gameAction(game, "ensemble-shared", {}, host), "ensemble shared");
  game = await snapshot();
  // The host casts an ordinary participant vote. Everyone else can vote too.
  success(await gameAction(game, "intro-ack", { introKey: "ensemble" }, host), "host ensemble intro");
  success(await gameAction(game, "ensemble-vote", { pickId: event.students[0], revision: 0 }, host), "host vote");
  if (gameNo === 1) {
    await Promise.all(event.students.map(async id => {
      success(await gameAction(game, "intro-ack", { introKey: "ensemble" }, sessions.get(id)!), "student ensemble intro");
      success(await gameAction(game, "ensemble-vote", { pickId: event.students[0], revision: 0 }, sessions.get(id)!), "student vote");
    }));
    expect((await getPool().query("SELECT voter_id FROM ensemble_votes WHERE game_id=$1", [game.id])).rowCount).toBe(6);
    await admin("pause", {}, "A");
    game = await snapshot();
    expect(await gameAction(game, "ensemble-vote", { pickId: event.students[1], revision: 1 }, host)).toMatchObject({ ok: false, code: "PAUSED" });
    await admin("resume", {}, "A");
  }
  // Fixture clock only; the normal command settles the deadline and moves phase.
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [game.id]);
  game = await snapshot();
  expect(await gameAction(game, "ensemble-vote", { pickId: event.students[1], revision: 1 }, host)).toMatchObject({ ok: false, code: "WRONG_PHASE" });
  game = await snapshot(); expect(game.phase).toBe("ENSEMBLE_DISCUSS");
  success(await gameAction(game, "ensemble-end-discussion", {}, host), "end discussion");
  game = await snapshot(); expect(game.phase).toBe("TURN");
  if (gameNo >= 4) {
    while (game.gt_status === "pending" && game.card_count < 20) {
      success(await gameAction(game, "more-data", { expectedCardCount: game.card_count }), "ground truth wait");
      game = await snapshot();
    }
    expect(game.gt_status).toBe("announced");
    success(await gameAction(game, "intro-ack", { introKey: "ground_truth" }), "ground truth intro");
  } else expect(game.gt_status).toBe("none");
  if (gameNo === 1) expect(game.noise_picks).toEqual([]);
  else {
    expect(game.noise_picks.length).toBeGreaterThanOrEqual(1);
    success(await gameAction(game, "intro-ack", { introKey: "noise" }), "noise intro");
  }
  // Private fixture inspection constructs the correct guess; no helper DTO is used.
  expect(success(await gameAction(game, "guess", { ownerPick: game.owner_participant_id, noisePicks: game.noise_picks }), "correct guess")).toEqual({ correct: true });
}

it("T34 host and five participants complete nine games in one team without changing seats, then close the event", async () => {
  event = await createTestEvent({ studentCount: 5, teamCount: 1, moveCountPerTeam: 0 });
  sessions.clear();
  for (const id of [...event.students, ...event.operators]) sessions.set(id, await createTestSession(event, id));
  host = sessions.get(event.operators[0])!;
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order+q)%6<3 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1`, [event.id]);
  await getPool().query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  await admin("assign-teams"); await admin("publish-teams"); await admin("start-game1");
  const hostView = await getState(event.slug, host.tokenHash);
  expect(hostView.me).toMatchObject({ isHost: true, role: "operator" });
  expect(hostView.game?.candidates).toHaveLength(6); expect(hostView.admin?.teams).toHaveLength(1);
  expect(hostView.game?.reveal).toBeUndefined();
  expect((await getState(event.slug, sessions.get(event.students[0])!.tokenHash)).admin).toBeUndefined();
  const originalSeats = (await getPool().query("SELECT participant_id,team_id,seat_no FROM block_assignments WHERE event_id=$1 AND block_no=1 ORDER BY seat_no", [event.id])).rows;
  for (let block = 1; block <= 3; block++) {
    if (block > 1) await admin("start-block-game", {}, "A");
    for (let offset = 0; offset < 3; offset++) {
      if (offset > 0) await admin("next-game", {}, "A");
      await finishGame((block - 1) * 3 + offset + 1);
    }
    expect((await getPool().query("SELECT phase,current_block FROM events WHERE id=$1", [event.id])).rows[0]).toEqual({ phase: block < 3 ? "BREAK" : "BLOCK", current_block: block });
    if (block < 3) {
      await admin("publish-next-block");
      expect((await getPool().query("SELECT participant_id,team_id,seat_no FROM block_assignments WHERE event_id=$1 AND block_no=$2 ORDER BY seat_no", [event.id, block + 1])).rows).toEqual(originalSeats);
    }
    process.stdout.write(`Single-team rehearsal: BLOCK ${block}, ${block * 3}/9 games verified.\n`);
  }
  await admin("end-session", { confirm: true });
  const totals = (await getPool().query(`SELECT
    (SELECT count(*)::int FROM games WHERE event_id=$1 AND phase='REVEALED') AS revealed,
    (SELECT count(*)::int FROM ground_truths gt JOIN games g ON g.id=gt.game_id WHERE g.event_id=$1) AS ground_truths,
    (SELECT count(*)::int FROM game_members m JOIN games g ON g.id=m.game_id WHERE g.event_id=$1 AND m.participant_id=$2) AS host_games,
    (SELECT count(*)::int FROM ensemble_votes v JOIN games g ON g.id=v.game_id WHERE g.event_id=$1 AND v.voter_id=$2) AS host_votes`, [event.id, event.operators[0]])).rows[0];
  expect(totals).toEqual({ revealed: 9, ground_truths: 6, host_games: 9, host_votes: 9 });
  expect((await getPool().query("SELECT phase FROM events WHERE id=$1", [event.id])).rows[0].phase).toBe("ENDED");
}, 600_000);
