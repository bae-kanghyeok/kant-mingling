import "server-only";
import { reject } from "./respond";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  const allowed = new Set([new URL(request.url).origin]);
  if (process.env.VERCEL === "1") {
    const host = request.headers.get("x-forwarded-host");
    const proto = request.headers.get("x-forwarded-proto");
    if (host && proto === "https" && !host.includes(",")) allowed.add(`https://${host}`);
  }
  if (process.env.NODE_ENV === "development") {
    allowed.add("http://localhost:3000");
    allowed.add("http://127.0.0.1:3000");
  }
  if (!origin || !allowed.has(origin)) reject(403, "BAD_ORIGIN");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") reject(415, "UNSUPPORTED_MEDIA");
  const reader = request.body?.getReader();
  if (!reader) reject(400, "INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) { await reader.cancel(); reject(413, "BODY_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) reject(400, "INVALID_REQUEST");
    return body;
  } catch { reject(400, "INVALID_REQUEST"); }
}
