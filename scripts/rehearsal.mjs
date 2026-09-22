import { createServer, request as proxyRequest } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker, projectRoot } from "./helpers/database.mjs";
import { isLocalRequest, isAllowedActorPath, validateActorPayload } from "./rehearsal/guards.mjs";

// A local test driver only. No route or credential bypass is installed in Next.
const APP = "http://127.0.0.1:3002";
const APP_ORIGIN = "http://localhost:3002";
const LAB = "http://127.0.0.1:3100";
const servers = [];
const ownedEvents = [];
const jobs = new Map();
let current;
let child;
let stopping = false;
let restarting = false;
let botsEnabled = true;
let selectedKey = "p19";
let lastVisit = Date.now();
let error = null;
let uiHtml;
let uiJs;
let startupStage = "configuration";
let startupTask;
let restartTask;
let stopTask;
let childExitTask;

function ensureRunning() {
  if (stopping) throw new Error("Rehearsal is stopping.");
}

function closeServer(server) {
  return new Promise(done => {
    server.closeAllConnections?.();
    try { server.close(() => done()); } catch { done(); }
  });
}

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Body too large.");
    chunks.push(chunk);
  }
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("JSON required.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function appCall(ctx, actor, path, body) {
  ensureRunning();
  const response = await fetch(`${APP}${path}`, {
    method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
    headers: { Cookie: `km_session=${actor.token}`, ...(body ? { Origin: APP_ORIGIN, "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify({ slug: ctx.slug, requestId: randomUUID(), ...body }) } : {}),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  ensureRunning();
  if (!response.ok) {
    const failure = new Error("The local application rejected a rehearsal request.");
    failure.code = ["BAD_ORIGIN", "INVALID_REQUEST", "STALE_VERSION", "UNAUTHENTICATED", "FORBIDDEN", "DB_UNAVAILABLE", "INCOMPLETE"].includes(data?.error?.code) ? data.error.code : `HTTP_${response.status}`;
    throw failure;
  }
  return data;
}

async function stateFor(ctx, actor) {
  const state = await appCall(ctx, actor, `/api/state?slug=${ctx.slug}`);
  if (state.event?.slug !== ctx.slug || state.me?.participantId !== actor.id) throw new Error("Rehearsal identity mismatch.");
  ctx.states.set(actor.key, state);
  return state;
}

async function createFixture() {
  ensureRunning();
  startupStage = "synthetic-database-setup";
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Missing local authentication configuration.");
  const ctx = { id: randomUUID(), slug: `dev-play-${randomBytes(6).toString("hex")}`, states: new Map(), actors: [] };
  ctx.actors = Array.from({ length: 21 }, (_, index) => {
    const token = randomBytes(32).toString("base64url");
    return { id: randomUUID(), key: `p${String(index + 1).padStart(2, "0")}`, order: index + 1,
      name: index < 18 ? `학생${String(index + 1).padStart(2, "0")}` : `운영진${"ABC"[index - 18]}`,
      role: index < 18 ? "student" : "operator", token, hash: createHmac("sha256", secret).update(token).digest("hex") };
  });
  const config = { studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
    operatorTeamByName: { "운영진A": "A", "운영진B": "B", "운영진C": "C" },
    blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24, presenceWindowSeconds: 15,
    pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30 };
  const db = await openDevelopmentClient();
  try {
    ensureRunning();
    await assertDevelopmentMarker(db);
    ensureRunning();
    await db.query("BEGIN");
    ensureRunning();
    await db.query("INSERT INTO events(id,slug,title,config_json,content_version) VALUES($1,$2,$3,$4,$5)",
      [ctx.id, ctx.slug, "KANT Mingling · 21명 플레이 리허설", JSON.stringify(config), "2026-09-22.1"]);
    ensureRunning();
    await db.query(`INSERT INTO participants(id,event_id,display_name,role,roster_order,attendance,profile_completed_at)
      SELECT p.id,$1,p.name,p.role,p.ord,'present',clock_timestamp() FROM jsonb_to_recordset($2::jsonb)
      AS p(id uuid,name text,role text,ord smallint)`,
    [ctx.id, JSON.stringify(ctx.actors.map(a => ({ id: a.id, name: a.name, role: a.role, ord: a.order })))]);
    ensureRunning();
    await db.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
      SELECT p.event_id,p.id,'Q'||lpad(n::text,2,'0'),CASE WHEN (p.roster_order*7+n*3+(p.roster_order*n)%5)%11<6 THEN 'A' ELSE 'B' END,1
      FROM participants p CROSS JOIN generate_series(1,20) n WHERE p.event_id=$1`, [ctx.id]);
    ensureRunning();
    await db.query(`INSERT INTO sessions(event_id,participant_id,token_hash,expires_at)
      SELECT $1,s.id,s.hash,clock_timestamp()+interval '24 hours' FROM jsonb_to_recordset($2::jsonb) AS s(id uuid,hash text)`,
    [ctx.id, JSON.stringify(ctx.actors.map(a => ({ id: a.id, hash: a.hash })))]);
    ensureRunning();
    await db.query("UPDATE events SET host_participant_id=$2 WHERE id=$1", [ctx.id, ctx.actors[18].id]);
    ensureRunning();
    await db.query("COMMIT");
    // Record ownership even if shutdown began while COMMIT was in flight.
    ownedEvents.push(ctx.id);
  } catch (failure) { await db.query("ROLLBACK").catch(() => {}); throw failure; }
  finally { await db.end(); }
  ensureRunning();
  const host = ctx.actors[18];
  startupStage = "synthetic-app-identity-check";
  // A read of this newly generated ID proves that the app uses the guarded DB.
  let state = await stateFor(ctx, host);
  if (!state.me.isHost) throw new Error("Local fixture verification failed.");
  for (const command of ["assign-teams", "publish-teams", "start-game1"]) {
    startupStage = command;
    await appCall(ctx, host, "/api/admin", { command, expectedVersion: state.versions.session, args: {} });
    state = await stateFor(ctx, host);
  }
  await Promise.all(ctx.actors.map(actor => stateFor(ctx, actor)));
  ensureRunning();
  return ctx;
}

function labState() {
  const ctx = current;
  if (!ctx) return { active: false, error, actors: [], teams: [], botsEnabled, selectedKey };
  const host = ctx.states.get("p19");
  const actorById = id => ctx.actors.find(a => a.id === id);
  const actorByName = name => ctx.actors.find(a => a.name === name);
  const groups = host?.admin?.teams ?? [];
  // Explicit allowlist: no profiles, Data text, votes, or answer fields here.
  return { slug: ctx.slug, active: !restarting && !stopping, botsEnabled, selectedKey, error,
    eventPhase: host?.event.phase, currentBlock: host?.event.currentBlock,
    actors: ctx.actors.map((actor, index) => ({ key: actor.key, name: actor.name, role: actor.role,
      url: `http://127.0.0.1:${3101 + index}/e/${ctx.slug}`,
      teamKey: groups.find(g => g.members.some(m => m.participantId === actor.id))?.key ?? null })),
    teams: groups.map(group => {
      const operator = actorByName(group.operatorName);
      const operatorGame = ctx.states.get(operator?.key)?.game;
      const sharer = operatorGame?.gameId === group.gameId ? actorById(operatorGame?.ensemble?.sharer.participantId) : null;
      return { key: group.key, gameNo: group.gameNo, phase: group.stage ?? group.phase, paused: group.paused,
        cardCount: group.revealedCount, leadKey: actorByName(group.turnLeadName)?.key ?? null,
        leadName: group.turnLeadName, sharerKey: sharer?.key ?? null, sharerName: sharer?.name ?? null };
    }) };
}

async function simulateActor(ctx, actor) {
  const state = await stateFor(ctx, actor);
  if (ctx !== current || stopping || restarting) return;
  if (state.poll.needsSync) await appCall(ctx, actor, "/api/state/sync", {});
  if (!botsEnabled || selectedKey === actor.key || state.team?.paused) return;
  const game = state.game;
  if (game?.pendingOverlay) await appCall(ctx, actor, "/api/game/intro-ack", { gameId: game.gameId, introKey: game.pendingOverlay.kind });
  if (ctx !== current || selectedKey === actor.key || !botsEnabled) return;
  if (game?.ensemble?.stage === "VOTE" && !game.ensemble.myVote && state.allowedActions.includes("ensemble-vote")) {
    const pick = game.candidates[(actor.order + game.gameNo) % game.candidates.length];
    await appCall(ctx, actor, "/api/game/ensemble-vote", { gameId: game.gameId, pickId: pick.participantId, revision: game.ensemble.myRevision ?? 0 });
  }
}

async function actorLoop(index) {
  await sleep(index * 200);
  while (!stopping) {
    const ctx = current;
    if (ctx && !restarting && Date.now() - lastVisit < 30_000) {
      const actor = ctx.actors[index];
      const job = simulateActor(ctx, actor).catch(() => { /* Races with UI actions are retried on the next poll. */ });
      jobs.set(actor.key, job);
      await job;
      if (jobs.get(actor.key) === job) jobs.delete(actor.key);
    }
    await sleep(3000);
  }
}

function requestInfo(req) {
  return { host: req.headers.host, origin: req.headers.origin, method: req.method, fetchSite: req.headers["sec-fetch-site"] };
}

async function controller(req, res) {
  if (!isLocalRequest(requestInfo(req), 3100)) return reply(res, 403, { error: "LOCAL_ONLY" });
  if (stopping) return reply(res, 503, { error: "REHEARSAL_PREPARING" });
  const url = new URL(req.url, LAB);
  if (req.method === "GET" && ["/", "/lab.js"].includes(url.pathname)) {
    res.writeHead(200, { "Content-Type": url.pathname === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; object-src 'none'; base-uri 'none'" });
    return res.end(url.pathname === "/" ? uiHtml : uiJs);
  }
  if (req.method === "GET" && url.pathname === "/lab/state") {
    lastVisit = Date.now();
    return reply(res, 200, labState());
  }
  if (req.method !== "POST") return reply(res, 404, { error: "NOT_FOUND" });
  const body = await bodyJson(req);
  ensureRunning();
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply(res, 400, { error: "INVALID_REQUEST" });
  if (url.pathname === "/lab/select" && current?.actors.some(a => a.key === body.key)) {
    selectedKey = body.key;
    await jobs.get(selectedKey);
    return reply(res, 200, { ok: true });
  }
  if (url.pathname === "/lab/bots" && typeof body.enabled === "boolean") {
    botsEnabled = body.enabled;
    return reply(res, 200, { ok: true });
  }
  if (url.pathname === "/lab/restart") {
    if (!current) return reply(res, 503, { error: "REHEARSAL_PREPARING" });
    if (restarting) return reply(res, 409, { error: "ALREADY_RESTARTING" });
    restarting = true; error = null;
    restartTask = createFixture().then(ctx => { ensureRunning(); current = ctx; selectedKey = "p19"; lastVisit = Date.now(); })
      .catch(() => { if (!stopping) error = "새 리허설 준비에 실패했어요. 잠시 후 다시 시도해주세요."; })
      .finally(() => { restarting = false; });
    return reply(res, 202, { ok: true });
  }
  return reply(res, 400, { error: "INVALID_REQUEST" });
}

async function proxyActor(req, res, index) {
  const port = 3101 + index;
  if (!isLocalRequest(requestInfo(req), port)) return reply(res, 403, { error: "LOCAL_ONLY" });
  const ctx = current;
  if (!ctx || restarting || stopping) return reply(res, 503, { error: "REHEARSAL_PREPARING" });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (!isAllowedActorPath(req.method, req.url.split("?")[0], ctx.slug)) return reply(res, 404, { error: "NOT_FOUND" });
  if (url.pathname === "/") { res.writeHead(302, { Location: `/e/${ctx.slug}` }); return res.end(); }
  if (url.pathname === "/api/state" && (url.searchParams.getAll("slug").length !== 1 || url.searchParams.get("slug") !== ctx.slug)) return reply(res, 403, { error: "WRONG_EVENT" });
  if (req.method === "GET" && (url.pathname === "/api/state" || url.pathname === `/e/${ctx.slug}`)) lastVisit = Date.now();
  let body;
  if (["POST", "PATCH"].includes(req.method)) {
    body = await bodyJson(req);
    ensureRunning();
    if (!validateActorPayload(url.pathname, body, ctx.slug)) return reply(res, 403, { error: "WRONG_EVENT" });
  }
  const actor = ctx.actors[index];
  const tokenAtStart = actor.token;
  const headers = { Host: "127.0.0.1:3002", Cookie: `km_session=${tokenAtStart}`, "Accept-Encoding": "identity" };
  for (const key of ["accept", "accept-language", "content-type", "rsc", "next-router-state-tree", "next-router-prefetch", "next-url"]) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  const encoded = body ? Buffer.from(JSON.stringify(body)) : null;
  if (encoded) { headers.Origin = APP_ORIGIN; headers["Content-Length"] = encoded.length; }
  // Raw HTTP streaming preserves compressed body/header consistency. Cookies
  // from the browser are never used: browsers do NOT isolate cookies by port.
  const upstream = proxyRequest(`${APP}${url.pathname}${url.search}`, { method: req.method, headers }, response => {
    if (ctx === current && actor.token === tokenAtStart) for (const cookie of response.headers["set-cookie"] ?? []) {
      const match = /^km_session=([A-Za-z0-9_-]{43});/.exec(cookie);
      if (match) actor.token = match[1];
    }
    const clean = { ...response.headers, "cache-control": "no-store", "content-security-policy": `frame-ancestors ${LAB} 'self'` };
    for (const name of ["set-cookie", "connection", "keep-alive", "transfer-encoding", "access-control-allow-origin", "access-control-allow-credentials"]) delete clean[name];
    if (clean.location) delete clean.location;
    res.writeHead(response.statusCode ?? 502, clean);
    response.pipe(res);
  });
  upstream.setTimeout(15_000, () => upstream.destroy());
  upstream.on("error", () => { if (!res.headersSent) reply(res, 502, { error: "LOCAL_APP_UNAVAILABLE" }); else res.destroy(); });
  res.on("close", () => upstream.destroy());
  upstream.end(encoded);
}

async function listen(port, handler) {
  ensureRunning();
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { if (!res.headersSent) reply(res, 400, { error: "REQUEST_FAILED" }); else res.destroy(); });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  // Register before awaiting bind so shutdown also owns an in-flight listener.
  servers.push(server);
  try {
    await new Promise((done, fail) => {
      server.once("error", fail);
      // close() can cancel a pending bind without emitting listening or error.
      server.once("close", () => fail(new Error("Rehearsal listener closed during startup.")));
      server.listen(port, "127.0.0.1", done);
    });
    ensureRunning();
  } catch (failure) {
    await closeServer(server);
    throw failure;
  }
}

async function startApp() {
  ensureRunning();
  const probe = createPortProbe();
  try {
    await new Promise((done, fail) => { probe.once("error", fail); probe.listen(3002, "127.0.0.1", done); });
  } finally { await closeServer(probe); }
  ensureRunning();
  child = spawn(process.execPath, [resolve(projectRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3002"],
    { cwd: projectRoot, env: { ...process.env, NODE_ENV: "production", VERCEL: "0" }, stdio: "ignore", windowsHide: true });
  childExitTask = new Promise(done => {
    child.once("error", () => { error = "로컬 앱을 시작하지 못했어요."; done(); });
    child.once("exit", () => {
      done();
      if (!stopping && current) {
        error = "로컬 앱이 종료되어 리허설을 정리하고 있어요.";
        process.exitCode = 1;
        console.error("Local application stopped. Closing the rehearsal.");
        void stop();
      }
    });
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    ensureRunning();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error("The local app stopped.");
    let ready = false;
    try { ready = (await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* Wait for our child only. */ }
    ensureRunning();
    if (ready) return;
    await sleep(250);
  }
  throw new Error("The local app did not become ready.");
}

function stop() {
  if (stopTask) return stopTask;
  stopping = true;
  stopTask = (async () => {
    const closing = servers.map(closeServer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
    // These promises contain initialization only, never a call awaiting stop().
    // Waiting before revocation includes any COMMIT that won the signal race.
    await Promise.allSettled([startupTask, restartTask, childExitTask, ...jobs.values(), ...closing].filter(Boolean));
    // An in-flight bind may have completed while the first close was pending.
    await Promise.all(servers.map(closeServer));
    // Preserve synthetic history; revoke access only for this process's events.
    if (ownedEvents.length) {
      let db;
      try {
        db = await openDevelopmentClient(); await assertDevelopmentMarker(db);
        await db.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE event_id=ANY($1::uuid[])", [ownedEvents]);
      } catch { /* Session TTL is a fallback; never print provider errors. */ }
      finally { if (db) await db.end().catch(() => {}); }
    }
    console.log("Rehearsal stopped. Synthetic history retained; restart creates a fresh event.");
  })();
  return stopTask;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
async function initialize() {
  ensureRunning();
  if (process.argv.length !== 2) throw new Error("This tool accepts no remote endpoint or existing event arguments.");
  loadLocalEnvironment();
  [uiHtml, uiJs] = await Promise.all([readFile(new URL("./rehearsal/ui.html", import.meta.url)), readFile(new URL("./rehearsal/ui.js", import.meta.url))]);
  ensureRunning();
  // Reserve loopback ports before creating any fixture. Existing services remain untouched.
  startupStage = "reserve-loopback-ports";
  await listen(3100, controller);
  for (let index = 0; index < 21; index++) await listen(3101 + index, (req, res) => proxyActor(req, res, index));
  startupStage = "start-local-next-app";
  await startApp();
  ensureRunning();
  current = await createFixture();
  ensureRunning();
  console.log(`21-person rehearsal ready: ${LAB}`);
  console.log(`Synthetic event: ${current.slug}. All profiles complete; A/B/C Game 1 started.`);
  console.log("Select an actor in the local dashboard. Tokens and operator codes are not shown.");
  for (let index = 0; index < 21; index++) void actorLoop(index);
}

// Keep error handling outside the tracked task to avoid stop -> startup -> stop.
startupTask = initialize();
try {
  await startupTask;
} catch (failure) {
  if (!stopping) {
    const code = typeof failure?.code === "string" && /^[A-Z0-9_]{2,28}$/.test(failure.code) ? failure.code : "UNAVAILABLE";
    console.error(`Rehearsal startup failed at ${startupStage} (${code}). Check the local build, development DB and ports 3002 / 3100–3121.`);
    process.exitCode = 1;
  }
  await stop();
}
