import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { claimParticipant } from "@/server/services/registration";
import { saveProfileAnswer } from "@/server/services/profile";
import { DEFAULT_TEAM_SETTINGS } from "@/server/game/settings";
import { createTestEvent, createTestSession, cleanupTestEvent, testRequest, seedProfileAnswers, type TestEvent } from "./helpers";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T02 identity recovery preserves profile, seat, received cards and Turn Lead", async () => {
  const person = event.students[0];
  const old = await createTestSession(event, person);
  await seedProfileAnswers(event, person);
  const team = randomUUID(), block = randomUUID(), game = randomUUID(), card = randomUUID();
  const pool = getPool();
  await pool.query("INSERT INTO teams(id,event_id,team_key,operator_participant_id) VALUES($1,$2,'A',$3)", [team, event.id, event.operators[0]]);
  await pool.query("INSERT INTO block_assignments(event_id,block_no,participant_id,team_id,seat_no) VALUES($1,1,$2,$3,1)", [event.id, person, team]);
  await pool.query("INSERT INTO team_blocks(id,event_id,block_no,team_id,phase,settings_json) VALUES($1,$2,1,$3,'IN_GAME',$4)", [block, event.id, team, JSON.stringify(DEFAULT_TEAM_SETTINGS)]);
  await pool.query(`INSERT INTO games(id,event_id,team_id,team_block_id,block_no,game_no,config_snapshot,owner_participant_id,rng_seed,phase,turn_lead_participant_id)
    VALUES($1,$2,$3,$4,1,1,$5,$6,repeat('a',32),'TURN',$6)`, [game, event.id, team, block, JSON.stringify(DEFAULT_TEAM_SETTINGS), person]);
  await pool.query("INSERT INTO game_members(game_id,participant_id) VALUES($1,$2)", [game, person]);
  await pool.query("INSERT INTO data_cards(id,game_id,card_no,question_id,displayed_option,true_option,is_noise) VALUES($1,$2,1,'Q01','A','A',false)", [card, game]);
  await pool.query("INSERT INTO card_deliveries(card_id,participant_id,reason) VALUES($1,$2,'initial')", [card, person]);
  // This is the identity-recovery half of T02; the admin unlock authorization is tested with T04.
  await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", [old.id]);
  const next = await createTestSession(event);
  expect((await claimParticipant(testRequest(event, next), person)).ok).toBe(true);
  expect(await saveProfileAnswer(testRequest(event, old), { questionId: "Q01", option: "B", revision: 1 }))
    .toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  expect((await pool.query("SELECT COUNT(*)::int AS n FROM profile_answers WHERE participant_id=$1", [person])).rows[0].n).toBe(20);
  expect((await pool.query("SELECT team_id,seat_no FROM block_assignments WHERE participant_id=$1", [person])).rows[0]).toEqual({ team_id: team, seat_no: 1 });
  expect((await pool.query("SELECT card_id FROM card_deliveries WHERE participant_id=$1", [person])).rows[0].card_id).toBe(card);
  expect((await pool.query("SELECT turn_lead_participant_id FROM games WHERE id=$1", [game])).rows[0].turn_lead_participant_id).toBe(person);
});

it("T02 a command waiting behind a session revocation rechecks authentication after the event lock", async () => {
  const session = await createTestSession(event, event.students[0]);
  const lock = await getPool().connect();
  let pending: ReturnType<typeof saveProfileAnswer> | undefined;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
    pending = saveProfileAnswer(testRequest(event, session), { questionId: "Q01", option: "A", revision: 0 });
    await lock.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", [session.id]);
    await lock.query("COMMIT");
    expect(await pending).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
    if (pending) await pending;
  }
});
