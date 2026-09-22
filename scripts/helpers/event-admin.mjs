import { randomBytes, scrypt as derive } from "node:crypto";
import { z } from "zod";
import { optionValue } from "./database.mjs";

const name = z.string().trim().min(1).max(40);
export const rosterSchema = z.object({
  title: z.string().trim().min(1).max(100).default("KANT Mingle"),
  students: z.array(name).min(2),
  operators: z.array(z.object({ name, team: z.string().regex(/^[A-Z]$/) }).strict()).min(1).max(26),
  host: name,
  moveCountPerTeam: z.number().int().min(0).default(3),
  blockTargetMinutes: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).default([12, 12, 15]),
}).strict().superRefine((roster, ctx) => {
  const names = [...roster.students, ...roster.operators.map((op) => op.name)];
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "Display names must be unique." });
  if (!roster.operators.some((op) => op.name === roster.host)) ctx.addIssue({ code: "custom", message: "The host must be an operator." });
  if (roster.students.length < roster.operators.length || roster.moveCountPerTeam > Math.floor(roster.students.length / roster.operators.length)) ctx.addIssue({ code: "custom", message: "Invalid team capacity or rotation count." });
  if (roster.operators.length === 1 && roster.moveCountPerTeam !== 0) ctx.addIssue({ code: "custom", path: ["moveCountPerTeam"], message: "A single team requires zero moving students." });
  const teams = roster.operators.map((op) => op.team).sort();
  if (teams.some((team, index) => team !== String.fromCharCode(65 + index))) ctx.addIssue({ code: "custom", message: "Operator teams must be unique consecutive keys beginning with A." });
});

export function readOptions(args, valueOptions, flagOptions = []) {
  const allowed = new Set([...valueOptions, ...flagOptions]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!allowed.has(arg) || seen.has(arg)) throw new Error("Unknown or duplicate command argument.");
    seen.add(arg);
    if (valueOptions.includes(arg)) { optionValue(args, arg); index++; }
  }
  return Object.fromEntries([...valueOptions.map((key) => [key.slice(2), optionValue(args, key)]), ...flagOptions.map((key) => [key.slice(2), args.includes(key)])]);
}

export function validateSlug(target, slug, { synthetic = false } = {}) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error("A valid event slug is required.");
  if (target.environment === "development" && (!/^(dev|test)-/.test(slug) || synthetic === false)) throw new Error("Development administration requires an explicit synthetic event.");
  return slug;
}

export async function newOperatorCode() {
  const code = randomBytes(18).toString("base64url");
  const salt = randomBytes(16);
  const hash = await new Promise((resolve, reject) => derive(code, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  return { code, hash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}` };
}

export async function lockEvent(client, slug) {
  const result = await client.query("SELECT id,phase FROM events WHERE slug=$1 FOR UPDATE", [slug]);
  if (!result.rows[0] || result.rows[0].phase === "ENDED") throw new Error("The event must exist and be open.");
  return result.rows[0];
}
