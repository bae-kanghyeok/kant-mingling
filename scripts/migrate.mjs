import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  projectRoot, parseTargetFlags, loadTargetEnvironment, openTargetClient,
  assertEnvironmentMarker, ensureEnvironmentMarker, safeFailure,
} from "./helpers/database.mjs";

let client;
let transactionOpen = false;
let migrationLock = false;
try {
  const target = parseTargetFlags(process.argv.slice(2));
  if (target.args.length) throw new Error("Unexpected migration arguments.");
  loadTargetEnvironment(target);
  client = await openTargetClient(target, { direct: true });
  await assertEnvironmentMarker(client, target.environment, { allowMissing: true });
  // A dedicated, unpooled connection keeps the advisory lock for the whole run.
  await client.query("SELECT pg_advisory_lock(hashtext('km_migrate'))");
  migrationLock = true;
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await ensureEnvironmentMarker(client, target.environment);
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const folder = resolve(projectRoot, "db/migrations");
  const files = (await readdir(folder)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort();
  if (files.length === 0) throw new Error("No migrations were found.");
  const applied = await client.query("SELECT version, checksum FROM public.schema_migrations ORDER BY version");
  const known = new Map(applied.rows.map((row) => [row.version, row.checksum]));
  for (const version of known.keys()) {
    if (!files.includes(version)) throw new Error("An applied migration is missing locally.");
  }
  let changes = 0;
  for (const filename of files) {
    const sql = await readFile(resolve(folder, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (known.has(filename)) {
      if (known.get(filename) !== checksum) throw new Error("An applied migration checksum changed.");
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)", [filename, checksum]);
    changes += 1;
  }
  await client.query("COMMIT");
  transactionOpen = false;
  console.log(`${target.environment} migrations verified. Applied: ${changes}.`);
} catch {
  if (transactionOpen && client) await client.query("ROLLBACK").catch(() => {});
  safeFailure("Migration");
} finally {
  if (migrationLock && client) await client.query("SELECT pg_advisory_unlock(hashtext('km_migrate'))").catch(() => {});
  if (client) await client.end().catch(() => {});
}
