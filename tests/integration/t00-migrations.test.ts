import { expect, it, afterAll } from "vitest";
import { getPool, closePool } from "@/server/db/pool";
it("M0 uses the development database and has a checksummed initial schema", async () => {
  if (process.env.ALLOW_DB_TESTS !== "1") throw new Error("Run integration tests using npm run test:db");
  const pool = getPool();
  expect((await pool.query("SELECT name FROM app_environment")).rows[0].name).toBe("development");
  expect((await pool.query("SELECT version,checksum FROM schema_migrations")).rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ version: "001_init.sql", checksum: expect.stringMatching(/^[a-f0-9]{64}$/) })]),
  );
  expect((await pool.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('events','participants','games','data_cards')")).rows[0].n).toBe(4);
});
afterAll(closePool);
