import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { getQuestion } from "@/content/catalog";
import { closePool } from "@/server/db/pool";
import { loadStateSnapshot, type EventSnapshot } from "@/server/db/snapshot";
import { buildPublicState } from "@/server/dto/state-dto";
import { createTestEvent, cleanupTestEvent, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";

let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T35 team wording is available only for an eligible Turn Lead's Noise review and never exposes truth", async () => {
  const fixture = await createVisibilityFixture(event);
  const leadId = event.students[2];
  const group = fixture.groups[0];
  const base = await loadStateSnapshot(event.slug, fixture.byPerson.get(leadId)!.tokenHash);
  base.intros.push({ participant_id: leadId, intro_key: "noise" });
  base.overlays.push({ participant_id: leadId, game_id: group.game, kind: "ground_truth" });
  const eligible = buildPublicState(base);
  expect(eligible.allowedActions).toContain("guess");
  expect(eligible.game!.guess!.cards).toEqual(["Q01", "Q02", "Q03"].map((id, index) => ({
    cardNo: index + 1, question: { category: getQuestion(id).category, options: getQuestion(id).options },
    text: getQuestion(id).options[index === 1 ? "B" : "A"],
  })));
  // Normal board cards retain the original recipient boundary, including the Verified card.
  expect(eligible.game!.cards[0]).not.toHaveProperty("text");
  expect(eligible.game!.cards[0]).not.toHaveProperty("question");
  expect(eligible.game!.cards[2]).not.toHaveProperty("text");
  expect(eligible.game!.cards[2]).toHaveProperty("verified", true);
  expect(eligible.game!.cards[1].text).toBe(getQuestion("Q02").options.B);
  expect(JSON.stringify(eligible.game)).not.toMatch(/owner_participant_id|is_noise|isNoise|true_option|trueOption|ownerActualText|rng_seed|noise_slots/);
  for (const card of eligible.game!.guess!.cards!) expect(Object.keys(card).sort()).toEqual(["cardNo", "question", "text"]);

  for (const id of [event.students[4], event.operators[0], event.operators[1]]) {
    const snapshot = structuredClone(base);
    snapshot.session!.participant_id = id;
    const state = buildPublicState(snapshot);
    expect(state.game?.guess?.cards, `non-lead role ${id}`).toBeUndefined();
    expect(state.game).not.toHaveProperty("reveal");
  }

  const ineligible: [string, (snapshot: EventSnapshot) => void][] = [
    ["paused", (snapshot) => { snapshot.blocks.find((block) => block.id === group.block)!.paused_at = snapshot.now; }],
    ["guess locked", (snapshot) => { snapshot.games.find((game) => game.id === group.game)!.guess_locked = true; }],
    ["Noise not acknowledged", (snapshot) => { snapshot.intros = []; }],
    ["Ground Truth not acknowledged", (snapshot) => { snapshot.overlays = []; }],
    ["Ensemble not acknowledged", (snapshot) => { snapshot.games.find((game) => game.id === group.game)!.phase = "ENSEMBLE_VOTE"; }],
    ["below guess threshold", (snapshot) => { snapshot.cards = snapshot.cards.filter((card) => card.id !== group.cards[2]); }],
    ["no Noise", (snapshot) => { snapshot.cards.forEach((card) => { card.is_noise = false; }); }],
    ["between blocks", (snapshot) => { snapshot.event.phase = "BREAK"; }],
  ];
  for (const [reason, change] of ineligible) {
    const snapshot = structuredClone(base);
    change(snapshot);
    expect(buildPublicState(snapshot).game?.guess?.cards, reason).toBeUndefined();
  }

  const noDelivery = structuredClone(base);
  noDelivery.deliveries = noDelivery.deliveries.filter((delivery) => delivery.card_id !== group.cards[0]);
  expect(buildPublicState(noDelivery).game!.guess!.cards!.map((card) => card.cardNo)).toEqual([2, 3]);
  const ownerIsLead = structuredClone(base);
  ownerIsLead.games.find((game) => game.id === group.game)!.owner_participant_id = leadId;
  expect(buildPublicState(ownerIsLead).game!.guess!.cards).toEqual(eligible.game!.guess!.cards);
});
