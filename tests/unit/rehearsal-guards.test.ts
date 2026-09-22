import { describe, expect, it } from "vitest";
import { isAllowedActorPath, isLocalRequest, validateActorPayload } from "../../scripts/rehearsal/guards.mjs";

const slug = "dev-play-012345abcdef";
const port = 3101;
const ownOrigin = `http://127.0.0.1:${port}`;
const local = { host: `127.0.0.1:${port}`, origin: ownOrigin, method: "POST", fetchSite: "same-origin" };

describe("local rehearsal request boundary", () => {
  it("accepts same-origin commands and iframe reads without broadening mutation origins", () => {
    expect(isLocalRequest(local, port)).toBe(true);
    expect(isLocalRequest({ ...local, method: "PATCH" }, port)).toBe(true);
    expect(isLocalRequest({ ...local, method: "GET", origin: undefined }, port)).toBe(true);
    expect(isLocalRequest({ ...local, method: "HEAD", origin: "http://127.0.0.1:3100", fetchSite: "same-site" }, port)).toBe(true);
    expect(isLocalRequest({ ...local, origin: "http://127.0.0.1:3100" }, port)).toBe(false);
  });

  it("rejects forged hosts, missing or foreign mutation origins, and cross-site requests", () => {
    for (const host of ["localhost:3101", "127.0.0.1:3102", "127.0.0.1:3101.evil.test", "evil.test", "127.0.0.1:3101,evil.test", "127.0.0.1:3101 "]) {
      expect(isLocalRequest({ ...local, host }, port)).toBe(false);
    }
    for (const origin of [undefined, null, "", "null", "http://localhost:3101", "http://127.0.0.1:3102", "https://127.0.0.1:3101", "https://evil.test", `${ownOrigin}/`]) {
      expect(isLocalRequest({ ...local, origin }, port)).toBe(false);
    }
    expect(isLocalRequest({ ...local, fetchSite: "cross-site" }, port)).toBe(false);
    expect(isLocalRequest({ ...local, method: "GET", origin: undefined, fetchSite: "cross-site" }, port)).toBe(false);
    expect(isLocalRequest({ ...local, method: "GET", origin: "https://evil.test" }, port)).toBe(false);
    expect(isLocalRequest({ ...local, method: "DELETE" }, port)).toBe(false);
    expect(isLocalRequest({ ...local, method: "OPTIONS" }, port)).toBe(false);
    expect(isLocalRequest(local, 0)).toBe(false);
    expect(isLocalRequest(local, 65536)).toBe(false);
  });
});

describe("local rehearsal route and event boundary", () => {
  it("allows only actual routes with their expected HTTP methods", () => {
    for (const path of ["/", `/e/${slug}`, "/favicon.ico", "/_next/static/chunks/app.js", "/_next/static/chunks/app/e/%5Bslug%5D/page.js"]) {
      expect(isAllowedActorPath("GET", path, slug)).toBe(true);
      expect(isAllowedActorPath("HEAD", path, slug)).toBe(true);
    }
    expect(isAllowedActorPath("GET", "/api/state", slug)).toBe(true);
    expect(isAllowedActorPath("HEAD", "/api/state", slug)).toBe(false);
    expect(isAllowedActorPath("PATCH", "/api/profile", slug)).toBe(true);
    for (const path of ["/api/session/bootstrap", "/api/session/claim", "/api/session/operator", "/api/session/release", "/api/profile/submit", "/api/state/sync", "/api/admin", "/api/game/more-data", "/api/game/guess", "/api/game/ensemble-shared", "/api/game/ensemble-vote", "/api/game/ensemble-end-discussion", "/api/game/intro-ack"]) {
      expect(isAllowedActorPath("POST", path, slug)).toBe(true);
      expect(isAllowedActorPath("GET", path, slug)).toBe(false);
      expect(isAllowedActorPath("PATCH", path, slug)).toBe(false);
    }
    expect(isAllowedActorPath("POST", "/api/profile", slug)).toBe(false);
  });

  it("rejects other events, route prefixes, encoded traversal, and arbitrary upstream URLs", () => {
    for (const path of ["/e/dev-play-fedcba543210", "/api/state/other", "/api/health", "/api/admin/", "/_next/static/", "/_next/static/../secret", "/_next/static/%2e%2e/secret", "/_next/static/%252e%252e/secret", "/_next/static/chunks%2Fsecret.js", "/_next/static/chunks%5csecret.js", "/_next/static/chunks%00secret.js", "/_next/static/chunks\\secret.js", "/_next/static//secret.js", "/_next/static/%zz", "/_next/static/chunk.js?query=yes", "/_next/static/chunk.js#fragment", "//evil.test/app.js", "http://evil.test/app.js"]) {
      expect(isAllowedActorPath("GET", path, slug)).toBe(false);
    }
    for (const invalidSlug of ["real-event", "dev-play-abc", "dev-play-ABCDEF012345", "dev-play-012345abcdef/other"]) {
      expect(isAllowedActorPath("GET", "/", invalidSlug)).toBe(false);
    }
  });

  it("requires a JSON object owning the exact synthetic slug for an allowed mutation", () => {
    expect(validateActorPayload("/api/admin", { slug, command: "next-game" }, slug)).toBe(true);
    expect(validateActorPayload("/api/profile", { slug, questionId: "Q01", option: "A", revision: 0 }, slug)).toBe(true);
    for (const payload of [null, undefined, [], [{ slug }], "value", 1, {}, { slug: "real-event" }, { slug: "dev-play-fedcba543210" }, Object.create({ slug })]) {
      expect(validateActorPayload("/api/admin", payload, slug)).toBe(false);
    }
    expect(validateActorPayload("/api/state", { slug }, slug)).toBe(false);
    expect(validateActorPayload("/api/admin/other", { slug }, slug)).toBe(false);
    expect(validateActorPayload("/api/admin", { slug: "real-event" }, "real-event")).toBe(false);
  });
});
