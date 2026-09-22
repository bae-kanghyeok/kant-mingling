import { parseTargetFlags, loadTargetEnvironment, openTargetClient, assertEnvironmentMarker, safeFailure } from "./helpers/database.mjs";
import { readOptions, validateSlug, lockEvent, newOperatorCode } from "./helpers/event-admin.mjs";
let client;
try {
  const target = parseTargetFlags(process.argv.slice(2));
  const options = readOptions(target.args, ["--slug", "--name"], ["--synthetic", "--quiet"]);
  const slug = validateSlug(target, options.slug, options);
  if (target.environment === "production" && options.quiet) throw new Error("Production codes must be collected once by the authorized operator.");
  loadTargetEnvironment(target);
  client = await openTargetClient(target);
  await assertEnvironmentMarker(client, target.environment);
  await client.query("BEGIN");
  const event = await lockEvent(client, slug);
  const operators = (await client.query(`SELECT id,display_name FROM participants WHERE event_id=$1 AND role='operator' AND active
    AND ($2::text IS NULL OR display_name=$2) ORDER BY roster_order FOR UPDATE`, [event.id, options.name ?? null])).rows;
  if (!operators.length) throw new Error("No matching active operator exists.");
  const issued = [];
  for (const operator of operators) {
    const { code, hash } = await newOperatorCode();
    await client.query("UPDATE participants SET operator_code_hash=$2 WHERE id=$1", [operator.id, hash]);
    await client.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE participant_id=$1 AND revoked_at IS NULL", [operator.id]);
    await client.query("INSERT INTO operation_logs(event_id,command,target) VALUES($1,'issue-operator-code',$2)", [event.id, operator.id]);
    issued.push({ name: operator.display_name, code });
  }
  await client.query("UPDATE events SET session_version=session_version+1 WHERE id=$1", [event.id]);
  await client.query("COMMIT");
  console.log(`Operator credentials rotated: ${issued.length}. Prior operator sessions were revoked.`);
  if (!options.quiet) {
    console.log("Codes are shown once. Do not redirect this output to a file, logs, or chat.");
    for (const operator of issued) console.log(`${operator.name}: ${operator.code}`);
  }
} catch { if (client) await client.query("ROLLBACK").catch(() => {}); safeFailure("Operator credential rotation"); }
finally { if (client) await client.end().catch(() => {}); }
