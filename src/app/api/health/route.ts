import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  try {
    const sql = getSql();
    await sql.query("SELECT 1", [], {
      fetchOptions: { signal: AbortSignal.timeout(10_000) },
    });
    return Response.json(
      { app: "ok", database: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Never return provider errors or credentials to the browser.
    return Response.json(
      { app: "ok", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
