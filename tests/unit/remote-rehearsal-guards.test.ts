import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertRehearsalDeployment, assertRehearsalOrigin, assertSyntheticRehearsalRoster } from "@/server/rehearsal/guards";
import { operatorCodeDigest, parseSupervisorGrant, signSupervisorGrant, supervisorCookieHeader, type SupervisorGrant } from "@/server/rehearsal/supervisor";

beforeEach(() => {
  vi.stubEnv("REHEARSAL_ENABLED", "true"); vi.stubEnv("REHEARSAL_EVENT_SLUG", "dev-unit-rehearsal");
  vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("DEVELOPMENT_NEON_ENDPOINT", "ep-unit-development"); vi.stubEnv("PRODUCTION_NEON_ENDPOINT", "ep-unit-production");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@ep-unit-development-pooler.ap-southeast-1.aws.neon.tech/test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-not-a-live-credential");
});
afterEach(() => vi.unstubAllEnvs());

it("permits an explicitly pinned Preview even though Next runs with NODE_ENV production", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(() => assertRehearsalDeployment("dev-unit-rehearsal")).not.toThrow();
  vi.stubEnv("VERCEL_ENV", "production");
  expect(() => assertRehearsalDeployment("dev-unit-rehearsal")).toThrow();
});
it("fails closed for off flags, another slug, real slug, or a different database", () => {
  expect(() => assertRehearsalDeployment("dev-other")).toThrow();
  vi.stubEnv("REHEARSAL_EVENT_SLUG", "real-event"); expect(() => assertRehearsalDeployment("real-event")).toThrow();
  vi.stubEnv("REHEARSAL_EVENT_SLUG", "dev-unit-rehearsal");
  vi.stubEnv("REHEARSAL_ENABLED", "false"); expect(() => assertRehearsalDeployment("dev-unit-rehearsal")).toThrow();
  vi.stubEnv("REHEARSAL_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@ep-unit-production.neon.tech/test");
  expect(() => assertRehearsalDeployment("dev-unit-rehearsal")).toThrow();
});
it("requires the complete synthetic roster rather than only trusting its slug", () => {
  const roster = Array.from({ length: 21 }, (_, index) => ({ id: randomUUID(), active: true, roster_order: index + 1,
    display_name: index < 18 ? `학생${String(index + 1).padStart(2, "0")}` : `운영진${"ABC"[index - 18]}`,
    role: index < 18 ? "student" as const : "operator" as const }));
  expect(() => assertSyntheticRehearsalRoster(roster)).not.toThrow();
  expect(() => assertSyntheticRehearsalRoster(roster.slice(1))).toThrow();
  expect(() => assertSyntheticRehearsalRoster(roster.map((person, index) => index === 0 ? { ...person, display_name: "실제 이름" } : person))).toThrow();
  expect(() => assertSyntheticRehearsalRoster(roster.map((person, index) => index === 0 ? { ...person, active: false } : person))).toThrow();
});
it("rejects cross-site requests independently of cookie SameSite behavior", () => {
  expect(() => assertRehearsalOrigin(new Request("https://demo.example/api/rehearsal", { headers: { origin: "https://other.example" } }))).toThrow();
  expect(() => assertRehearsalOrigin(new Request("https://demo.example/api/rehearsal", { headers: { "sec-fetch-site": "cross-site" } }))).toThrow();
  expect(() => assertRehearsalOrigin(new Request("https://demo.example/api/rehearsal", { headers: { origin: "https://demo.example", "sec-fetch-site": "same-origin" } }))).not.toThrow();
});
it("binds a grant to the event, validates its signature, and expires it on the server", () => {
  const now = Date.now();
  const grant: SupervisorGrant = { version: 1, slug: "dev-unit-rehearsal", eventId: randomUUID(), hostParticipantId: randomUUID(),
    hostToken: "a".repeat(43), codeDigest: operatorCodeDigest("synthetic-scrypt-hash"), expiresAt: now + 60_000 };
  const signed = signSupervisorGrant(grant);
  expect(parseSupervisorGrant(signed, grant.slug, now)).toEqual(grant);
  expect(parseSupervisorGrant(signed, "dev-other", now)).toBeNull();
  expect(parseSupervisorGrant(signed, grant.slug, now + 60_000)).toBeNull();
  const [payload, signature] = signed.split(".");
  const altered = Buffer.from(JSON.stringify({ ...grant, eventId: randomUUID() })).toString("base64url");
  expect(parseSupervisorGrant(`${altered}.${signature}`, grant.slug, now)).toBeNull();
  expect(parseSupervisorGrant(`${payload}.invalid`, grant.slug, now)).toBeNull();
  vi.stubEnv("AUTH_SECRET", "a-different-secret");
  expect(parseSupervisorGrant(signed, grant.slug, now)).toBeNull();
});
it("issues a separate HttpOnly strict cookie and never reuses the game cookie name", () => {
  vi.stubEnv("NODE_ENV", "production");
  const cookie = supervisorCookieHeader("test", 60);
  expect(cookie).toBe("km_rehearsal=test; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure");
});
