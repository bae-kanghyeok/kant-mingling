import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  projectRoot, loadLocalEnvironment, openDevelopmentClient,
  assertDevelopmentMarker, safeFailure,
} from "./helpers/database.mjs";

let client;
try {
  if (process.argv.length > 2) throw new Error("Unexpected database-test option.");
  loadLocalEnvironment();
  client = await openDevelopmentClient();
  await assertDevelopmentMarker(client);
  await client.end();
  client = undefined;
  const child = spawn(process.execPath, [resolve(projectRoot, "node_modules/vitest/vitest.mjs"), "run", "tests/integration"], {
    cwd: projectRoot,
    env: { ...process.env, ALLOW_DB_TESTS: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
} catch {
  safeFailure("Database tests");
} finally {
  if (client) await client.end().catch(() => {});
}
