import "server-only";
import type { PoolClient } from "pg";
import { hashSessionToken } from "./session";
import { reject } from "../http/respond";

/** Counters are retained when authentication is rejected; no credentials are stored. */
export async function consumeRateLimit(
  client: PoolClient,
  eventId: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  now: Date,
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const keyHash = hashSessionToken(`rate:${identity}`);
  const result = await client.query<{ attempts: number }>(
    `INSERT INTO auth_attempts(event_id, key_hash, window_start, attempts)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (event_id, key_hash, window_start)
     DO UPDATE SET attempts = auth_attempts.attempts + 1
     RETURNING attempts`,
    [eventId, keyHash, windowStart],
  );
  if (result.rows[0].attempts > limit) reject(429, "RATE_LIMITED", true);
}
