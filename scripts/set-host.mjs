import { parseTargetFlags, loadTargetEnvironment, openTargetClient, assertEnvironmentMarker, safeFailure } from "./helpers/database.mjs";
import { readOptions, validateSlug, lockEvent } from "./helpers/event-admin.mjs";
let client;
try {
  const target = parseTargetFlags(process.argv.slice(2));
  const options = readOptions(target.args, ["--slug", "--name"], ["--synthetic"]);
  const slug = validateSlug(target, options.slug, options);
  if (!options.name) throw new Error("An exact operator name is required.");
  loadTargetEnvironment(target);
  client = await openTargetClient(target);
  await assertEnvironmentMarker(client, target.environment);
  await client.query("BEGIN");
  const event = await lockEvent(client, slug);
  const operator = (await client.query("SELECT id FROM participants WHERE event_id=$1 AND display_name=$2 AND role='operator' AND active FOR UPDATE", [event.id, options.name])).rows[0];
  if (!operator) throw new Error("The new host must be an active operator.");
  await client.query("UPDATE events SET host_participant_id=$2,session_version=session_version+1 WHERE id=$1", [event.id, operator.id]);
  await client.query("INSERT INTO operation_logs(event_id,command,target) VALUES($1,'set-host',$2)", [event.id, operator.id]);
  await client.query("COMMIT");
  console.log("Host changed. Existing sessions pick up the new permissions on their next request.");
} catch { if (client) await client.query("ROLLBACK").catch(() => {}); safeFailure("Host transfer"); }
finally { if (client) await client.end().catch(() => {}); }
