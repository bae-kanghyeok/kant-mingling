// Shared by the CLI and server routes. Kept in src so Vercel ships the module.
// No filesystem, module-relative path,
// environment-file loading, or connection creation belongs in this module.
export function pinnedEndpoints() {
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
