import "server-only";
import { developmentConnectionString } from "../../../scripts/helpers/database-target.mjs";
import { reject } from "../http/respond";

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
  if (people.length !== 21) reject(404, "NOT_FOUND");
  const ordered = [...people].sort((a, b) => a.roster_order - b.roster_order);
  for (let index = 0; index < ordered.length; index++) {
    const person = ordered[index];
    const student = index < 18;
    const expectedName = student ? `학생${String(index + 1).padStart(2, "0")}` : `운영진${"ABC"[index - 18]}`;
    if (!person.active || person.roster_order !== index + 1 || person.display_name !== expectedName ||
      person.role !== (student ? "student" : "operator")) reject(404, "NOT_FOUND");
  }
}
