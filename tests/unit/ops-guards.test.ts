import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertDevelopmentMarker, developmentConnectionString, parseTargetFlags, targetConnectionString } from "../../scripts/helpers/database.mjs";
import { rosterSchema, validateSlug } from "../../scripts/helpers/event-admin.mjs";
const developmentEndpoint = "ep-synthetic-development-123";
const productionEndpoint = "ep-synthetic-production-123";
const connection = (endpoint: string) => `postgresql://test:test@${endpoint}.ap-southeast-1.aws.neon.tech/test`;

beforeEach(() => {
  vi.stubEnv("DEVELOPMENT_NEON_ENDPOINT", developmentEndpoint);
  vi.stubEnv("PRODUCTION_NEON_ENDPOINT", "");
  vi.stubEnv("DATABASE_URL", connection(`${developmentEndpoint}-pooler`));
  vi.stubEnv("DATABASE_URL_UNPOOLED", connection(developmentEndpoint));
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "", "ep-example-pooler", "ep-example.neon.tech", "https://ep-example", "ep-example-"])(
  "development tooling rejects a missing or invalid endpoint pin: %s", (pin) => {
    vi.stubEnv("DEVELOPMENT_NEON_ENDPOINT", pin);
    expect(() => developmentConnectionString()).toThrow("DEVELOPMENT_NEON_ENDPOINT");
  },
);

it("development tooling only permits its explicit pooled or direct endpoint", () => {
  expect(new URL(developmentConnectionString()).searchParams.get("sslmode")).toBe("verify-full");
  expect(new URL(developmentConnectionString({ direct: true })).hostname).toBe(`${developmentEndpoint}.ap-southeast-1.aws.neon.tech`);
  vi.stubEnv("DATABASE_URL", connection("ep-synthetic-other-123"));
  expect(() => developmentConnectionString()).toThrow();
  vi.stubEnv("DATABASE_URL_UNPOOLED", connection(`${developmentEndpoint}-pooler`));
  expect(() => developmentConnectionString({ direct: true })).toThrow();
});

it("development tooling rejects the production URL and pins pointing at the same database", () => {
  vi.stubEnv("PRODUCTION_NEON_ENDPOINT", productionEndpoint);
  vi.stubEnv("DATABASE_URL", connection(productionEndpoint));
  expect(() => developmentConnectionString()).toThrow();
  vi.stubEnv("DEVELOPMENT_NEON_ENDPOINT", productionEndpoint);
  expect(() => developmentConnectionString()).toThrow("different independently verified endpoints");
  expect(() => targetConnectionString(parseTargetFlags(["--production", "--approved"]))).toThrow();
});

it("a development pin never overrides an existing production database marker", async () => {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ name: "app_environment" }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ name: "production" }] });
  await expect(assertDevelopmentMarker({ query }, { allowMissing: true })).rejects.toThrow("does not permit development operations");
  expect(query).toHaveBeenCalledTimes(2);
});

it("production tooling requires both flags and an independently matching endpoint", () => {
  expect(() => parseTargetFlags(["--production"])).toThrow();
  expect(() => parseTargetFlags(["--approved"])).toThrow();
  const target = parseTargetFlags(["--production", "--approved"]);
  expect(() => targetConnectionString(target)).toThrow();
  vi.stubEnv("PRODUCTION_NEON_ENDPOINT", productionEndpoint);
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@ep-synthetic-other-123.ap-southeast-1.aws.neon.tech/test");
  expect(() => targetConnectionString(target)).toThrow();
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@ep-synthetic-production-123-pooler.ap-southeast-1.aws.neon.tech/test");
  expect(new URL(targetConnectionString(target)).searchParams.get("sslmode")).toBe("verify-full");
  vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://test:test@ep-synthetic-production-123-pooler.ap-southeast-1.aws.neon.tech/test");
  expect(() => targetConnectionString(target, { direct: true })).toThrow();
  vi.stubEnv("DEVELOPMENT_NEON_ENDPOINT", undefined);
  expect(() => targetConnectionString(target)).toThrow();
});
it("development admin commands require the synthetic switch and a synthetic slug", () => {
  const target = parseTargetFlags([]);
  expect(() => validateSlug(target, "real-event", { synthetic: true })).toThrow();
  expect(() => validateSlug(target, "test-event")).toThrow();
  expect(validateSlug(target, "test-event", { synthetic: true })).toBe("test-event");
});
it("roster seeding rejects duplicate names and a student host", () => {
  const valid = { students: ["학생01", "학생02", "학생03", "학생04"], operators: [{ name: "운영진A", team: "A" }, { name: "운영진B", team: "B" }], host: "운영진A", moveCountPerTeam: 1 };
  expect(rosterSchema.safeParse(valid).success).toBe(true);
  expect(rosterSchema.safeParse({ ...valid, students: ["학생01", "학생01"] }).success).toBe(false);
  expect(rosterSchema.safeParse({ ...valid, host: "학생01" }).success).toBe(false);
});
it("roster seeding accepts one participating operator and five students only with zero moves", () => {
  const roster = { students: ["학생01", "학생02", "학생03", "학생04", "학생05"],
    operators: [{ name: "운영진A", team: "A" }], host: "운영진A", moveCountPerTeam: 0 };
  expect(rosterSchema.safeParse(roster).success).toBe(true);
  expect(rosterSchema.safeParse({ ...roster, moveCountPerTeam: 1 }).success).toBe(false);
  expect(rosterSchema.safeParse({ ...roster, operators: [] }).success).toBe(false);
  expect(rosterSchema.safeParse({ ...roster, operators: [{ name: "운영진A", team: "B" }] }).success).toBe(false);
});
