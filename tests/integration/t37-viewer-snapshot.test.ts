import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { runCommand, type CommandResult } from "@/server/db/tx";
import { snapshotSql, type EventSnapshot } from "@/server/db/snapshot";
import { buildPublicState } from "@/server/dto/state-dto";
import { executeAdminCommand } from "@/server/services/admin-service";
import { executeGameCommand } from "@/server/services/game-service";
import { settleBlocks } from "@/server/services/block-service";
import { cleanupTestEvent, createTestEvent, createTestSession, type TestEvent, type TestSession } from "./helpers";
import { fullSnapshotSql } from "./full-snapshot-oracle";

let event: TestEvent;
const sessions = new Map<string, TestSession>();
afterEach(async () => { if (event) await cleanupTestEvent(event); sessions.clear(); });
afterAll(closePool);

interface Game {
  id: string; game_no: number; phase: string; game_version: number; turn_lead_participant_id: string;
  owner_participant_id: string; gt_status: string; card_count: number; noise_picks: number[]; member_ids: string[];
}
const host = () => sessions.get(event.operators[0])!;
const gm = (key: string) => sessions.get(event.operators[key.charCodeAt(0) - 65])!;
function success<T>(result: CommandResult<T>, label = "command"): T {
  if (!result.ok) throw new Error(`${label}: ${result.status} ${result.code}`);
  return result.data;
}
async function current(key: string): Promise<Game> {
  return (await getPool().query<Game>(`SELECT g.*,
    (SELECT count(*)::int FROM data_cards WHERE game_id=g.id) AS card_count,
    ARRAY(SELECT card_no::int FROM data_cards WHERE game_id=g.id AND is_noise ORDER BY card_no) AS noise_picks,
    ARRAY(SELECT participant_id FROM game_members WHERE game_id=g.id ORDER BY participant_id) AS member_ids
    FROM events e JOIN teams t ON t.event_id=e.id JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block
    JOIN games g ON g.id=tb.current_game_id WHERE e.id=$1 AND t.team_key=$2`, [event.id, key])).rows[0];
}
async function version(command: string, key?: string) {
  if (["open-guess", "close-guess", "transfer-turn-lead", "resend-data"].includes(command)) return (await current(key!)).game_version;
  return (await getPool().query<{ value: number }>(`SELECT CASE WHEN $2::text IS NULL THEN e.session_version ELSE tb.team_version END AS value
    FROM events e LEFT JOIN teams t ON t.event_id=e.id AND t.team_key=$2
    LEFT JOIN team_blocks tb ON tb.team_id=t.id AND tb.block_no=e.current_block WHERE e.id=$1`, [event.id, key ?? null])).rows[0].value;
}
async function admin(command: string, args: Record<string, unknown> = {}, key?: string, actor = host()) {
  const body = { command, args, teamKey: key, expectedVersion: await version(command, key) };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command: "admin", payload: body, requestId: randomUUID(), receipt: true }, async ctx => {
    const result = await executeAdminCommand(ctx, body); await settleBlocks(ctx); return result;
  });
}
async function action(game: Game, command: string, args: Record<string, unknown>, actor: TestSession) {
  const body = { gameId: game.id, gameVersion: game.game_version, ...args };
  return runCommand({ slug: event.slug, tokenHash: actor.tokenHash, command, payload: body, requestId: randomUUID(), receipt: !["intro-ack", "ensemble-vote"].includes(command) }, async ctx => {
    const result = await executeGameCommand(ctx, command, body); await settleBlocks(ctx); return result;
  });
}
async function nextCard(key: string) {
  const game = await current(key);
  success(await action(game, "next-card", { expectedCardCount: game.card_count }, gm(key)), `${key} next card`);
  return current(key);
}
async function passEnsemble(key: string) {
  let game = await current(key);
  success(await action(game, "ensemble-shared", {}, gm(key)), `${key} opens vote`);
  game = await current(key);
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [game.id]);
  success(await runCommand({ slug: event.slug, tokenHash: gm(key).tokenHash, command: "sync", payload: {} }, async () => ({})));
  game = await current(key);
  success(await action(game, "ensemble-end-discussion", {}, gm(key)), `${key} ends discussion`);
}
async function finish(key: string, minimum: number) {
  let game = await current(key);
  while (game.card_count < minimum || game.phase === "ENSEMBLE_SHARE") {
    if (game.phase === "ENSEMBLE_SHARE") await passEnsemble(key);
    else await nextCard(key);
    game = await current(key);
  }
  const lead = sessions.get(game.turn_lead_participant_id)!;
  if (game.noise_picks.length) success(await action(game, "intro-ack", { introKey: "noise" }, lead));
  if (game.gt_status === "announced") success(await action(game, "intro-ack", { introKey: "ground_truth" }, lead));
  success(await admin("open-guess", {}, key, gm(key)), `${key} opens guess`);
  game = await current(key);
  // Fixture oracle only: the command verifies the known answer; DTOs are compared below.
  expect(success(await action(game, "guess", { ownerPick: game.owner_participant_id, noisePicks: game.noise_picks }, lead))).toEqual({ correct: true });
}

type Viewer = { label: string; role: "student" | "operator" | "anonymous" | "none"; tokenHash: string };
type Row = { snapshot: EventSnapshot; bytes: number };
const sizes: { checkpoint: string; role: string; full: number; slim: number }[] = [];
function outcome(snapshot: EventSnapshot) {
  try { return { ok: true as const, state: buildPublicState(snapshot) }; }
  catch (error) { const e = error as { status?: number; code?: string; message?: string }; return { ok: false as const, error: `${e.status}:${e.code}:${e.message}` }; }
}
async function compareAll(checkpoint: string, viewers: Viewer[]) {
  for (const viewer of viewers) {
    const client = await getPool().connect();
    let full: Row, slim: Row;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      full = (await client.query<Row>(`SELECT q.snapshot,octet_length(q.snapshot::text) AS bytes FROM (${fullSnapshotSql}) q`, [event.slug, viewer.tokenHash])).rows[0];
      slim = (await client.query<Row>(`SELECT q.snapshot,octet_length(q.snapshot::text) AS bytes FROM (${snapshotSql}) q`, [event.slug, viewer.tokenHash])).rows[0];
      await client.query("COMMIT");
    } finally { client.release(); }
    slim.snapshot.now = full.snapshot.now;
    const expected = outcome(full.snapshot), actual = outcome(slim.snapshot);
    expect(actual, `${checkpoint} / ${viewer.label}`).toEqual(expected);
    // A snapshot for someone else's session must never carry more rows than the full one.
    expect(slim.bytes, `${checkpoint} / ${viewer.label} size`).toBeLessThanOrEqual(full.bytes);
    sizes.push({ checkpoint, role: viewer.role, full: Number(full.bytes), slim: Number(slim.bytes) });
  }
}

it("T37 viewer-scoped snapshot yields the full snapshot's DTO for every viewer through a 21-person GM session", async () => {
  event = await createTestEvent({ studentCount: 18, teamCount: 3, moveCountPerTeam: 3 });
  await getPool().query("UPDATE events SET config_json=config_json || '{\"gameplayMode\":\"gm\"}'::jsonb WHERE id=$1", [event.id]);
  // A revoked earlier device and an anonymous visitor exercise session aggregation.
  const stale = await createTestSession(event, event.students[0]);
  await getPool().query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", [stale.id]);
  for (const id of [...event.students, ...event.operators]) sessions.set(id, await createTestSession(event, id));
  const anonymous = await createTestSession(event);
  const viewers: Viewer[] = [
    ...event.students.map((id, index) => ({ label: `student${index + 1}`, role: "student" as const, tokenHash: sessions.get(id)!.tokenHash })),
    ...event.operators.map((id, index) => ({ label: `operator${String.fromCharCode(65 + index)}`, role: "operator" as const, tokenHash: sessions.get(id)!.tokenHash })),
    { label: "anonymous", role: "anonymous", tokenHash: anonymous.tokenHash },
    { label: "no session", role: "none", tokenHash: "0".repeat(64) },
  ];

  await compareAll("SETUP empty", viewers);
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order+q)%5<2 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1 AND p.roster_order%2=0`, [event.id]);
  await compareAll("SETUP partial answers", viewers);
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(q::text,2,'0'),CASE WHEN (p.roster_order*3+q)%7<3 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) q WHERE p.event_id=$1 ON CONFLICT (participant_id,question_id) DO NOTHING`, [event.id]);
  await getPool().query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  await getPool().query("INSERT INTO intro_seen(participant_id,intro_key) VALUES($1,'tutorial'),($2,'tutorial')", [event.students[3], event.operators[1]]);
  success(await admin("assign-teams")); await compareAll("SETUP draft", viewers);
  success(await admin("publish-teams")); await compareAll("SETUP published", viewers);
  success(await admin("start-game1")); await compareAll("GAME 1 first card", viewers);

  // Team A reaches Ensemble: share, vote with an expired deadline (needsSync for all), discuss.
  let game = await current("A");
  while (game.phase !== "ENSEMBLE_SHARE" && game.card_count < 7) game = await nextCard("A");
  expect(game.phase).toBe("ENSEMBLE_SHARE");
  await compareAll("A ensemble share", viewers);
  success(await action(game, "ensemble-shared", {}, gm("A")));
  game = await current("A");
  for (const id of game.member_ids.slice(0, 4)) success(await action(game, "ensemble-vote", { pickId: game.member_ids[1], revision: 0 }, sessions.get(id)!));
  await compareAll("A ensemble vote", viewers);
  await getPool().query("UPDATE games SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [game.id]);
  await compareAll("A vote deadline passed", viewers);
  success(await runCommand({ slug: event.slug, tokenHash: gm("A").tokenHash, command: "sync", payload: {} }, async () => ({})));
  await compareAll("A ensemble discuss", viewers);
  game = await current("A");
  success(await action(game, "ensemble-end-discussion", {}, gm("A")));

  // Team B pauses, team C resends a card and changes Turn Lead.
  await nextCard("B"); success(await admin("pause", {}, "B", gm("B")));
  game = await current("C");
  const cRecipient = game.member_ids.find(id => id !== game.turn_lead_participant_id)!;
  success(await admin("resend-data", { cardNo: 1, participantId: cRecipient }, "C", gm("C")));
  success(await admin("transfer-turn-lead", { participantId: cRecipient }, "C", gm("C")));
  await compareAll("B paused, C resend + lead change", viewers);
  success(await admin("resume", {}, "B", gm("B")));

  await finish("A", 1); await compareAll("A revealed", viewers);
  success(await admin("gm-next-game", { noiseCap: 2, groundTruth: true }, "A", gm("A")));
  game = await current("A");
  while (game.card_count < 5 && game.phase !== "ENSEMBLE_SHARE") game = await nextCard("A");
  await compareAll("A game 2 Noise + Ground Truth", viewers);
  await finish("A", 3); await finish("B", 1); await finish("C", 1);
  await compareAll("all revealed", viewers);

  success(await admin("request-rotation")); await compareAll("rotation requested", viewers);
  success(await admin("rotation-ready", {}, "A", gm("A"))); success(await admin("rotation-ready", {}, "B", gm("B")));
  await compareAll("two teams ready", viewers);
  success(await admin("rotation-ready", {}, "C", gm("C"))); await compareAll("BREAK", viewers);
  success(await admin("publish-next-block")); await compareAll("block 2 seating", viewers);
  success(await admin("start-block-game", { noiseCap: 1, groundTruth: false }, "A", gm("A")));
  await compareAll("block 2 A playing", viewers);
  success(await admin("end-session", { confirm: true })); await compareAll("ENDED", viewers);

  const table = new Map<string, { full: number; slim: number; n: number; maxSlim: number }>();
  for (const row of sizes.filter(r => r.role === "student" || r.role === "operator")) {
    const entry = table.get(`${row.checkpoint} | ${row.role}`) ?? { full: 0, slim: 0, n: 0, maxSlim: 0 };
    entry.full += row.full; entry.slim += row.slim; entry.n++; entry.maxSlim = Math.max(entry.maxSlim, row.slim);
    table.set(`${row.checkpoint} | ${row.role}`, entry);
  }
  console.log(["checkpoint | role | avg full bytes | avg slim bytes | max slim bytes",
    ...[...table].map(([key, v]) => `${key} | ${Math.round(v.full / v.n)} | ${Math.round(v.slim / v.n)} | ${v.maxSlim}`)].join("\n"));
  const worst = (role: string) => Math.max(...sizes.filter(r => r.role === role).map(r => r.slim));
  expect(worst("student")).toBeLessThan(36_000);
  expect(worst("operator")).toBeLessThan(50_000);
}, 900_000);
