import "server-only";
import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "km_session";

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Authentication configuration is unavailable.");
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function getRequestTokenHash(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const entry = cookie.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!entry) return null;
  const token = entry.slice(SESSION_COOKIE_NAME.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return hashSessionToken(token);
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid session token.");
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
