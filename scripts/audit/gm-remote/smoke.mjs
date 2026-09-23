// Explicitly authorized synthetic Preview smoke only. Never outputs credentials,
// cookies, profile vectors, raw provider errors, or pre-reveal oracle values.
// Oracle-assisted protocol validation, NOT natural human inference or browser QA.
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker, projectRoot } from "../../helpers/database.mjs";
import { newOperatorCode, readOptions } from "../../helpers/event-admin.mjs";

class AuditFailure extends Error {}
const sleep = ms => new Promise(done => setTimeout(done, ms));
const report = { startedAt: new Date().toISOString(), kind: "remote-http-oracle-smoke", actors: 4,
  oracleAssisted: true, realMobileBrowsers: false, existingEventsTouched: false, checks: [], requests: [], stages: [] };
let client, createdEventId, slug, out, actors = [], stage = "arguments", lastRequest = 0;
const check = (label, condition, details = {}) => {
  report.checks.push({ label, passed: !!condition, ...details });
  if (!condition) throw new AuditFailure(label);
};
const progress = name => {
  stage = name; report.stages.push({ stage, at: new Date().toISOString() });
  console.log(JSON.stringify({ stage, checksPassed: report.checks.filter(row => row.passed).length }));
};
const must = (response, label, status = 200) => {
  check(label, response.status === status && (status !== 200 || response.json?.ok !== false),
    { status: response.status, ...(response.code ? { code: response.code } : {}) });
  return response;
};

class Actor {
  constructor(index, base) {
    this.index = index; this.key = `P${index}`; this.name = index === 0 ? "운영진A" : `학생0${index}`;
    this.base = base; this.jar = new Map(); this.state = null;
  }
  get pid() { return this.state?.me?.participantId; }
  async request(method, path, body) {
    await sleep(Math.max(0, 250 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    const headers = { Origin: this.base, "User-Agent": "KANT-GM-Authorized-Synthetic-HTTP-Smoke/1.0" };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const started = Date.now();
    let response;
    try { response = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000), redirect: "manual" }); }
    catch { report.requests.push({ actor: this.key, method, path: path.split("?")[0], status: 0, ms: Date.now() - started }); throw new AuditFailure("NETWORK_FAILURE"); }
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^(km_session(?:_[0-9a-f]{32})?)=([^;]*)/.exec(cookie);
      if (match) { if (match[2]) this.jar.set(match[1], match[2]); else this.jar.delete(match[1]); }
    }
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    const code = /^[A-Z_]{1,64}$/.test(json?.error?.code ?? "") ? json.error.code : null;
    report.requests.push({ actor: this.key, method, path: path.split("?")[0], status: response.status,
      code, ms: Date.now() - started, bytes: Buffer.byteLength(text) });
    return { status: response.status, json, code };
  }
  command(path, values = {}) { return this.request("POST", path, { slug, requestId: randomUUID(), ...values }); }
  async refresh(ack = true) {
    const result = must(await this.request("GET", `/api/state?slug=${encodeURIComponent(slug)}`), `${this.key}:state`);
    this.state = result.json;
    if (this.state.poll?.needsSync) {
      must(await this.command("/api/state/sync"), `${this.key}:sync`);
      return this.refresh(ack);
    }
    const game = this.state.game;
    if (game && game.phase !== "REVEALED") {
      const serialized = JSON.stringify(game);
      check(`${this.key}:private-game-fields-absent`, !/"(?:ownerId|owner_participant_id|ownerActualText|noise_slots|noiseSlots|rng_seed|rngSeed|is_noise|isNoise|true_option|trueOption)"/.test(serialized));
      check(`${this.key}:selection-logs-absent`, !(this.state.admin?.recentLogs ?? []).some(log => /FALLBACK|owner_fallback/.test(log.command)));
    }
    if (ack && game?.pendingOverlay) {
      must(await this.command("/api/game/intro-ack", { gameId: game.gameId, introKey: game.pendingOverlay.kind }), `${this.key}:overlay-ack`);
      return this.refresh(ack);
    }
    return this.state;
  }
}

const host = () => actors[0];
const byId = id => actors.find(actor => actor.pid === id);
async function admin(command, args = {}, actor = host(), expectedStatus = 200, overrideVersion) {
  const state = await actor.refresh();
  const sessionCommands = new Set(["assign-teams", "publish-teams", "start-game1", "request-rotation", "cancel-rotation", "publish-next-block", "end-session"]);
  const gameCommands = new Set(["open-guess", "close-guess", "transfer-turn-lead", "resend-data"]);
  const team = state.admin?.teams.find(row => row.key === "A");
  const version = overrideVersion ?? (sessionCommands.has(command) ? state.versions.session : gameCommands.has(command) ? team?.gameVersion : team?.version);
  return must(await actor.command("/api/admin", { command, teamKey: "A", expectedVersion: version, args }), `${actor.key}:${command}`, expectedStatus);
}
async function gameCommand(actor, command, extra = {}, expectedStatus = 200) {
  const state = await actor.refresh();
  check(`${command}:active-game-present`, !!state.game);
  return must(await actor.command(`/api/game/${command}`, { gameId: state.game.gameId, gameVersion: state.versions.game,
    expectedCardCount: state.game.cards.length, ...extra }), `${actor.key}:${command}`, expectedStatus);
}
async function gameOracle() {
  const state = await host().refresh();
  const result = await client.query(`SELECT g.owner_participant_id,
    ARRAY(SELECT card_no::integer FROM data_cards WHERE game_id=g.id AND is_noise ORDER BY card_no) AS noise_picks
    FROM games g WHERE g.id=$1 AND g.event_id=$2`, [state.game.gameId, createdEventId]);
  if (result.rowCount !== 1) throw new AuditFailure("ORACLE_EVENT_GUARD");
  return { ownerPick: result.rows[0].owner_participant_id, noisePicks: result.rows[0].noise_picks };
}
async function handleEnsemble() {
  let state = await host().refresh();
  if (state.game.phase !== "ENSEMBLE_SHARE") return;
  progress(`game-${state.game.gameNo}-ensemble-real-30-seconds`);
  await gameCommand(actors[1], "ensemble-shared", {}, 403);
  await gameCommand(host(), "ensemble-shared");
  for (const actor of actors) {
    state = await actor.refresh();
    must(await actor.command("/api/game/ensemble-vote", { gameId: state.game.gameId,
      pickId: state.game.candidates[actor.index % state.game.candidates.length].participantId,
      revision: state.game.ensemble.myRevision ?? 0 }), `${actor.key}:ensemble-vote`);
  }
  state = await host().refresh();
  const deadline = Date.now() + Math.max(0, Date.parse(state.game.ensemble.voteDeadline) - Date.parse(state.serverNow));
  while (Date.now() < deadline + 150) await sleep(Math.min(5000, deadline + 150 - Date.now()));
  state = await host().refresh();
  check("ensemble-votes-total-four", state.game.phase === "ENSEMBLE_DISCUSS" && state.game.ensemble.results.reduce((n, row) => n + row.votes, 0) === 4);
  await gameCommand(actors[1], "ensemble-end-discussion", {}, 403);
  await gameCommand(host(), "ensemble-end-discussion");
}
async function toThreeCards() {
  for (let iteration = 0; iteration < 8; iteration++) {
    const state = await host().refresh();
    if (state.game.phase === "ENSEMBLE_SHARE") { await handleEnsemble(); continue; }
    if (state.game.phase === "TURN" && state.game.cards.length >= 3) return;
    await gameCommand(host(), "next-card");
  }
  throw new AuditFailure("CARD_PROGRESS_LIMIT");
}
async function correctGuess() {
  const oracle = await gameOracle();
  await admin("open-guess");
  const state = await host().refresh();
  const lead = byId(state.game.turnLead.participantId);
  check("eligible-lead-is-an-audit-actor", !!lead);
  const result = await gameCommand(lead, "guess", oracle);
  check("oracle-assisted-correct-guess", result.json.correct === true);
  for (const actor of actors) {
    const recovered = await actor.refresh();
    check(`${actor.key}:reveal-recovered`, recovered.game?.phase === "REVEALED" && recovered.team?.phase === "REVEAL" && recovered.event.phase === "BLOCK");
  }
}
async function seatRows(block) {
  return (await client.query("SELECT participant_id,seat_no FROM block_assignments WHERE event_id=$1 AND block_no=$2 ORDER BY seat_no", [createdEventId, block])).rows;
}

async function teardown() {
  if (!client || !createdEventId) return;
  let endedViaHttp = false;
  try {
    if (host()?.pid) {
      const state = await host().refresh(false);
      if (state.event.phase !== "ENDED") await admin("end-session", { confirm: true });
      endedViaHttp = true;
    }
  } catch { /* Cleanup is restricted to the event created by this process. */ }
  await client.query("BEGIN");
  try {
    await assertDevelopmentMarker(client);
    const event = (await client.query("SELECT phase FROM events WHERE id=$1 AND slug=$2 AND config_json->>'gameplayMode'='gm' FOR UPDATE", [createdEventId, slug])).rows[0];
    if (!event || !/^dev-gm-audit-20260923-[0-9a-f]{8}$/.test(slug)) throw new AuditFailure("CLEANUP_EVENT_GUARD");
    if (event.phase !== "ENDED") {
      await client.query(`UPDATE games SET phase='REVEALED',end_reason='session_end',revealed_at=clock_timestamp(),
        vote_deadline=NULL,vote_remaining_ms=NULL,gm_guess_open=false,game_version=game_version+1
        WHERE event_id=$1 AND phase<>'REVEALED'`, [createdEventId]);
      await client.query("UPDATE team_blocks SET phase='REVEAL',paused_at=NULL WHERE event_id=$1 AND phase='IN_GAME'", [createdEventId]);
      await client.query("UPDATE events SET phase='ENDED',ended_at=clock_timestamp(),session_version=session_version+1 WHERE id=$1", [createdEventId]);
    }
    const revoked = await client.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE event_id=$1 AND revoked_at IS NULL", [createdEventId]);
    await client.query("UPDATE participants SET operator_code_hash=NULL WHERE event_id=$1 AND role='operator'", [createdEventId]);
    await client.query("COMMIT");
    report.teardown = { ended: true, endedViaHttp, revokedSessions: revoked.rowCount, operatorCodeCleared: true, existingEventsTouched: false };
    actors.forEach(actor => actor.jar.clear());
  } catch { await client.query("ROLLBACK").catch(() => {}); throw new AuditFailure("TEARDOWN_FAILED"); }
}

try {
  const options = readOptions(process.argv.slice(2), ["--base", "--out"], ["--allow-remote"]);
  const url = new URL(options.base);
  if (!options["allow-remote"] || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash ||
      !/^whos-data-[a-z0-9]+-dallas9115-4145s-projects\.vercel\.app$/.test(url.hostname)) throw new AuditFailure("EXPLICIT_PREVIEW_TARGET_REQUIRED");
  slug = `dev-gm-audit-20260923-${randomBytes(4).toString("hex")}`;
  out = resolve(options.out ?? resolve(process.env.USERPROFILE ?? projectRoot, ".codex/private/kant-mingling", slug));
  mkdirSync(out, { recursive: true });
  Object.assign(report, { base: url.origin, slug, outputDirectory: out });
  actors = Array.from({ length: 4 }, (_, index) => new Actor(index, url.origin));
  progress("health-and-development-guards");
  must(await host().request("GET", "/api/health"), "preview-health");
  loadLocalEnvironment(); client = await openDevelopmentClient(); await assertDevelopmentMarker(client);
  check("gm-migration-present", (await client.query("SELECT 1 FROM information_schema.columns WHERE table_name='games' AND column_name='gm_guess_open'")).rowCount === 1);
  const rosterFile = resolve(out, "roster.local.json");
  writeFileSync(rosterFile, JSON.stringify({ title: "GM 원격 합성 검증", students: ["학생01", "학생02", "학생03"],
    operators: [{ name: "운영진A", team: "A" }], host: "운영진A", gameplayMode: "gm", moveCountPerTeam: 0 }));
  const seed = spawnSync(process.execPath, ["scripts/seed-event.mjs", "--roster", rosterFile, "--slug", slug, "--synthetic"],
    { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  check("new-synthetic-event-seeded", seed.status === 0);
  const event = (await client.query("SELECT id,host_participant_id FROM events WHERE slug=$1 AND config_json->>'gameplayMode'='gm'", [slug])).rows[0];
  if (!event) throw new AuditFailure("SEEDED_EVENT_NOT_FOUND");
  createdEventId = event.id;
  const operator = await newOperatorCode();
  const issued = await client.query("UPDATE participants SET operator_code_hash=$3 WHERE id=$1 AND event_id=$2 AND operator_code_hash IS NULL", [event.host_participant_id, createdEventId, operator.hash]);
  check("ephemeral-operator-code-issued", issued.rowCount === 1);
  for (const actor of actors) {
    progress(`${actor.key}-registration-and-profile`);
    must(await actor.command("/api/session/bootstrap"), `${actor.key}:bootstrap`);
    check(`${actor.key}:event-scoped-cookie`, [...actor.jar.keys()].some(name => /^km_session_[0-9a-f]{32}$/.test(name)));
    const state = await actor.refresh();
    const person = state.roster.find(row => row.displayName === actor.name);
    check(`${actor.key}:synthetic-roster-entry`, !!person);
    must(await actor.command(actor.index === 0 ? "/api/session/operator" : "/api/session/claim",
      { participantId: person.participantId, ...(actor.index === 0 ? { code: operator.code } : {}) }), `${actor.key}:claim`);
    must(await actor.command("/api/game/intro-ack", { introKey: "tutorial" }), `${actor.key}:tutorial-ack`);
    for (let question = 1; question <= 20; question++) {
      must(await actor.request("PATCH", "/api/profile", { slug, questionId: `Q${String(question).padStart(2, "0")}`,
        option: (actor.index + question) % 4 < 2 ? "A" : "B", revision: 0 }), `${actor.key}:profile-${question}`);
    }
    must(await actor.command("/api/profile/submit"), `${actor.key}:profile-submit`);
    check(`${actor.key}:profile-complete-recovered`, (await actor.refresh()).me.profileComplete);
  }
  operator.code = null; operator.hash = null;
  progress("first-game-gm-gate-and-pause");
  await admin("assign-teams"); await admin("publish-teams"); await admin("start-game1");
  let state = await host().refresh();
  check("gm-mode-active", state.event.gameplayMode === "gm" && state.game.gameNo === 1 && !state.game.gm.guessOpen);
  const firstSeats = await seatRows(1);
  await gameCommand(actors[1], "next-card", {}, 403);
  await gameCommand(actors[1], "more-data", {}, 403);
  await admin("open-guess", {}, actors[1], 403, state.versions.game);
  const initialLead = byId(state.game.turnLead.participantId);
  const oracle = await gameOracle();
  const closed = await gameCommand(initialLead, "guess", oracle, 409);
  check("server-enforces-closed-gate", closed.code === "GM_GUESS_CLOSED");
  await admin("open-guess");
  check("gm-open-recovered", (await initialLead.refresh()).game.guess.enabled);
  await admin("pause");
  const paused = await gameCommand(initialLead, "guess", oracle, 409);
  check("paused-guess-rejected", paused.code === "PAUSED");
  await admin("resume"); await admin("close-guess");
  check("gm-close-recovered", !(await initialLead.refresh()).game.guess.enabled);
  await admin("open-guess"); await gameCommand(host(), "next-card");
  check("new-card-closes-gate", !(await host().refresh()).game.gm.guessOpen);
  await handleEnsemble();
  await correctGuess();
  state = await host().refresh();
  check("first-game-no-noise", state.game.reveal.cards.every(card => card.status !== "NOISE"));
  const previousGameVersion = state.versions.game;
  progress("noise-cap-two-early-correct");
  await admin("gm-next-game", { noiseCap: 2, groundTruth: false });
  const stale = await admin("open-guess", {}, host(), 409, previousGameVersion);
  check("previous-game-command-stale", stale.code === "STALE_VERSION");
  await toThreeCards(); await correctGuess();
  state = await host().refresh();
  const earlyNoise = state.game.reveal.cards.filter(card => card.status === "NOISE").length;
  check("early-correct-before-noise-maximum", state.game.reveal.cards.length === 3 && earlyNoise < 2 && earlyNoise <= 2);
  report.earlyCorrect = { revealedCards: 3, actualNoiseAtReveal: earlyNoise, configuredNoiseMaximum: 2 };
  progress("rotation-barrier-and-next-seat-round");
  await admin("gm-next-game", { noiseCap: 0, groundTruth: false });
  await admin("request-rotation");
  await admin("rotation-ready", {}, host(), 409);
  const blockedNext = await admin("gm-next-game", { noiseCap: 0 }, host(), 409);
  check("rotation-blocks-new-game", blockedNext.code === "ROTATION_PENDING");
  await admin("force-end-game"); await admin("rotation-ready");
  state = await host().refresh();
  check("all-ready-enters-break", state.event.phase === "BREAK" && state.admin.teams[0].rotationReady);
  const previousTeamVersion = state.admin.teams[0].version;
  await admin("publish-next-block");
  state = await host().refresh();
  check("seat-round-two-without-reentry", state.event.currentBlock === 2 && state.team.phase === "SEATING");
  check("single-team-seat-order-preserved", JSON.stringify(await seatRows(2)) === JSON.stringify(firstSeats));
  await admin("start-block-game", { noiseCap: 0, groundTruth: false }, host(), 409, previousTeamVersion);
  await admin("start-block-game", { noiseCap: 0, groundTruth: false });
  state = await host().refresh();
  check("game-number-independent-of-seat-round", state.event.currentBlock === 2 && state.game.gameNo === 4);
  progress("end-and-recovery"); await admin("end-session", { confirm: true });
  for (const actor of actors) check(`${actor.key}:ended-recovered`, (await actor.refresh(false)).event.phase === "ENDED");
  must(await actors[1].command("/api/game/next-card", { gameId: state.game.gameId, gameVersion: state.versions.game, expectedCardCount: 1 }), "ended-command-rejected", 410);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { stage, label: error instanceof AuditFailure ? error.message : "UNEXPECTED_FAILURE_REDACTED" };
  process.exitCode = 1;
} finally {
  try { await teardown(); } catch { report.passed = false; report.teardown = { ended: false, error: "TEARDOWN_FAILED_REDACTED" }; process.exitCode = 1; }
  if (client) await client.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.summary = { passedChecks: report.checks.filter(row => row.passed).length, failedChecks: report.checks.filter(row => !row.passed).length,
    httpRequests: report.requests.length, serverErrors: report.requests.filter(row => row.status >= 500).length,
    networkErrors: report.requests.filter(row => row.status === 0).length };
  if (out) writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, slug, summary: report.summary, teardown: report.teardown,
    ...(report.failure ? { failure: report.failure } : {}), ...(out ? { report: resolve(out, "report.json") } : {}) }));
}
