import { randomUUID } from "node:crypto";
import { getPool } from "@/server/db/pool";
import { DEFAULT_TEAM_SETTINGS } from "@/server/game/settings";
import { createTestSession, type TestEvent } from "./helpers";

export async function createVisibilityFixture(event: TestEvent) {
  const pool = getPool();
  await pool.query("UPDATE events SET phase='BLOCK',current_block=1,teams_published_at=clock_timestamp() WHERE id=$1", [event.id]);
  await pool.query("UPDATE participants SET attendance='present',profile_completed_at=clock_timestamp(),profile_locked_at=clock_timestamp() WHERE event_id=$1", [event.id]);
  await pool.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(n::text,2,'0'),'A',1 FROM participants p CROSS JOIN generate_series(1,20) n WHERE p.event_id=$1`, [event.id]);
  const groups = [0, 1, 2].map((index) => ({ team: randomUUID(), block: randomUUID(), game: randomUUID(), index,
    people: [...event.students.slice(index * 6, index * 6 + 6), event.operators[index]], cards: [randomUUID(), randomUUID(), randomUUID()] }));
  await Promise.all(groups.map(async (group) => {
    await pool.query("INSERT INTO teams(id,event_id,team_key,operator_participant_id,settings_json) VALUES($1,$2,$3,$4,$5)",
      [group.team, event.id, String.fromCharCode(65 + group.index), event.operators[group.index], JSON.stringify(DEFAULT_TEAM_SETTINGS)]);
    await pool.query(`INSERT INTO block_assignments(event_id,block_no,participant_id,team_id,seat_no)
      SELECT $1,1,x.id,$2,CASE WHEN x.n=7 THEN 0 ELSE x.n END FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id,n)`, [event.id, group.team, group.people]);
    await pool.query("INSERT INTO team_blocks(id,event_id,block_no,team_id,phase,settings_json,started_at) VALUES($1,$2,1,$3,'IN_GAME',$4,clock_timestamp())",
      [group.block, event.id, group.team, JSON.stringify(DEFAULT_TEAM_SETTINGS)]);
    await pool.query(`INSERT INTO games(id,event_id,team_id,team_block_id,block_no,game_no,config_snapshot,owner_participant_id,rng_seed,phase,
      turn_lead_participant_id,ensemble_trigger_no,ensemble_sharer_id) VALUES($1,$2,$3,$4,1,2,$5,$6,repeat('b',32),'TURN',$7,3,$7)`,
      [group.game, event.id, group.team, group.block, JSON.stringify(DEFAULT_TEAM_SETTINGS), group.people[1], group.people[2]]);
    await pool.query("UPDATE team_blocks SET current_game_id=$2 WHERE id=$1", [group.block, group.game]);
    await pool.query("INSERT INTO game_members(game_id,participant_id) SELECT $1,unnest($2::uuid[])", [group.game, group.people]);
    const base = group.index * 3;
    await pool.query(`INSERT INTO data_cards(id,game_id,card_no,question_id,displayed_option,true_option,is_noise)
      SELECT x.id,$1,x.n,'Q'||lpad(($3::integer+x.n)::text,2,'0'),CASE WHEN x.n=2 THEN 'B' ELSE 'A' END,'A',x.n=2
      FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id,n)`, [group.game, group.cards, base]);
    await pool.query(`INSERT INTO card_deliveries(card_id,participant_id,reason) VALUES($1,$2,'initial'),($3,$4,'initial'),($5,$6,'initial')`,
      [group.cards[0], group.people[0], group.cards[1], group.people[2], group.cards[2], group.people[6]]);
    await pool.query("INSERT INTO ground_truths(game_id,card_id) VALUES($1,$2)", [group.game, group.cards[2]]);
    await pool.query("INSERT INTO ensemble_votes(game_id,voter_id,pick_id,revision) VALUES($1,$2,$3,1)", [group.game, group.people[0], group.people[1]]);
  }));
  const sessions = await Promise.all([...event.students, ...event.operators].map((id) => createTestSession(event, id)));
  return { groups, sessions, byPerson: new Map([...event.students, ...event.operators].map((id, index) => [id, sessions[index]])) };
}
