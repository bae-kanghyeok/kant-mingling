import {
  parseTargetFlags, loadTargetEnvironment, openTargetClient, ensureEnvironmentMarker, safeFailure,
} from "./helpers/database.mjs";

let client;
try {
  const target = parseTargetFlags(process.argv.slice(2));
  if (target.args.length !== 1 || target.args[0] !== target.environment) throw new Error("The named environment must match the explicit target.");
  loadTargetEnvironment(target);
  client = await openTargetClient(target, { direct: true });
  await client.query("BEGIN");
  await ensureEnvironmentMarker(client, target.environment);
  await client.query("COMMIT");
  console.log(`${target.environment} environment marker verified.`);
} catch {
  if (client) await client.query("ROLLBACK").catch(() => {});
  safeFailure("Environment marking");
} finally {
  if (client) await client.end().catch(() => {});
}
