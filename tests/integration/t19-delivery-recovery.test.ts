import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { POST as admin } from "@/app/api/admin/route";
import { POST as ensembleShared } from "@/app/api/game/ensemble-shared/route";
import { GET as state } from "@/app/api/state/route";
import { sessionCookieHeader } from "@/server/auth/session";
import { closePool, getPool } from "@/server/db/pool";
import { getQuestion } from "@/content/catalog";
import type { PublicState } from "@/lib/contracts";
import { cleanupTestEvent, createTestEvent, type TestEvent, type TestSession } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";

let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

function post(path: string, session: TestSession, body: Record<string, unknown>) {
  return new Request(`https://example.test/api/${path}`, { method: "POST", headers: {
    origin: "https://example.test", "content-type": "application/json", cookie: sessionCookieHeader(session.token, 3600).split(";")[0],
  }, body: JSON.stringify({ slug: event.slug, requestId: randomUUID(), ...body }) });
}

async function view(session: TestSession): Promise<PublicState> {
  const response = await state(new Request(`https://example.test/api/state?slug=${event.slug}`, {
    headers: { cookie: sessionCookieHeader(session.token, 3600).split(";")[0] },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const result: PublicState = await response.json();
  expect(result.game?.reveal).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/owner_participant_id|noise_slots|is_noise|isNoise|true_option|trueOption|rng_seed|same_count|candidate_count|possible/);
  return result;
}

async function gameStatus(gameId: string) {
  return (await getPool().query<{ game_version: number; turn_lead_participant_id: string; ensemble_sharer_id: string; phase: string }>(
    "SELECT game_version,turn_lead_participant_id,ensemble_sharer_id,phase FROM games WHERE id=$1", [gameId])).rows[0];
}

async function counts(gameId: string) {
  return (await getPool().query<{ cards: number; deliveries: number }>(`SELECT
    (SELECT count(*)::int FROM data_cards WHERE game_id=$1) AS cards,
    (SELECT count(*)::int FROM card_deliveries d JOIN data_cards c ON c.id=d.card_id WHERE c.game_id=$1) AS deliveries`, [gameId])).rows[0];
}

async function command(session: TestSession, gameId: string, name: string, args: Record<string, unknown>) {
  return admin(post("admin", session, { command: name, teamKey: "A", expectedVersion: (await gameStatus(gameId)).game_version, args }));
}

it("T19 resend adds only a delivery and Turn Lead, denies duplicates/other teams, and transfer adds no card access", async () => {
  const fixture = await createVisibilityFixture(event);
  const gameId = fixture.groups[0].game;
  const host = fixture.byPerson.get(event.operators[0])!;
  const otherOperator = fixture.byPerson.get(event.operators[1])!;
  const receiverId = event.students[4];
  const receiver = fixture.byPerson.get(receiverId)!;
  const transferredId = event.students[5];
  const initial = await view(receiver);
  expect(initial.game?.cards[0]).not.toHaveProperty("text");
  expect(await counts(gameId)).toEqual({ cards: 3, deliveries: 3 });
  const denied = await command(otherOperator, gameId, "resend-data", { cardNo: 1, participantId: receiverId });
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.code).toBe("FORBIDDEN");
  expect((await command(receiver, gameId, "transfer-turn-lead", { participantId: receiverId })).status).toBe(403);

  const body = { requestId: randomUUID(), command: "resend-data", teamKey: "A", expectedVersion: 0, args: { cardNo: 1, participantId: receiverId } };
  const sent = await admin(post("admin", host, body));
  expect(sent.status).toBe(200);
  expect(await sent.json()).toEqual({ ok: true });
  // A lost response can be retried with the same receipt without delivering twice.
  expect((await admin(post("admin", host, body))).status).toBe(200);
  expect(await counts(gameId)).toEqual({ cards: 3, deliveries: 4 });
  expect(await gameStatus(gameId)).toMatchObject({ game_version: 1, turn_lead_participant_id: receiverId });
  expect((await getPool().query("SELECT reason FROM card_deliveries WHERE card_id=$1 AND participant_id=$2", [fixture.groups[0].cards[0], receiverId])).rows)
    .toEqual([{ reason: "resend" }]);
  const after = await view(receiver);
  expect(after.game?.cards[0].text).toBe(getQuestion("Q01").options.A);
  expect(after.game?.cards[0].recipients.map((p) => p.participantId)).toEqual([event.students[0], receiverId]);
  expect(after.game?.turnLead?.participantId).toBe(receiverId);
  expect(after.game?.cards[1]).not.toHaveProperty("text");
  for (const participantId of [receiverId, event.students[0]]) {
    const duplicate = await command(host, gameId, "resend-data", { cardNo: 1, participantId });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("ALREADY_DELIVERED");
  }
  expect((await command(otherOperator, gameId, "transfer-turn-lead", { participantId: transferredId })).status).toBe(403);
  const transfer = await command(host, gameId, "transfer-turn-lead", { participantId: transferredId });
  expect(transfer.status).toBe(200);
  expect(await transfer.json()).toEqual({ ok: true });
  expect(await counts(gameId)).toEqual({ cards: 3, deliveries: 4 });
  const transferred = await view(fixture.byPerson.get(transferredId)!);
  expect(transferred.game?.turnLead?.participantId).toBe(transferredId);
  expect(transferred.game?.cards.every((card) => card.text === undefined)).toBe(true);
  const hostView = await view(host);
  expect(hostView.game?.cards[0]).not.toHaveProperty("text");
  expect(JSON.stringify(hostView.admin)).not.toMatch(/"text"|"reveal"|"answers"/);
}, 60000);

it("T19 a host can resend an unavailable SHARE receiver's trigger card and the new receiver can start voting", async () => {
  const fixture = await createVisibilityFixture(event);
  const gameId = fixture.groups[0].game;
  const oldReceiverId = event.operators[0];
  const oldReceiver = fixture.byPerson.get(oldReceiverId)!;
  const replacementId = event.students[4];
  const replacement = fixture.byPerson.get(replacementId)!;
  const host = fixture.byPerson.get(event.operators[1])!;
  await getPool().query("UPDATE events SET host_participant_id=$2 WHERE id=$1", [event.id, event.operators[1]]);
  await getPool().query("UPDATE games SET phase='ENSEMBLE_SHARE',turn_lead_participant_id=$2,ensemble_sharer_id=$2 WHERE id=$1", [gameId, oldReceiverId]);
  await getPool().query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", [oldReceiver.id]);
  expect((await view(replacement)).game?.cards[2]).not.toHaveProperty("text");
  const resend = await command(host, gameId, "resend-data", { cardNo: 3, participantId: replacementId });
  expect(resend.status).toBe(200);
  expect(await resend.json()).toEqual({ ok: true });
  const current = await gameStatus(gameId);
  expect(current).toMatchObject({ phase: "ENSEMBLE_SHARE", turn_lead_participant_id: replacementId, ensemble_sharer_id: replacementId });
  expect(await counts(gameId)).toEqual({ cards: 3, deliveries: 4 });
  const recovered = await view(replacement);
  expect(recovered.game?.cards[2].text).toBe(getQuestion("Q03").options.A);
  expect(recovered.game?.ensemble?.sharer.participantId).toBe(replacementId);
  expect(recovered.allowedActions).toContain("ensemble-shared");
  const body = { gameId, gameVersion: current.game_version };
  expect((await ensembleShared(post("game/ensemble-shared", oldReceiver, body))).status).toBe(401);
  expect((await ensembleShared(post("game/ensemble-shared", fixture.byPerson.get(event.operators[2])!, body))).status).toBe(403);
  expect((await ensembleShared(post("game/ensemble-shared", fixture.byPerson.get(event.students[0])!, body))).status).toBe(403);
  const shared = await ensembleShared(post("game/ensemble-shared", replacement, body));
  expect(shared.status).toBe(200);
  expect(await shared.json()).toEqual({ ok: true });
  expect((await gameStatus(gameId)).phase).toBe("ENSEMBLE_VOTE");
  expect((await view(replacement)).game?.ensemble?.stage).toBe("VOTE");
  expect(JSON.stringify((await view(host)).admin)).not.toMatch(/"text"|"reveal"|"answers"/);
}, 60000);
