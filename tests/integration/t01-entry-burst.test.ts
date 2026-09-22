import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { apiHandler } from "@/server/http/handlers";
import { closePool, getPool } from "@/server/db/pool";
import { cleanupTestEvent, createTestEvent, type TestEvent } from "./helpers";

let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

function request(action: string, body: Record<string, unknown>, cookie?: string) {
  return new Request(`http://localhost:3000/api/${action}`, {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ slug: event.slug, requestId: randomUUID(), ...body }),
  });
}

it("T01 all 21 people can bootstrap on one venue IP and claim distinct names simultaneously", async () => {
  // The real route treats local requests as the same IP. Keep opaque cookies in
  // memory only; assertions report statuses/counts and never credential values.
  const bootstraps = await Promise.all(Array.from({ length: 21 }, () => apiHandler("bootstrap")(request("bootstrap", {}))));
  expect(bootstraps.map((response) => response.status)).toEqual(Array(21).fill(200));
  const cookies = bootstraps.map((response) => response.headers.get("set-cookie")?.split(";")[0] ?? "");
  expect(cookies.every(Boolean)).toBe(true);
  expect(new Set(cookies).size).toBe(21);
  const claims = await Promise.all([
    ...event.students.map((participantId, index) => apiHandler("claim")(request("claim", { participantId }, cookies[index]))),
    ...event.operators.map((participantId, index) => apiHandler("operator")(request("operator", { participantId, code: event.operatorCodes[index] }, cookies[index + 18]))),
  ]);
  expect(claims.map((response) => response.status)).toEqual(Array(21).fill(200));
  const counts = (await getPool().query<{ claimed: number; distinct_people: number }>(`SELECT count(*)::int AS claimed,
    count(DISTINCT participant_id)::int AS distinct_people FROM sessions
    WHERE event_id=$1 AND revoked_at IS NULL AND participant_id IS NOT NULL`, [event.id])).rows[0];
  expect(counts).toEqual({ claimed: 21, distinct_people: 21 });
}, 90_000);
