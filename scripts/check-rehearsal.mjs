import { request } from "node:http";

// Read-only local rehearsal verification. No environment, DB, or credentials.
const HOST = "127.0.0.1";
const LAB_PORT = 3100;
const LAB_ORIGIN = "http://127.0.0.1:3100";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
let checks = 0;

function verify(condition, label) {
  checks += 1;
  if (!condition) throw new Error(label);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowKeys(value, keys, label) {
  verify(object(value) && Object.keys(value).every(key => keys.includes(key)), label);
}

function localRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      hostname: HOST, port, path, method,
      headers: { Accept: "application/json", ...headers, ...(encoded ? { "Content-Type": "application/json", "Content-Length": encoded.length } : {}) },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error("Local response exceeded the verification limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new Error("Local endpoint returned invalid JSON.")); return; }
        resolve({ status: response.statusCode, hasCookie: Boolean(response.headers["set-cookie"]), data });
      });
      response.on("error", () => reject(new Error("Local response was interrupted.")));
    });
    req.setTimeout(20_000, () => req.destroy(new Error("Local verification timed out.")));
    req.on("error", () => reject(new Error("Local rehearsal request failed.")));
    req.end(encoded);
  });
}

function verifyMetadata(lab) {
  allowKeys(lab, ["slug", "active", "botsEnabled", "selectedKey", "error", "eventPhase", "currentBlock", "actors", "teams"], "Controller metadata fields are not allowlisted.");
  verify(lab.active === true && /^dev-play-[0-9a-f]{12}$/.test(lab.slug), "A ready synthetic rehearsal is required.");
  verify(Array.isArray(lab.actors) && lab.actors.length === 21, "The rehearsal must contain 21 actors.");
  verify(Array.isArray(lab.teams) && lab.teams.length === 3, "The rehearsal must contain three teams.");
  verify(typeof lab.botsEnabled === "boolean" && typeof lab.selectedKey === "string", "Controller status is malformed.");
  const actorKeys = new Set();
  lab.actors.forEach((actor, index) => {
    allowKeys(actor, ["key", "name", "role", "url", "teamKey"], "Actor metadata contains an unexpected field.");
    const expectedKey = `p${String(index + 1).padStart(2, "0")}`;
    verify(actor.key === expectedKey, "Actor order is incorrect.");
    verify(actor.url === `http://${HOST}:${3101 + index}/e/${lab.slug}`, "Actor URL is outside its assigned local proxy.");
    verify(typeof actor.name === "string" && ["student", "operator"].includes(actor.role) && ["A", "B", "C"].includes(actor.teamKey), "Actor metadata is malformed.");
    actorKeys.add(actor.key);
  });
  verify(actorKeys.size === 21 && actorKeys.has(lab.selectedKey), "Actor metadata identities are not unique.");
  lab.teams.forEach(team => {
    allowKeys(team, ["key", "gameNo", "phase", "paused", "cardCount", "leadKey", "leadName", "sharerKey", "sharerName"], "Team metadata contains an unexpected field.");
    verify(["A", "B", "C"].includes(team.key) && typeof team.paused === "boolean", "Team metadata is malformed.");
    verify(team.leadKey === null || actorKeys.has(team.leadKey), "Team lead references an unknown actor.");
    verify(team.sharerKey === null || actorKeys.has(team.sharerKey), "Team sharer references an unknown actor.");
  });
}

function verifyPlayerState(response, actor, slug) {
  verify(response.status === 200, "A local actor state request failed.");
  verify(!response.hasCookie, "A proxy response exposed a Set-Cookie header.");
  const state = response.data;
  verify(object(state) && state.event?.slug === slug, "An actor state belongs to the wrong rehearsal.");
  verify(object(state.me) && typeof state.me.participantId === "string", "An actor state is missing its identity.");
  verify(state.me.displayName === actor.name && state.me.role === actor.role, "A proxy used another actor identity.");
  verify(state.me.profileComplete === true && state.profile?.complete === true, "An actor profile is incomplete.");
  verify(state.team?.key === actor.teamKey, "An actor is assigned to an unexpected team.");
  verify(object(state.game) && Array.isArray(state.game.cards), "An actor has no playable game.");
  const game = state.game;
  allowKeys(game, ["gameId", "gameNo", "phase", "turnLead", "candidates", "cards", "exhausted", "guess", "ensemble", "groundTruth", "pendingOverlay", "reveal"], "A game contains an unexpected private field.");
  if (game.phase !== "REVEALED") verify(!Object.hasOwn(game, "reveal"), "An unrevealed game contains an answer payload.");
  for (const card of game.cards) {
    allowKeys(card, ["cardNo", "recipients", "text", "verified"], "A Data card contains an unexpected private field.");
    verify(Array.isArray(card.recipients), "A Data card has no recipient list.");
    const isRecipient = card.recipients.some(person => person.participantId === state.me.participantId);
    const hasText = Object.hasOwn(card, "text");
    if (game.phase !== "REVEALED") verify(hasText === isRecipient, "Data Split content visibility is incorrect.");
    if (hasText) verify(typeof card.text === "string", "A visible Data card has invalid text.");
  }
  return state.me.participantId;
}

async function negative(port, path, options, expected, label) {
  const response = await localRequest(port, path, options);
  verify(response.status === expected, label);
  verify(!response.hasCookie, "A rejected request exposed a Set-Cookie header.");
}

async function main() {
  verify(process.argv.length === 2, "This script accepts no arguments and only checks the fixed local rehearsal.");
  const metadata = await localRequest(LAB_PORT, "/lab/state");
  verify(metadata.status === 200 && !metadata.hasCookie, "Controller metadata request failed.");
  verifyMetadata(metadata.data);
  const lab = metadata.data;
  const identities = await Promise.all(lab.actors.map(async (actor, index) => {
    const port = 3101 + index;
    const path = `/api/state?slug=${lab.slug}`;
    const normal = await localRequest(port, path);
    const id = verifyPlayerState(normal, actor, lab.slug);
    const forged = await localRequest(port, path, { headers: { Cookie: `km_session=${"A".repeat(43)}; unrelated=ignored` } });
    verify(verifyPlayerState(forged, actor, lab.slug) === id, "An inbound cookie changed a proxy identity.");
    return id;
  }));
  verify(new Set(identities).size === 21, "The 21 actor proxies do not have distinct participant identities.");

  // All mutations below must be rejected by the local proxy before reaching Next.
  await negative(LAB_PORT, "/lab/bots", { method: "POST", headers: { Host: "untrusted.invalid", Origin: LAB_ORIGIN }, body: { enabled: false } }, 403, "The controller accepted a forged Host.");
  await negative(LAB_PORT, "/lab/bots", { method: "POST", headers: { Origin: "https://untrusted.invalid" }, body: { enabled: false } }, 403, "The controller accepted an external Origin.");
  await negative(LAB_PORT, "/lab/bots", { method: "POST", body: { enabled: false } }, 403, "The controller accepted a mutation without Origin.");
  await negative(3101, "/api/state?slug=dev-play-000000000000", {}, 403, "A proxy accepted a state read for another event.");
  await negative(3101, "/api/state/sync", { method: "POST", headers: { Origin: "http://127.0.0.1:3101" }, body: { slug: "dev-play-000000000000" } }, 403, "A proxy accepted a mutation for another event.");
  await negative(3101, "/api/state/sync", { method: "POST", body: { slug: lab.slug } }, 403, "A proxy accepted a mutation without Origin.");
  await negative(3101, "/api/not-a-rehearsal-endpoint", {}, 404, "A proxy accepted an unlisted API path.");
  await negative(3101, "/_next/static/../foo", {}, 404, "A proxy accepted a raw path traversal.");

  const after = await localRequest(LAB_PORT, "/lab/state");
  verify(after.status === 200 && !after.hasCookie, "The final controller state request failed.");
  verify(after.data.slug === lab.slug && after.data.botsEnabled === lab.botsEnabled && after.data.selectedKey === lab.selectedKey, "Negative checks changed the controller state.");
  console.log(`PASS: ${checks} checks; 21 isolated actor sessions, 21 completed profiles, Data Split, cookie isolation, and 8 rejected unsafe requests.`);
}

main().catch(error => {
  console.error(`FAIL after ${checks} checks: ${error instanceof Error ? error.message : "Local rehearsal verification failed."}`);
  process.exitCode = 1;
});
