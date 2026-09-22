import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { questions } from "@/content/catalog";
import { validateCatalog } from "../../scripts/check-content.mjs";
import catalog from "@/content/questions.v2.json";
import { readJson } from "@/server/http/origin";
import { errorResponse } from "@/server/http/respond";

describe("M0 content and HTTP boundaries", () => {
  it("preserves the source questions and rejects added trait fields", async () => {
    const source = await readFile("docs/profile-questions.md", "utf8");
    expect(() => validateCatalog(catalog, source)).not.toThrow();
    expect(questions).toHaveLength(20);
    const changed = structuredClone(catalog);
    Object.assign(changed.questions[0], { personality: "type" });
    expect(() => validateCatalog(changed, source)).toThrow();
  });
  it("rejects missing/cross origins and oversized bodies", async () => {
    const request = (origin?: string, body = "{}") => new Request("https://example.com/api/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body,
    });
    await expect(readJson(request())).rejects.toMatchObject({ status: 403 });
    await expect(readJson(request("https://attacker.example"))).rejects.toMatchObject({ status: 403 });
    await expect(readJson(request("https://example.com", JSON.stringify({ data: "a".repeat(8192) })))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(request("https://example.com"))).resolves.toEqual({});
  });
  it("does not serialize an internal exception", async () => {
    const response = errorResponse(new Error("database connection secret"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
