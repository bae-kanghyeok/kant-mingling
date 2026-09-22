import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (existsSync(".env.local")) loadEnvFile(".env.local");
const required = ["DATABASE_URL", "AUTH_SECRET"];
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing environment keys: ${missing.join(", ")}`);
  process.exit(1);
}
try {
  const sql = neon(process.env.DATABASE_URL);
  await sql.query("SELECT 1", [], {
    fetchOptions: { signal: AbortSignal.timeout(10_000) },
  });
  console.log("Environment keys present. Neon database connection: OK.");
} catch {
  console.error("Database connection failed. Check the development database configuration.");
  process.exitCode = 1;
}
