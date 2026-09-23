import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { runCommand, type CommandResult } from "@/server/db/tx";
import { getState } from "@/server/dto/state-dto";
import { executeAdminCommand } from "@/server/services/admin-service";
import { executeGameCommand } from "@/server/services/game-service";
import { settleBlocks } from "@/server/services/block-service";
import { submitProfile } from "@/server/services/profile";
import { cleanupTestEvent, createTestEvent, createTestSession, seedProfileAnswers, testRequest, type TestEvent, type TestSession } from "./helpers";

let event: TestEvent;
const sessions = new Map<string, TestSession>();
afterEach(async () => { if (event) await cleanupTestEvent(event); sessions.clear(); });
afterAll(closePool);

interface Game {
  id: string; game_no: number; block_no: number; phase: string; game_version: number;
  turn_lead_participant_id: string; owner_participant_id: string; gm_guess_open: boolean; guess_locked: boolean;
  gt_status: string; card_count: number; noise_picks: number[]; member_ids: string[];
  config_snapshot: { gm: { noiseCap: number; groundTruth: boolean } };
}
const host = () => sessions.get(event.operators[0])!;
const gm = (key: string) => sessions.get(event.operators[key.charCodeAt(0) - 65])!;
function success<T>(result: CommandResult<T>, label = "command"): T {
  if (!result.ok) throw new Error(`${label}: ${result.status} ${result.code}`);
  return result.data;
}
async function current(key = "A"): Promise<Game> {
  return (await getPool().query<Game>(`SELECT g.*,
    (SELECT count(*)::int FROM data_cards WHERE game_id=g.id) AS card_count,
    ARRAY(SELECT card_no::int FROM data_cards WHERE game_id=g.id AND is_noise ORDER BY card_no) AS noise_picks,
    ARRAY(SELECT participant_id FROM game_members WHERE game_id=g.id ORDER BY participant_id) AS member_ids
    FROM events e JOIN teams t ON t.event_id=e.id JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block
    JOIN games g ON g.id=tb.current_game_id WHERE e.id=$1 AND t.team_key=$2`, [event.id, key])).rows[0];
}
async function version(command: string, key?: string) {
  if (["open-guess", "close-guess", "transfer-turn-lead", "resend-data"].includes(command)) return (await current(key)).game_version;
  return (await getPool().query<{ value: number }>(`SELECT CASE WHEN $2::text IS NULL THEN e.session_version ELSE tb.team_version END AS value
    FROM events e LEFT JOIN teams t ON t.event_id=e.id AND t.team_key=$2
    LEFT JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block WHERE e.id=$1`, [event.id, key ?? null])).rows[0].value;
}
async function admin(command: string, args: Record<string, unknown> = {}, key?: string, actor = host(), expectedVersion?: number, requestId = randomUUID()) {
  const body = { command, args, teamKey: key, expectedVersion: expectedVersion ?? await version(command, key) };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command: "admin", payload: body, requestId, receipt: true }, async ctx => {
    const result = await executeAdminCommand(ctx, body); await settleBlocks(ctx); return result;
  });
}
async function action(game: Game, command: string, args: Record<string, unknown> = {}, actor = sessions.get(game.turn_lead_participant_id)!) {
  const body = { gameId: game.id, gameVersion: game.game_version, ...args };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command, payload: body, requestId: randomUUID(), receipt: !["intro-ack", "ensemble-vote"].includes(command) }, async ctx => {
    const result = await executeGameCommand(ctx, command, body); await settleBlocks(ctx); return result;
  });
}
async function setup(studentCount = 5, teamCount = 1, start = true) {
  event = await createTestEvent({ studentCount, teamCount, moveCountPerTeam: teamCount === 1 ? 0 : 1 });
  await getPool().query("UPDATE events SET config_json=config_json || '{\"gameplayMode\":\"gm\"}'::jsonb WHERE id=$1", [event.id]);
  for (const id of [...event.students, ...event.operators]) sessions.set(id, await createTestSession(event, id));
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order+q)%6<3 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1`, [event.id]);
  await getPool().query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  success(await admin("assign-teams")); success(await admin("publish-teams"));
  if (start) success(await admin("start-game1"));
}
async function ensemble(key: string, votes = false) {
  let game = await current(key);
  if (game.phase !== "ENSEMBLE_SHARE") return;
  const student = game.member_ids.find(id => event.students.includes(id))!;
  expect(await action(game, "ensemble-shared", {}, sessions.get(student)!)).toMatchObject({ ok: false, status: 403 });
  success(await action(game, "ensemble-shared", {}, gm(key)), "GM opens vote");
  game = await current(key);
  if (votes) {
    const results = await Promise.all(game.member_ids.map(id => action(game, "ensemble-vote", { pickId: game.member_ids[0], revision: 0 }, sessions.get(id)!)));
    for (const result of results) success(result, "participant vote");
    expect((await getPool().query("SELECT count(*)::int AS n FROM ensemble_votes WHERE game_id=$1", [game.id])).rows[0].n).toBe(game.member_ids.length);
  }
  // Advance only the fixture clock. Production deadline settlement still runs.
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [game.id]);
  success(await runCommand({ slug: event.slug, tokenHash: gm(key).tokenHash, command: "sync", payload: {} }, async () => ({})));
  game = await current(key); expect(game.phase).toBe("ENSEMBLE_DISCUSS");
  expect(await action(game, "ensemble-end-discussion", {}, sessions.get(student)!)).toMatchObject({ ok: false, status: 403 });
  success(await action(game, "ensemble-end-discussion", {}, gm(key)), "GM ends discussion");
}
async function cardsTo(key: string, count: number, votes = false) {
  let game = await current(key);
  while (game.card_count < count || game.phase === "ENSEMBLE_SHARE") {
    if (game.phase === "ENSEMBLE_SHARE") await ensemble(key, votes);
    else success(await action(game, "next-card", { expectedCardCount: game.card_count }, gm(key)), "GM next card");
    game = await current(key);
  }
  return game;
}
async function acknowledge(game: Game) {
  const actor = sessions.get(game.turn_lead_participant_id)!;
  if (game.noise_picks.length) success(await action(game, "intro-ack", { introKey: "noise" }, actor));
  if (game.gt_status === "announced") success(await action(game, "intro-ack", { introKey: "ground_truth" }, actor));
}
async function finish(key = "A", minimum?: number, votes = false) {
  let game = await current(key);
  game = await cardsTo(key, minimum ?? (game.game_no === 1 ? 1 : 3), votes);
  await acknowledge(game);
  success(await admin("open-guess", {}, key, gm(key)), "GM opens guess");
  game = await current(key);
  // Integration fixture oracle only: verify the command with known answers.
  // The public DTO is independently checked below; player clients never receive it.
  expect(success(await action(game, "guess", { ownerPick: game.owner_participant_id, noisePicks: game.noise_picks }), "correct guess")).toEqual({ correct: true });
  return current(key);
}

it.each([4, 6])("T36 %i people retain private cards while GM controls every transition and guess gates survive refresh", async total => {
  await setup(total - 1);
  let game = await current();
  expect(game.member_ids).toHaveLength(total); expect(game.member_ids).toContain(event.operators[0]);
  expect(game.config_snapshot.gm).toEqual({ noiseCap: 0, groundTruth: false });
  const student = sessions.get(event.students[0])!;
  expect(await action(game, "next-card", { expectedCardCount: 1 }, student)).toMatchObject({ ok: false, status: 403 });
  expect(await action(game, "more-data", { expectedCardCount: 1 })).toMatchObject({ ok: false, status: 403 });
  expect(await admin("open-guess", {}, "A", student)).toMatchObject({ ok: false, status: 403 });
  expect(await action(game, "guess", { ownerPick: game.owner_participant_id, noisePicks: [] })).toMatchObject({ ok: false, code: "GM_GUESS_CLOSED" });
  success(await admin("open-guess", {}, "A")); game = await current();
  const lead = sessions.get(game.turn_lead_participant_id)!;
  const refreshed = await getState(event.slug, lead.tokenHash);
  expect(refreshed.game?.gm?.guessOpen).toBe(true); expect(refreshed.allowedActions).toContain("guess");
  const wrong = game.member_ids.find(id => id !== game.owner_participant_id)!;
  expect(success(await action(game, "guess", { ownerPick: wrong, noisePicks: [] }))).toEqual({ correct: false });
  expect((await getState(event.slug, lead.tokenHash)).game?.gm?.guessOpen).toBe(false);
  expect(await admin("open-guess", {}, "A")).toMatchObject({ ok: false, code: "GUESS_LOCKED" });
  success(await admin("pause", {}, "A")); game = await current();
  expect(await action(game, "next-card", { expectedCardCount: game.card_count }, host())).toMatchObject({ ok: false, code: "PAUSED" });
  expect(await admin("open-guess", {}, "A")).toMatchObject({ ok: false, code: "PAUSED" });
  success(await admin("resume", {}, "A"));
  game = await cardsTo("A", Math.ceil(total / 2), true);
  expect(game.guess_locked).toBe(false); expect(game.gm_guess_open).toBe(false);
  const oldLead = sessions.get(game.turn_lead_participant_id)!;
  const replacement = game.member_ids.find(id => id !== game.turn_lead_participant_id)!;
  success(await admin("open-guess", {}, "A"));
  success(await admin("transfer-turn-lead", { participantId: replacement }, "A"));
  game = await current(); expect(game.gm_guess_open).toBe(false);
  expect(await action(game, "guess", { ownerPick: game.owner_participant_id, noisePicks: [] }, oldLead)).toMatchObject({ ok: false, code: "NOT_TURN_LEAD" });
  success(await admin("open-guess", {}, "A")); success(await admin("close-guess", {}, "A"));
  expect((await getState(event.slug, sessions.get(replacement)!.tokenHash)).game?.gm?.guessOpen).toBe(false);
  game = await current();
  const cardRace = await Promise.all([action(game, "next-card", { expectedCardCount: game.card_count }, host()), action(game, "next-card", { expectedCardCount: game.card_count }, host())]);
  expect(cardRace.filter(result => result.ok)).toHaveLength(1);
  expect(cardRace.find(result => !result.ok)).toMatchObject({ ok: false, code: "STALE_VERSION" });
  expect((await current()).card_count).toBe(game.card_count + 1);
  // Force a diagnostic entry to prove participation never exposes server-only fallbacks.
  await getPool().query("INSERT INTO operation_logs(event_id,actor_participant_id,command) VALUES($1,$2,'COMMON_CARD_FALLBACK')", [event.id, event.operators[0]]);
  for (const actor of [host(), student]) {
    const view = await getState(event.slug, actor.tokenHash);
    expect(/owner_participant_id|is_noise|isNoise|true_option|trueOption|rng_seed|noise_slots|COMMON_CARD_FALLBACK/.test(JSON.stringify(view))).toBe(false);
    expect(view.game?.reveal).toBeUndefined();
    for (const card of view.game!.cards) {
      const delivered = card.recipients.some(person => person.participantId === view.me!.participantId);
      expect("text" in card).toBe(delivered); expect("question" in card).toBe(delivered);
    }
  }
  const ended = await finish(); expect(ended.phase).toBe("REVEALED");
  expect((await getState(event.slug, host().tokenHash)).event.phase).toBe("BLOCK");
  success(await admin("gm-next-game", { noiseCap: 2, groundTruth: false }, "A"));
  const early = await finish();
  expect(early.config_snapshot.gm.noiseCap).toBe(2);
  expect(early.card_count).toBe(3); expect(early.noise_picks.length).toBeLessThan(2);
}, 240_000);

it("T36 per-game caps 0/1/2 and optional Ground Truth remain valid beyond GAME 9", async () => {
  await setup();
  for (let number = 1; number <= 10; number++) {
    const cap = number === 1 ? 0 : number % 3;
    if (number > 1) success(await admin("gm-next-game", { noiseCap: cap, groundTruth: number === 4 }, "A"));
    let game = await current(); expect(game.game_no).toBe(number); expect(game.block_no).toBe(1);
    expect(game.config_snapshot.gm).toEqual({ noiseCap: cap, groundTruth: number === 4 });
    // Run one case to full exhaustion so caps are tested after all scheduled slots.
    const target = number === 2 ? 20 : number === 4 ? 4 : number === 1 ? 1 : 3;
    game = await finish("A", target);
    expect(game.noise_picks.length).toBeLessThanOrEqual(cap);
    if (!cap) expect(game.noise_picks).toEqual([]);
    if (number === 2) expect(game.noise_picks).toHaveLength(2);
    if (number === 4) expect(game.gt_status).toBe("announced");
  }
  expect((await getState(event.slug, host().tokenHash)).event.phase).toBe("BLOCK");
  success(await admin("end-session", { confirm: true }));
  for (const actor of sessions.values()) expect((await getState(event.slug, actor.tokenHash)).event.phase).toBe("ENDED");
}, 600_000);

it("T36 three independent teams rotate after unequal game counts only when every GM is ready, and can exceed three rounds", async () => {
  await setup(9, 3);
  expect(await admin("open-guess", {}, "B", gm("C"))).toMatchObject({ ok: false, status: 403 });
  await finish("A"); success(await admin("gm-next-game", { noiseCap: 0, groundTruth: false }, "A", gm("A"))); await finish("A");
  await finish("B");
  expect(await admin("request-rotation", {}, undefined, gm("B"))).toMatchObject({ ok: false, status: 403 });
  success(await admin("request-rotation"));
  expect(await admin("gm-next-game", {}, "A", gm("A"))).toMatchObject({ ok: false, code: "ROTATION_PENDING" });
  expect(await admin("rotation-ready", {}, "C", gm("C"))).toMatchObject({ ok: false, code: "WRONG_PHASE" });
  success(await admin("rotation-ready", {}, "A", gm("A")));
  success(await admin("cancel-rotation"));
  const cancelled = await getState(event.slug, host().tokenHash);
  expect(cancelled.event.rotationRequested).toBe(false);
  expect(cancelled.admin?.teams.every(team => !team.rotationReady)).toBe(true);
  expect(cancelled.admin?.teams.find(team => team.key === "A")?.phase).toBe("REVEAL");
  success(await admin("request-rotation"));
  success(await admin("rotation-ready", {}, "A", gm("A")));
  success(await admin("rotation-ready", {}, "B", gm("B")));
  expect((await getState(event.slug, host().tokenHash)).event.phase).toBe("BLOCK");
  expect(await admin("publish-next-block")).toMatchObject({ ok: false, code: "WRONG_PHASE" });
  await finish("C");
  const readyVersion = await version("rotation-ready", "C");
  const race = await Promise.all([admin("rotation-ready", {}, "C", gm("C"), readyVersion), admin("rotation-ready", {}, "C", gm("C"), readyVersion)]);
  expect(race.filter(result => result.ok)).toHaveLength(1);
  expect(race.find(result => !result.ok)).toMatchObject({ ok: false, status: 409 });
  expect((await getState(event.slug, host().tokenHash)).event.phase).toBe("BREAK");
  const before = (await getPool().query("SELECT participant_id,team_id FROM block_assignments WHERE event_id=$1 AND block_no=1", [event.id])).rows;
  const publishVersion = await version("publish-next-block");
  success(await admin("publish-next-block", {}, undefined, host(), publishVersion));
  expect(await admin("publish-next-block", {}, undefined, host(), publishVersion)).toMatchObject({ ok: false, code: "STALE_VERSION" });
  const after = (await getPool().query("SELECT participant_id,team_id FROM block_assignments WHERE event_id=$1 AND block_no=2", [event.id])).rows;
  expect(after).toHaveLength(12);
  const originalTeam = new Map(before.map(row => [row.participant_id, row.team_id]));
  expect(after.filter(row => event.students.includes(row.participant_id) && row.team_id !== originalTeam.get(row.participant_id))).toHaveLength(3);
  expect(after.filter(row => event.operators.includes(row.participant_id) && row.team_id !== originalTeam.get(row.participant_id))).toHaveLength(0);
  // Further rounds are GM choices, not a hard stop at block 3.
  for (let round = 2; round <= 3; round++) {
    for (const key of ["A", "B", "C"]) { success(await admin("start-block-game", { noiseCap: 0, groundTruth: false }, key, gm(key))); await finish(key); }
    success(await admin("request-rotation"));
    for (const key of ["A", "B", "C"]) success(await admin("rotation-ready", {}, key, gm(key)));
    success(await admin("publish-next-block"));
  }
  const state = await getState(event.slug, host().tokenHash);
  expect(state.event.currentBlock).toBe(4); expect(state.event.phase).toBe("BLOCK");
  success(await admin("start-block-game", { noiseCap: 0, groundTruth: false }, "A"));
  expect((await current()).block_no).toBe(4);
}, 600_000);

it("T36 GM mode preserves the 20-answer profile requirement", async () => {
  event = await createTestEvent({ studentCount: 3, teamCount: 1, moveCountPerTeam: 0 });
  await getPool().query("UPDATE events SET config_json=config_json || '{\"gameplayMode\":\"gm\"}'::jsonb WHERE id=$1", [event.id]);
  const participant = event.students[0], actor = await createTestSession(event, participant);
  await seedProfileAnswers(event, participant, 19);
  expect(await submitProfile(testRequest(event, actor))).toMatchObject({ ok: false, status: 422, code: "INCOMPLETE" });
  await seedProfileAnswers(event, participant, 20);
  success(await submitProfile(testRequest(event, actor)));
  expect((await getState(event.slug, actor.tokenHash)).me?.participantId).toBe(participant);
});

it("T36 delayed admin commands cannot reuse versions from a previous game or seat round", async () => {
  await setup(3);
  const initial = await current();
  const firstDone = await finish();
  success(await admin("gm-next-game", { noiseCap: 0, groundTruth: false }, "A"));
  expect((await current()).game_version).toBeGreaterThan(firstDone.game_version);
  expect(await admin("open-guess", {}, "A", host(), initial.game_version)).toMatchObject({ ok: false, code: "STALE_VERSION" });
  const secondDone = await finish();
  success(await admin("request-rotation")); success(await admin("rotation-ready", {}, "A"));
  const priorTeamVersion = await version("start-block-game", "A");
  success(await admin("publish-next-block"));
  expect(await version("start-block-game", "A")).toBeGreaterThan(priorTeamVersion);
  expect(await admin("start-block-game", { noiseCap: 0, groundTruth: false }, "A", host(), priorTeamVersion)).toMatchObject({ ok: false, code: "STALE_VERSION" });
  success(await admin("start-block-game", { noiseCap: 0, groundTruth: false }, "A"));
  expect((await current()).game_version).toBeGreaterThan(secondDone.game_version);
}, 180_000);

it("T36 GM presence and completed profile are required even for forced start, and rejected next-game settings roll back", async () => {
  await setup(3, 1, false);
  await getPool().query("UPDATE participants SET profile_completed_at=NULL WHERE id=$1 AND event_id=$2", [event.operators[0], event.id]);
  expect(await admin("start-game1", { force: true })).toMatchObject({ ok: false, code: "GM_NOT_READY" });
  const rejected = (await getPool().query(`SELECT e.phase,
    (SELECT count(*)::int FROM games WHERE event_id=e.id) AS games,
    (SELECT count(*)::int FROM team_blocks WHERE event_id=e.id) AS blocks
    FROM events e WHERE e.id=$1`, [event.id])).rows[0];
  expect(rejected).toEqual({ phase: "SETUP", games: 0, blocks: 0 });
  success(await submitProfile(testRequest(event, host())));
  success(await admin("start-game1")); await finish();
  const before = (await getPool().query("SELECT settings_json FROM teams WHERE event_id=$1 AND team_key='A'", [event.id])).rows[0].settings_json;
  success(await admin("mark-attendance", { participantId: event.operators[0], attendance: "absent" }));
  expect(await admin("gm-next-game", { noiseCap: 2, groundTruth: true }, "A")).toMatchObject({ ok: false, code: "GM_NOT_READY" });
  expect((await current()).game_no).toBe(1);
  const after = (await getPool().query("SELECT settings_json FROM teams WHERE event_id=$1 AND team_key='A'", [event.id])).rows[0].settings_json;
  expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
  success(await admin("mark-attendance", { participantId: event.operators[0], attendance: "present" }));
  success(await admin("gm-next-game", { noiseCap: 2, groundTruth: true }, "A"));
  const next = await current();
  expect(next.game_no).toBe(2); expect(next.member_ids).toContain(event.operators[0]);
  expect(next.config_snapshot.gm).toEqual({ noiseCap: 2, groundTruth: true });
}, 180_000);
