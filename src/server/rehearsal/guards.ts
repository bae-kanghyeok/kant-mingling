import "server-only";
import { developmentConnectionString } from "../db/database-target.mjs";
import { reject } from "../http/respond";
import { isSyntheticRehearsalRoster } from "./reset-fixture.mjs";

/** An opt-in Preview/local feature; a production deployment always fails closed. */
export function assertRehearsalDeployment(slug: string) {
  if (process.env.REHEARSAL_ENABLED !== "true" || process.env.VERCEL_ENV === "production" ||
    (process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "preview") ||
    !/^dev-[a-z0-9][a-z0-9-]{0,74}$/.test(slug) || process.env.REHEARSAL_EVENT_SLUG !== slug) {
    reject(404, "NOT_FOUND");
  }
  try { developmentConnectionString(); } catch { reject(404, "NOT_FOUND"); }
}

export function assertRehearsalOrigin(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) reject(403, "BAD_ORIGIN");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) reject(403, "BAD_ORIGIN");
}

export interface RehearsalPerson {
  id: string; display_name: string; role: "student" | "operator"; roster_order: number; active: boolean;
}

/** A fixed synthetic fixture only. A dev-looking slug alone is insufficient. */
export function assertSyntheticRehearsalRoster(people: RehearsalPerson[]) {
  if (!isSyntheticRehearsalRoster(people)) reject(404, "NOT_FOUND");
}
