import "server-only";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";

const globalForDatabase = globalThis as typeof globalThis & {
  kantMinglePool?: Pool;
};

/** Create connections only when server code needs the database, not at build time. */
export function getPool(): Pool {
  if (globalForDatabase.kantMinglePool) return globalForDatabase.kantMinglePool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database configuration is unavailable.");

  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({
    connectionString: url.toString(),
    max: 10,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  // Idle-client errors must not become unhandled process errors or expose URLs.
  pool.on("error", () => {
    console.error("An idle database connection was interrupted.");
  });
  attachDatabasePool(pool);
  globalForDatabase.kantMinglePool = pool;
  return pool;
}

export async function closePool() {
  const pool = globalForDatabase.kantMinglePool;
  delete globalForDatabase.kantMinglePool;
  if (pool) await pool.end();
}
