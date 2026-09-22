import { loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker, safeFailure } from "./helpers/database.mjs";
import { readOptions } from "./helpers/event-admin.mjs";
import { restartSyntheticRehearsal } from "../src/server/rehearsal/reset-fixture.mjs";

let client;
try {
  const options = readOptions(process.argv.slice(2), ["--slug", "--confirm"], ["--synthetic"]);
  if (!options.synthetic || options.confirm !== "RESET" || !options.slug) throw new Error("An explicit synthetic target and RESET confirmation are required.");
  loadLocalEnvironment();
  client = await openDevelopmentClient();
  await assertDevelopmentMarker(client);
  await client.query("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
  await restartSyntheticRehearsal(client, { slug: options.slug });
  await client.query("COMMIT");
  console.log("Synthetic rehearsal restarted: SETUP, 21 complete profiles, existing identities and operator codes preserved. All previous sessions revoked.");
} catch {
  if (client) await client.query("ROLLBACK").catch(() => {});
  safeFailure("Synthetic rehearsal restart");
} finally { if (client) await client.end().catch(() => {}); }
