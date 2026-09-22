import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import {
  loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker, safeFailure,
} from "./helpers/database.mjs";

const scrypt = promisify(scryptCallback);
let client;
let transactionOpen = false;
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--quiet")) throw new Error("Unexpected seed option.");
  const quiet = args.includes("--quiet");
  loadLocalEnvironment();
  client = await openDevelopmentClient();
  await assertDevelopmentMarker(client);
  const slug = `dev-${randomBytes(4).toString("hex")}`;
  // These are synthetic identities only. No real roster or operator code is used.
  const operators = [];
  for (const [index, suffix] of ["A", "B", "C"].entries()) {
    const code = randomBytes(12).toString("base64url");
    const salt = randomBytes(16);
    const derived = await scrypt(code, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    operators.push({
      name: `운영진${suffix}`, order: 19 + index, code,
      codeHash: `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`,
    });
  }
  const config = {
    studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
    operatorTeamByName: { "운영진A": "A", "운영진B": "B", "운영진C": "C" },
    blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24,
    presenceWindowSeconds: 15, pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30,
  };
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SET LOCAL statement_timeout = '8s'");
  const event = await client.query(`INSERT INTO events(slug, title, config_json, content_version)
    VALUES ($1, $2, $3::jsonb, $4) RETURNING id`, [slug, "KANT Mingle · 개발 리허설", JSON.stringify(config), "2026-09-22.1"]);
  const eventId = event.rows[0].id;
  for (let number = 1; number <= 18; number += 1) {
    await client.query(`INSERT INTO participants(event_id, display_name, role, roster_order)
      VALUES ($1, $2, 'student', $3)`, [eventId, `학생${String(number).padStart(2, "0")}`, number]);
  }
  for (const [index, operator] of operators.entries()) {
    const participant = await client.query(`INSERT INTO participants(event_id, display_name, role, roster_order, operator_code_hash)
      VALUES ($1, $2, 'operator', $3, $4) RETURNING id`, [eventId, operator.name, operator.order, operator.codeHash]);
    if (index === 0) await client.query("UPDATE events SET host_participant_id = $1 WHERE id = $2", [participant.rows[0].id, eventId]);
  }
  await client.query("COMMIT");
  transactionOpen = false;
  console.log(`Synthetic development event created: ${slug}`);
  console.log(`Participant route: /e/${slug}`);
  if (!quiet) {
    console.log("Synthetic operator codes (displayed once; do not commit or log them):");
    for (const operator of operators) console.log(`${operator.name}: ${operator.code}`);
  }
} catch {
  if (transactionOpen && client) await client.query("ROLLBACK").catch(() => {});
  safeFailure("Development seed");
} finally {
  if (client) await client.end().catch(() => {});
}
