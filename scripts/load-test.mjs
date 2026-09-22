import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker } from "./helpers/database.mjs";

// This script creates and removes only its own synthetic fixture. It never accepts
// an existing event, a remote HTTP endpoint, credentials, or a real roster.
const DURATION_MS = 300_000;
const POLL_MS = 2_000;
const ACTOR_COUNT = 21;
const DEFAULT_BASE = "http://127.0.0.1:3000";
const args = process.argv.slice(2);
let baseUrl = DEFAULT_BASE;
let slug = `dev-load-${randomBytes(5).toString("hex")}`;
let client;
let fixtureId;
let actors = [];
let sampleTimer;
let startedAt;
let measurementStart = 0;
let stopping = false;
let interrupted = false;
let warmupMs;
const samples = [];
const connectionSamples = [];
const failures = new Map();
const statusCounts = new Map();
const observedPhases = new Set();
const acknowledged = new Set();
const voted = new Set();
const latestStates = new Map();

const stop = () => { interrupted = true; stopping = true; console.log(JSON.stringify({ event: "load-test-stopping", reason: "requested", summary: summary(), statuses: Object.fromEntries(statusCounts) })); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function validateArguments() {
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || !["--slug", "--base-url"].includes(option)) throw new Error("Invalid load-test arguments.");
    if (option === "--slug") slug = value;
    else baseUrl = value;
  }
  if (!/^dev-load-[a-z0-9-]{6,48}$/.test(slug)) throw new Error("A new dev-load- synthetic slug is required.");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "3000" ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Only the local development server on port 3000 is allowed.");
  baseUrl = url.origin;
}

function increment(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }
function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1)]);
}
function summary(kind) {
  const group = kind ? samples.filter((sample) => sample.kind === kind) : samples;
  const timings = group.map((sample) => sample.duration);
  return { requests: group.length, failures: group.filter((sample) => !sample.ok).length,
    errorRatePercent: group.length ? Number((group.filter((sample) => !sample.ok).length / group.length * 100).toFixed(3)) : 0,
    p50Ms: percentile(timings, 50), p95Ms: percentile(timings, 95), maxMs: timings.length ? Math.round(Math.max(...timings)) : null };
}

async function http(actor, path, body, { kind = body ? "command" : "poll", measure = true } = {}) {
  const begin = performance.now();
  let status = 0;
  let ok = false;
  let data = null;
  let errorCode;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
      headers: { Cookie: `km_session=${actor.token}`, ...(body ? { "Content-Type": "application/json", Origin: baseUrl } : {}) },
      ...(body ? { body: JSON.stringify({ slug, requestId: randomUUID(), ...body }) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    // Never print error bodies. Retain only a fixed, allowlisted error label.
    if (response.ok) { data = await response.json(); ok = data?.ok !== false; }
    else {
      const error = await response.json().catch(() => null);
      if (status === 503) errorCode = error?.error?.code === "DB_UNAVAILABLE" ? "DB_UNAVAILABLE" : "OTHER_503";
      else if (status === 409) errorCode = ["STALE_VERSION", "WRONG_PHASE", "INTRO_REQUIRED", "PAUSED", "GUESS_LOCKED"].includes(error?.error?.code) ? error.error.code : "OTHER_409";
    }
  } catch { /* Record only status=0, never error text or request headers. */ }
  const duration = performance.now() - begin;
  if (measure) {
    samples.push({ kind, duration, status, ok }); increment(statusCounts, String(status));
    if (!ok) increment(failures, `${kind}:${status}${errorCode ? `:${errorCode}` : ""}`);
  }
  return { ok, status, data, duration };
}

async function stateFor(actor, options) {
  const response = await http(actor, `/api/state?slug=${encodeURIComponent(slug)}`, undefined, options);
  if (response.ok && response.data?.event?.slug === slug && response.data?.me?.participantId === actor.id) {
    latestStates.set(actor.id, response.data);
    if (response.data.game) observedPhases.add(response.data.game.phase);
    return response.data;
  }
  return null;
}

async function createFixture() {
  const exists = await client.query("SELECT 1 FROM events WHERE slug=$1", [slug]);
  if (exists.rowCount) throw new Error("The synthetic slug is already in use.");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("The authentication configuration is missing.");
  actors = Array.from({ length: ACTOR_COUNT }, (_, index) => {
    const token = randomBytes(32).toString("base64url");
    return { id: randomUUID(), name: index < 18 ? `부하학생${String(index + 1).padStart(2, "0")}` : `부하운영진${"ABC"[index - 18]}`,
      role: index < 18 ? "student" : "operator", order: index + 1, token,
      hash: createHmac("sha256", secret).update(token).digest("hex") };
  });
  const id = randomUUID();
  const config = { studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
    operatorTeamByName: { "부하운영진A": "A", "부하운영진B": "B", "부하운영진C": "C" },
    blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24, presenceWindowSeconds: 15,
    pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30 };
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO events(id,slug,title,config_json,content_version) VALUES($1,$2,$3,$4,$5)",
      [id, slug, "KANT Mingle · 합성 부하 검증", JSON.stringify(config), "2026-09-22.1"]);
    for (const actor of actors) {
      await client.query(`INSERT INTO participants(id,event_id,display_name,role,roster_order,attendance,profile_completed_at)
        VALUES($1,$2,$3,$4,$5,'present',now())`, [actor.id, id, actor.name, actor.role, actor.order]);
      const answers = Array.from({ length: 20 }, (_, question) => ({ id: `Q${String(question + 1).padStart(2, "0")}`,
        option: ((actor.order * 7 + question * 5 + (actor.order ^ question)) % 11) < 5 ? "A" : "B" }));
      await client.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
        SELECT $1,$2,q.id,q.option,1 FROM jsonb_to_recordset($3::jsonb) AS q(id text,option char(1))`, [id, actor.id, JSON.stringify(answers)]);
      await client.query("INSERT INTO sessions(event_id,participant_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, actor.id, actor.hash]);
    }
    await client.query("UPDATE events SET host_participant_id=$2 WHERE id=$1", [id, actors[18].id]);
    await client.query("COMMIT"); fixtureId = id;
  } catch { await client.query("ROLLBACK").catch(() => {}); throw new Error("Synthetic fixture creation failed."); }
}

async function prepareGames() {
  const host = actors[18];
  let state = await stateFor(host, { kind: "setup", measure: false });
  // A successful read of a just-created private fixture proves the localhost app
  // is reading the verified development database, before HTTP mutations begin.
  if (!state || state.me.role !== "operator" || !state.me.isHost) throw new Error("Local server does not match the verified fixture.");
  for (const command of ["assign-teams", "publish-teams", "start-game1"]) {
    const response = await http(host, "/api/admin", { command, expectedVersion: state.versions.session, args: {} }, { kind: "setup", measure: false });
    if (!response.ok) throw new Error("Synthetic game startup failed.");
    state = await stateFor(host, { kind: "setup", measure: false });
    if (!state) throw new Error("Synthetic startup read failed.");
  }
}

async function pollActor(actor, index) {
  await sleep(index * POLL_MS / ACTOR_COUNT);
  let nextDue = performance.now();
  while (!stopping && performance.now() - measurementStart < DURATION_MS) {
    const state = await stateFor(actor);
    if (state?.poll.needsSync) await http(actor, "/api/state/sync", {}, { kind: "sync" });
    const game = state?.game;
    if (game?.pendingOverlay) {
      const key = `${actor.id}:${game.gameId}:${game.pendingOverlay.kind}:${game.pendingOverlay.cardNo ?? ""}`;
      if (!acknowledged.has(key)) {
        const response = await http(actor, "/api/game/intro-ack", { introKey: game.pendingOverlay.kind, gameId: game.gameId }, { kind: "intro" });
        if (response.ok) acknowledged.add(key);
      }
    }
    if (game?.ensemble?.stage === "VOTE" && state.allowedActions.includes("ensemble-vote")) {
      const key = `${actor.id}:${game.gameId}`;
      if (!voted.has(key)) {
        const candidate = game.candidates[index % game.candidates.length];
        const response = await http(actor, "/api/game/ensemble-vote", { gameId: game.gameId, pickId: candidate.participantId, revision: game.ensemble.myRevision ?? 0 }, { kind: "vote" });
        if (response.ok) voted.add(key);
      }
    }
    nextDue = Math.max(nextDue + POLL_MS, performance.now());
    await sleep(Math.max(0, nextDue - performance.now()));
  }
}

async function driveGame() {
  const host = actors[18];
  while (!stopping && performance.now() - measurementStart < DURATION_MS) {
    await sleep(3000);
    if (stopping) break;
    const state = await stateFor(host, { kind: "control-read" });
    if (!state) continue;
    if (state.event.phase === "BREAK") {
      await http(host, "/api/admin", { command: "publish-next-block", expectedVersion: state.versions.session, args: {} });
      continue;
    }
    for (const team of state.admin?.teams ?? []) {
      if (stopping) break;
      if (team.phase === "SEATING" || team.phase === "REVEAL") {
        await http(host, "/api/admin", { command: team.phase === "SEATING" ? "start-block-game" : "next-game", teamKey: team.key, expectedVersion: team.version, args: {} });
      } else if (team.stage === "ENSEMBLE_SHARE" || team.stage === "ENSEMBLE_DISCUSS") {
        await http(host, `/api/game/${team.stage === "ENSEMBLE_SHARE" ? "ensemble-shared" : "ensemble-end-discussion"}`,
          { gameId: team.gameId, gameVersion: team.gameVersion });
      } else if (team.stage === "TURN") {
        if (team.revealedCount >= 6) {
          await http(host, "/api/admin", { command: "force-end-game", teamKey: team.key, expectedVersion: team.version, args: {} });
        } else {
          const lead = actors.find((actor) => actor.name === team.turnLeadName);
          if (lead) await http(lead, "/api/game/more-data", { gameId: team.gameId, gameVersion: team.gameVersion, expectedCardCount: team.revealedCount });
        }
      }
    }
  }
}

async function connectionSample() {
  try {
    const result = await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()");
    connectionSamples.push({ elapsedSeconds: Math.round((performance.now() - measurementStart) / 1000), connections: result.rows[0].count });
  } catch { /* Statistics may be unavailable; do not log provider errors. */ }
}

async function removeFixture() {
  if (!client || !fixtureId) return false;
  await assertDevelopmentMarker(client);
  await client.query("BEGIN");
  try {
    const owned = await client.query("SELECT id FROM events WHERE id=$1 AND slug=$2 FOR UPDATE", [fixtureId, slug]);
    if (owned.rowCount !== 1) throw new Error("Fixture ownership check failed.");
    await client.query("DELETE FROM ground_truths WHERE game_id IN (SELECT id FROM games WHERE event_id=$1)", [fixtureId]);
    await client.query("UPDATE team_blocks SET current_game_id=NULL WHERE event_id=$1", [fixtureId]);
    await client.query("DELETE FROM games WHERE event_id=$1", [fixtureId]);
    await client.query("DELETE FROM team_blocks WHERE event_id=$1", [fixtureId]);
    await client.query("DELETE FROM teams WHERE event_id=$1", [fixtureId]);
    await client.query("DELETE FROM events WHERE id=$1 AND slug=$2", [fixtureId, slug]);
    await client.query("COMMIT"); fixtureId = undefined;
    return true;
  } catch { await client.query("ROLLBACK").catch(() => {}); throw new Error("Synthetic fixture cleanup failed."); }
}

try {
  validateArguments();
  loadLocalEnvironment();
  client = await openDevelopmentClient();
  await assertDevelopmentMarker(client);
  await createFixture();
  const warm = await http(actors[0], `/api/state?slug=${encodeURIComponent(slug)}`, undefined, { measure: false });
  if (!warm.ok || warm.data?.me?.participantId !== actors[0].id) throw new Error("Development fixture probe failed.");
  warmupMs = Math.round(warm.duration);
  await prepareGames();
  startedAt = new Date().toISOString(); measurementStart = performance.now();
  await connectionSample();
  console.log(JSON.stringify({ event: "load-test-start", startedAt, baseUrl, syntheticSlug: slug, actors: ACTOR_COUNT, pollIntervalMs: POLL_MS, durationSeconds: DURATION_MS / 1000 }));
  sampleTimer = setInterval(() => {
    console.log(JSON.stringify({ event: "load-test-progress", elapsedSeconds: Math.round((performance.now() - measurementStart) / 1000), poll: summary("poll"), totalRequests: samples.length,
      statuses: Object.fromEntries(statusCounts), failuresByKindAndStatus: Object.fromEntries(failures) }));
    void connectionSample();
  }, 30_000);
  await Promise.all([...actors.map(pollActor), driveGame()]);
  clearInterval(sampleTimer);
  await connectionSample();
  const elapsedSeconds = Number(((performance.now() - measurementStart) / 1000).toFixed(2));
  const poll = summary("poll");
  const unexpectedErrors = samples.filter((sample) => !sample.ok && sample.status !== 409).length;
  const result = { event: "load-test-result", startedAt, finishedAt: new Date().toISOString(), elapsedSeconds,
    baseUrl, syntheticSlug: slug, actors: ACTOR_COUNT, pollIntervalMs: POLL_MS,
    firstProbeMs: warmupMs, firstProbeIsColdStartEvidence: false, poll, total: summary(),
    actualPollRequestsPerSecond: Number((poll.requests / elapsedSeconds).toFixed(3)),
    statuses: Object.fromEntries(statusCounts), failuresByKindAndStatus: Object.fromEntries(failures),
    byKind: Object.fromEntries([...new Set(samples.map((sample) => sample.kind))].map((kind) => [kind, summary(kind)])),
    observedGamePhases: [...observedPhases].sort(), databaseConnectionSamples: connectionSamples,
    interrupted, criteria: { fullFiveMinutes: !interrupted && elapsedSeconds >= 300, pollP95Under2000Ms: poll.p95Ms !== null && poll.p95Ms < 2000, noPollErrors: poll.failures === 0, noUnexpectedHttpErrors: unexpectedErrors === 0 },
    limitations: ["Local Next.js development server, not Vercel production capacity.", "Database connection counts include other clients and cannot alone prove absence of a leak.", "Preseeded synthetic profiles and sessions; operator login and registration are not measured."] };
  result.fixtureRemoved = await removeFixture();
  console.log(JSON.stringify(result));
  if (!Object.values(result.criteria).every(Boolean)) process.exitCode = 1;
} catch {
  stopping = true;
  console.error("Load test failed. Only aggregate status data is retained; check local development prerequisites.");
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  if (fixtureId) {
    try { await removeFixture(); console.log("Synthetic load-test fixture removed."); }
    catch { console.error("Synthetic load-test cleanup needs a development-only retry."); process.exitCode = 1; }
  }
  actors = []; latestStates.clear();
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  if (client) await client.end().catch(() => {});
}
