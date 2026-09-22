import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { getState } from "@/server/dto/state-dto";
import { getQuestion } from "@/content/catalog";
import { createTestEvent, cleanupTestEvent, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T10 only recipients see question context and displayed answers; GT reveals only its number; members see context after reveal", async () => {
  const fixture = await createVisibilityFixture(event);
  const recipient = fixture.byPerson.get(event.students[0])!;
  const nonrecipient = fixture.byPerson.get(event.students[4])!;
  const received = await getState(event.slug, recipient.tokenHash);
  const hidden = await getState(event.slug, nonrecipient.tokenHash);
  expect(received.game?.cards[0].text).toBe(getQuestion("Q01").options.A);
  expect(received.game?.cards[0].question).toEqual({ category: getQuestion("Q01").category, options: getQuestion("Q01").options });
  for (const card of hidden.game!.cards) {
    expect(Object.keys(card).sort()).toEqual(["cardNo", "recipients", ...(card.verified ? ["verified"] : [])].sort());
  }
  expect(hidden.game?.cards[2]).toMatchObject({ cardNo: 3, verified: true });
  expect(JSON.stringify(hidden)).not.toContain(getQuestion("Q01").options.A);
  expect(hidden.game).not.toHaveProperty("reveal");
  const noiseRecipient = await getState(event.slug, fixture.byPerson.get(event.students[2])!.tokenHash);
  expect(noiseRecipient.game?.cards[1]).toMatchObject({ text: getQuestion("Q02").options.B,
    question: { category: getQuestion("Q02").category, options: getQuestion("Q02").options } });
  expect(noiseRecipient.game?.cards[1]).not.toHaveProperty("ownerActualText");
  expect(noiseRecipient.game?.cards[1]).not.toHaveProperty("status");
  await getPool().query("UPDATE games SET phase='REVEALED',revealed_at=clock_timestamp(),end_reason='correct' WHERE id=$1", [fixture.groups[0].game]);
  const revealed = await getState(event.slug, nonrecipient.tokenHash);
  expect(revealed.game?.reveal?.owner.participantId).toBe(event.students[1]);
  expect(revealed.game?.cards.every((card) => !!card.text && !!card.question)).toBe(true);
  expect(revealed.game?.reveal?.cards[1]).toMatchObject({ status: "NOISE", text: getQuestion("Q02").options.B,
    question: { category: getQuestion("Q02").category, options: getQuestion("Q02").options }, ownerActualText: getQuestion("Q02").options.A });
  await getPool().query("DELETE FROM game_members WHERE game_id=$1 AND participant_id=$2", [fixture.groups[0].game, event.students[4]]);
  const late = await getState(event.slug, nonrecipient.tokenHash);
  expect(late.team?.notInCurrentGame).toBe(true);
  expect(late.game).toBeUndefined();
  expect(late.lastReveal).toBeUndefined();
});
