import { randomBytes, randomUUID } from "node:crypto";
import { getPool } from "@/server/db/pool";
import { createSessionToken, hashSessionToken } from "@/server/auth/session";
import { hashOperatorCode } from "@/server/auth/operator-code";
import { DEFAULT_GLOBAL_CONFIG } from "@/server/game/settings";
import { CONTENT_VERSION } from "@/content/catalog";
import { developmentConnectionString } from "../../scripts/helpers/database.mjs";

export interface TestEvent { id: string; slug: string; students: string[]; operators: string[]; operatorCodes: string[] }
export interface TestSession { id: string; token: string; tokenHash: string }

export async function assertDevelopmentDatabase() {
  if (process.env.ALLOW_DB_TESTS !== "1") throw new Error("Run integration tests using npm run test:db");
  // Share the CLI allowlist; never open a pool before its explicit pin is checked.
  developmentConnectionString();
  const marker = await getPool().query("SELECT name FROM app_environment WHERE singleton = true");
  if (marker.rows[0]?.name !== "development") throw new Error("Development database marker required.");
}

export async function createTestEvent(): Promise<TestEvent> {
  await assertDevelopmentDatabase();
  const event = { id: randomUUID(), slug: `test-${randomUUID()}`, students: Array.from({ length: 18 }, () => randomUUID()),
    operators: Array.from({ length: 3 }, () => randomUUID()), operatorCodes: Array.from({ length: 3 }, () => randomBytes(18).toString("base64url")) };
  const codes = await Promise.all(event.operatorCodes.map(hashOperatorCode));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO events(id,slug,config_json,content_version) VALUES($1,$2,$3,$4)",
      [event.id, event.slug, JSON.stringify({ ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: { "운영진A": "A", "운영진B": "B", "운영진C": "C" } }), CONTENT_VERSION]);
    const roster = [...event.students.map((id, index) => ({ id, name: `학생${String(index + 1).padStart(2, "0")}`, role: "student", order: index + 1, hash: null })),
      ...event.operators.map((id, index) => ({ id, name: `운영진${String.fromCharCode(65 + index)}`, role: "operator", order: index + 19, hash: codes[index] }))];
    await client.query(`INSERT INTO participants(id,event_id,display_name,role,roster_order,operator_code_hash)
      SELECT x.id,$1,x.name,x.role,x.ord,x.hash FROM jsonb_to_recordset($2::jsonb)
      AS x(id uuid,name text,role text,ord smallint,hash text)`,
    [event.id, JSON.stringify(roster.map(({ order, ...person }) => ({ ...person, ord: order })))]);
    await client.query("UPDATE events SET host_participant_id=$1 WHERE id=$2", [event.operators[0], event.id]);
    await client.query("COMMIT");
    return event;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function cleanupTestEvent(event: TestEvent) {
  if (!event.slug.startsWith("test-")) throw new Error("Only a test fixture may be removed.");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const match = await client.query("SELECT id FROM events WHERE id=$1 AND slug=$2 FOR UPDATE", [event.id, event.slug]);
    if (match.rowCount) {
      await client.query("DELETE FROM ground_truths WHERE game_id IN (SELECT id FROM games WHERE event_id=$1)", [event.id]);
      await client.query("UPDATE team_blocks SET current_game_id=NULL WHERE event_id=$1", [event.id]);
      await client.query("DELETE FROM games WHERE event_id=$1", [event.id]);
      await client.query("DELETE FROM team_blocks WHERE event_id=$1", [event.id]);
      await client.query("DELETE FROM teams WHERE event_id=$1", [event.id]);
      await client.query("DELETE FROM events WHERE id=$1", [event.id]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function createTestSession(event: TestEvent, participantId?: string): Promise<TestSession> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const result = await getPool().query<{ id: string }>(`INSERT INTO sessions(event_id,participant_id,token_hash,expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') RETURNING id`, [event.id, participantId ?? null, tokenHash]);
  return { id: result.rows[0].id, token, tokenHash };
}

export function testRequest(event: TestEvent, session: TestSession) {
  return { slug: event.slug, tokenHash: session.tokenHash, requestId: randomUUID() };
}

export async function seedProfileAnswers(event: TestEvent, participantId: string, count = 20) {
  if (!Number.isInteger(count) || count < 0 || count > 20) throw new Error("Invalid fixture answer count.");
  await getPool().query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT $1,$2,'Q'||lpad(n::text,2,'0'),'A',1 FROM generate_series(1,$3::integer) n
    ON CONFLICT (participant_id,question_id) DO NOTHING`, [event.id, participantId, count]);
}
