import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseTargetFlags, loadTargetEnvironment, openTargetClient, assertEnvironmentMarker, safeFailure, projectRoot } from "./helpers/database.mjs";
import { readOptions, validateSlug, rosterSchema } from "./helpers/event-admin.mjs";
let client;
try {
  const target = parseTargetFlags(process.argv.slice(2));
  const options = readOptions(target.args, ["--roster", "--slug"], ["--synthetic"]);
  const slug = validateSlug(target, options.slug, options);
  if (!options.roster?.endsWith(".local.json")) throw new Error("Roster files must use the ignored .local.json suffix.");
  const roster = rosterSchema.parse(JSON.parse(await readFile(resolve(projectRoot, options.roster), "utf8")));
  if (target.environment === "development" && (!roster.students.every((value) => /^학생\d{2,}$/.test(value)) || !roster.operators.every((op) => /^운영진[A-Z]+$/.test(op.name)))) throw new Error("Only synthetic names are accepted by development seed.");
  const config = { ...(roster.gameplayMode ? { gameplayMode: roster.gameplayMode } : {}), studentCount: roster.students.length, teamCount: roster.operators.length, moveCountPerTeam: roster.moveCountPerTeam,
    operatorTeamByName: Object.fromEntries(roster.operators.map((op) => [op.name, op.team])), blockTargetMinutes: roster.blockTargetMinutes,
    sessionTtlHours: 24, presenceWindowSeconds: 15, pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30 };
  const content = JSON.parse(await readFile(resolve(projectRoot, "src/content/questions.v2.json"), "utf8"));
  loadTargetEnvironment(target);
  client = await openTargetClient(target);
  await assertEnvironmentMarker(client, target.environment);
  await client.query("BEGIN");
  const event = (await client.query("INSERT INTO events(slug,title,config_json,content_version) VALUES($1,$2,$3,$4) RETURNING id",
    [slug, roster.title, JSON.stringify(config), content.contentVersion])).rows[0];
  const members = [...roster.students.map((name) => ({ name, role: "student" })), ...roster.operators.map((op) => ({ name: op.name, role: "operator" }))];
  await client.query(`INSERT INTO participants(event_id,display_name,role,roster_order)
    SELECT $1,x.name,x.role,x.ord FROM jsonb_to_recordset($2::jsonb) AS x(name text,role text,ord smallint)`,
  [event.id, JSON.stringify(members.map((member, index) => ({ ...member, ord: index + 1 })))]);
  await client.query("UPDATE events SET host_participant_id=(SELECT id FROM participants WHERE event_id=$1 AND display_name=$2 AND role='operator') WHERE id=$1", [event.id, roster.host]);
  await client.query("INSERT INTO operation_logs(event_id,command) VALUES($1,'seed-event')", [event.id]);
  await client.query("COMMIT");
  console.log(`Event created: /e/${slug}. Issue operator codes before entry.`);
} catch { if (client) await client.query("ROLLBACK").catch(() => {}); safeFailure("Event seed"); }
finally { if (client) await client.end().catch(() => {}); }
