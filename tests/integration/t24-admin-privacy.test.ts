import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool } from "@/server/db/pool";
import { getState } from "@/server/dto/state-dto";
import { getQuestion } from "@/content/catalog";
import { createTestEvent, cleanupTestEvent, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T24 host and operators can monitor every team without receiving other teams' cards or private truth", async () => {
  const fixture = await createVisibilityFixture(event);
  for (const index of [0, 1]) {
    const state = await getState(event.slug, fixture.byPerson.get(event.operators[index])!.tokenHash);
    expect(state.admin?.teams).toHaveLength(3);
    expect(state.admin?.teams.filter((team) => team.canControl)).toHaveLength(index === 0 ? 3 : 1);
    const admin = JSON.stringify(state.admin);
    expect(admin).not.toMatch(/owner_participant_id|noise_slots|is_noise|true_option|rng_seed|"text"|"reveal"|"answers"/);
    expect(JSON.stringify(state)).not.toContain(getQuestion("Q07").options.A);
    expect(state.game?.reveal).toBeUndefined();
  }
});
