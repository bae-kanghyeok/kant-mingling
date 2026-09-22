import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function pinnedEndpoints() {
  const development = process.env.DEVELOPMENT_NEON_ENDPOINT;
  const production = process.env.PRODUCTION_NEON_ENDPOINT;
  const valid = (value) => typeof value === "string" && /^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !value.endsWith("-pooler");
  if (!valid(development)) {
    throw new Error("Pin the independently verified DEVELOPMENT_NEON_ENDPOINT first.");
  }
  if (production && (!valid(production) || production === development)) {
    throw new Error("Production and development must use different independently verified endpoints.");
  }
  return { development, production };
}

export function loadLocalEnvironment() {
  const envPath = resolve(projectRoot, ".env.local");
  if (existsSync(envPath)) loadEnvFile(envPath);
}

/** Production targets require two deliberate flags and a separately pinned endpoint. */
export function parseTargetFlags(args) {
  const production = args.includes("--production");
  const approved = args.includes("--approved");
  if (production !== approved || args.filter((arg) => arg === "--production").length > 1 || args.filter((arg) => arg === "--approved").length > 1) {
    throw new Error("Production requires both explicit target and approval flags.");
  }
  return { environment: production ? "production" : "development", approved,
    args: args.filter((arg) => arg !== "--production" && arg !== "--approved") };
}

export function loadTargetEnvironment(target) {
  const envPath = resolve(projectRoot, target.environment === "production" ? ".env.production.local" : ".env.local");
  if (existsSync(envPath)) loadEnvFile(envPath);
}

export function targetConnectionString(target, { direct = false } = {}) {
  if (target.environment === "development") return developmentConnectionString({ direct });
  if (target.environment !== "production" || target.approved !== true) throw new Error("Production approval flags are required.");
  const { production: expected } = pinnedEndpoints();
  if (!expected) {
    throw new Error("Pin the independently verified production endpoint first.");
  }
  const value = process.env[direct ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL"];
  let url;
  try { url = new URL(value); } catch { throw new Error("Database configuration is invalid."); }
  const endpoint = url.hostname.split(".")[0];
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") ||
      ![expected, `${expected}-pooler`].includes(endpoint) || (direct && endpoint.endsWith("-pooler"))) {
    throw new Error("The connection does not match the pinned production target.");
  }
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export async function openTargetClient(target, options = {}) {
  const client = new Client({ connectionString: targetConnectionString(target, options), connectionTimeoutMillis: 5000, query_timeout: 15000 });
  client.on("error", () => {});
  try { await client.connect(); return client; }
  catch { await client.end().catch(() => {}); throw new Error("Database connection failed."); }
}

export async function assertEnvironmentMarker(client, environment, { allowMissing = false } = {}) {
  if (!["development", "production"].includes(environment)) throw new Error("Invalid environment target.");
  const table = await client.query("SELECT to_regclass('public.app_environment') AS name");
  if (!table.rows[0].name) { if (allowMissing) return false; throw new Error("Environment marker is missing."); }
  const marker = await client.query("SELECT name FROM public.app_environment WHERE singleton=true");
  if (!marker.rowCount && allowMissing) return false;
  if (marker.rows[0]?.name !== environment) throw new Error("The environment marker does not match the target.");
  return true;
}

export async function ensureEnvironmentMarker(client, environment) {
  await assertEnvironmentMarker(client, environment, { allowMissing: true });
  await client.query(`CREATE TABLE IF NOT EXISTS public.app_environment (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    name text NOT NULL CHECK(name IN ('development','production')))`);
  await client.query("INSERT INTO public.app_environment(singleton,name) VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING", [environment]);
  await assertEnvironmentMarker(client, environment);
}

/** Reject unknown and production endpoints before any database connection/write. */
export function developmentConnectionString({ direct = false } = {}) {
  const { development: developmentEndpoint } = pinnedEndpoints();
  const key = direct ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
  const value = process.env[key];
  if (!value) throw new Error(`Required configuration is missing: ${key}.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Database configuration is invalid.");
  }
  const endpoint = parsed.hostname.split(".")[0];
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".neon.tech") ||
    ![developmentEndpoint, `${developmentEndpoint}-pooler`].includes(endpoint) ||
    (direct && endpoint.endsWith("-pooler"))
  ) {
    throw new Error("This command only permits the verified development database.");
  }
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

export async function openDevelopmentClient(options = {}) {
  const client = new Client({
    connectionString: developmentConnectionString(options),
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    throw new Error("Development database connection failed.");
  }
}

export async function assertDevelopmentMarker(client, { allowMissing = false } = {}) {
  const table = await client.query("SELECT to_regclass('public.app_environment') AS name");
  if (!table.rows[0].name) {
    if (allowMissing) return false;
    throw new Error("Development environment marker is missing. Run migration first.");
  }
  const marker = await client.query("SELECT name FROM public.app_environment WHERE singleton = true");
  if (marker.rowCount === 0 && allowMissing) return false;
  if (marker.rows[0]?.name !== "development") {
    throw new Error("Database environment marker does not permit development operations.");
  }
  return true;
}

/** Only called after the endpoint allowlist passed; never relabel an existing DB. */
export async function ensureDevelopmentMarker(client) {
  await assertDevelopmentMarker(client, { allowMissing: true });
  await client.query(`CREATE TABLE IF NOT EXISTS public.app_environment (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    name text NOT NULL CHECK (name IN ('development', 'production'))
  )`);
  await client.query(`INSERT INTO public.app_environment(singleton, name)
    VALUES (true, 'development') ON CONFLICT (singleton) DO NOTHING`);
  await assertDevelopmentMarker(client);
}

export function safeFailure(action) {
  // Deliberately never print caught provider errors, SQL, credentials, or stacks.
  console.error(`${action} failed. Check database configuration and prerequisites.`);
  process.exitCode = 1;
}

export function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return value;
}
