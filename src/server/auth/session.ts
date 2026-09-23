import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "km_session";

/** The API lives outside /e/<slug>, so isolate sessions by name, not Path. */
export function sessionCookieName(slug?: string): string {
  if (slug === undefined) return SESSION_COOKIE_NAME;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error("Invalid event slug.");
  return `${SESSION_COOKIE_NAME}_${createHash("sha256").update(slug).digest("hex").slice(0, 32)}`;
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Authentication configuration is unavailable.");
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function getRequestTokenHash(request: Request, slug?: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const entries = cookie.split(";").map((value) => value.trim());
  const name = sessionCookieName(slug);
  // Preserve old browser sessions without letting a bad scoped cookie fall back
  // to a different identity. Database lookups still verify the event boundary.
  const scoped = entries.find((value) => value.startsWith(`${name}=`));
  const entry = scoped ?? entries.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!entry) return null;
  const token = entry.slice(entry.indexOf("=") + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return hashSessionToken(token);
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number, slug?: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid session token.");
  return `${sessionCookieName(slug)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(slug?: string): string {
  return `${sessionCookieName(slug)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
