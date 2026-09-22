import "server-only";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
const parameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(code: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(code, salt, length, parameters, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashOperatorCode(code: string): Promise<string> {
  if (code.length < 12 || code.length > 128) throw new Error("Invalid operator code length.");
  const salt = randomBytes(16);
  const hash = await scrypt(code, salt, 32);
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyOperatorCode(code: string, encoded: string | null): Promise<boolean> {
  if (!encoded || code.length > 128) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "16384" || parts[2] !== "8" || parts[3] !== "1") return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await scrypt(code, salt, expected.length);
  return timingSafeEqual(expected, actual);
}
