import { afterEach, expect, it, vi } from "vitest";
import { clearSessionCookieHeader, getRequestTokenHash, hashSessionToken, sessionCookieHeader, sessionCookieName } from "@/server/auth/session";

afterEach(() => vi.unstubAllEnvs());
const tokenA = "A".repeat(43), tokenB = "B".repeat(43);
const request = (cookie: string) => new Request("https://example.test/api/state", { headers: { cookie } });

it("isolates two events on one origin and resumes either identity regardless of cookie order", () => {
  vi.stubEnv("AUTH_SECRET", "synthetic-session-cookie-unit-test");
  const cookieA = sessionCookieHeader(tokenA, 60, "event-a").split(";")[0];
  const cookieB = sessionCookieHeader(tokenB, 60, "event-b").split(";")[0];
  expect(sessionCookieName("event-a")).not.toBe(sessionCookieName("event-b"));
  for (const cookie of [`${cookieA}; ${cookieB}`, `${cookieB}; ${cookieA}`]) {
    expect(getRequestTokenHash(request(cookie), "event-a")).toBe(hashSessionToken(tokenA));
    expect(getRequestTokenHash(request(cookie), "event-b")).toBe(hashSessionToken(tokenB));
    expect(getRequestTokenHash(request(cookie), "event-c")).toBeNull();
  }
});

it("accepts legacy sessions only when the requested event has no scoped cookie", () => {
  vi.stubEnv("AUTH_SECRET", "synthetic-session-cookie-unit-test");
  const legacy = `km_session=${tokenA}`;
  expect(getRequestTokenHash(request(legacy), "event-a")).toBe(hashSessionToken(tokenA));
  expect(getRequestTokenHash(request(`${legacy}; ${sessionCookieName("event-a")}=${tokenB}`), "event-a")).toBe(hashSessionToken(tokenB));
  for (const invalid of ["", "invalid", "A".repeat(44)]) {
    expect(getRequestTokenHash(request(`${legacy}; ${sessionCookieName("event-a")}=${invalid}`), "event-a")).toBeNull();
  }
});

it("writes and clears only the requested event cookie with secure HTTP-only attributes", () => {
  vi.stubEnv("NODE_ENV", "production");
  const name = sessionCookieName("event-a");
  expect(sessionCookieHeader(tokenA, 60.5, "event-a")).toBe(`${name}=${tokenA}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`);
  expect(clearSessionCookieHeader("event-a")).toBe(`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  expect(() => sessionCookieName("event-a; injected=1")).toThrow("Invalid event slug");
});
