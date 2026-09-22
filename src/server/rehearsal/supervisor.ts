import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { reject } from "../http/respond";

export const SUPERVISOR_COOKIE = "km_rehearsal";
export const SUPERVISOR_MAX_AGE_SECONDS = 2 * 60 * 60;
const grantSchema = z.object({
  version: z.literal(1), slug: z.string().max(80), eventId: z.uuid(), hostParticipantId: z.uuid(),
  hostToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), codeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
}).strict();
export type SupervisorGrant = z.infer<typeof grantSchema>;

function signature(payload: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) reject(503, "DB_UNAVAILABLE");
  return createHmac("sha256", secret).update(`rehearsal-supervisor:v1:${payload}`).digest("base64url");
}
export function operatorCodeDigest(hash: string) { return createHash("sha256").update(hash).digest("hex"); }
export function signSupervisorGrant(grant: SupervisorGrant) {
  const payload = Buffer.from(JSON.stringify(grantSchema.parse(grant))).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function parseSupervisorGrant(value: string | null, slug: string, now = Date.now()): SupervisorGrant | null {
  if (!value || value.length > 2048) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = Buffer.from(signature(parts[0]));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const grant = grantSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return grant.slug === slug && grant.expiresAt > now && grant.expiresAt <= now + SUPERVISOR_MAX_AGE_SECONDS * 1000 + 30_000 ? grant : null;
  } catch { return null; }
}
export function cookieValue(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map(value => value.trim())
    .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
export function supervisorCookieHeader(value: string, maxAge: number) {
  return `${SUPERVISOR_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
