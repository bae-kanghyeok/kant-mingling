import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool } from "@/server/db/pool";
import { loadStateSnapshot, type EventSnapshot } from "@/server/db/snapshot";
import { buildPublicState } from "@/server/dto/state-dto";
import { createTestEvent, cleanupTestEvent, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";
import permittedKeys from "../unit/__snapshots__/dto-keys.json";
import type { GamePhase } from "@/lib/contracts";
const allowed = new Set(permittedKeys);
function keys(value: unknown, prefix = "", result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const item of value) keys(item, `${prefix}[]`, result); }
  else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    result.add(path.replace(/^admin\.globalSettings\.operatorTeamByName\..+$/, "admin.globalSettings.operatorTeamByName.*"));
    keys(child, path, result);
  }
  return result;
}
function checkDto(snapshot: EventSnapshot) {
  const state = buildPublicState(snapshot);
  for (const path of keys(state)) expect(allowed.has(path), `Unexpected public key: ${path}`).toBe(true);
  expect(JSON.stringify(state)).not.toMatch(/is_noise|isNoise|true_option|trueOption|owner_participant_id|noise_slots|noiseSlots|rng_seed|same_count|sameCount|candidate_count|candidateCount|possible/);
  return state;
}
let event: TestEvent;
beforeEach(async () => { event = await createTestEvent(); });
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

it("T25 every phase and role uses only permitted keys; Owner status changes no pre-reveal shape or actions", async () => {
  const fixture = await createVisibilityFixture(event);
  const base = await loadStateSnapshot(event.slug, fixture.byPerson.get(event.students[4])!.tokenHash);
  for (const phase of ["TURN", "ENSEMBLE_SHARE", "ENSEMBLE_VOTE", "ENSEMBLE_DISCUSS", "REVEALED"] as GamePhase[]) {
    for (const id of [event.students[1], event.students[4], event.students[2], event.operators[0], event.operators[1]]) {
      const snapshot = structuredClone(base);
      snapshot.session!.participant_id = id;
      for (const game of snapshot.games) {
        game.phase = phase;
        if (phase === "ENSEMBLE_VOTE") game.vote_deadline = new Date(Date.now() + 30000).toISOString();
        if (phase === "REVEALED") { game.revealed_at = snapshot.now; game.end_reason = "correct"; }
      }
      checkDto(snapshot);
    }
    if (phase !== "REVEALED") {
      const snapshot = structuredClone(base);
      snapshot.games.forEach((game) => { game.phase = phase; });
      const nonowner = checkDto(snapshot);
      snapshot.games.find((game) => game.id === fixture.groups[0].game)!.owner_participant_id = event.students[4];
      const owner = checkDto(snapshot);
      expect([...keys(owner)].sort()).toEqual([...keys(nonowner)].sort());
      expect(owner.allowedActions).toEqual(nonowner.allowedActions);
      expect(owner).toEqual(nonowner);
    }
  }
  const lead = structuredClone(base);
  lead.session!.participant_id = event.students[2];
  expect(checkDto(lead).game?.guess).not.toHaveProperty("noiseCount");
  lead.intros.push({ participant_id: event.students[2], intro_key: "noise" });
  expect(checkDto(lead).game?.guess?.noiseCount).toBe(1);
  const paused = structuredClone(base);
  const game = paused.games.find((g) => g.id === fixture.groups[0].game)!;
  game.phase = "ENSEMBLE_VOTE"; game.vote_deadline = null; game.vote_remaining_ms = 17000;
  paused.blocks.find((b) => b.id === game.team_block_id)!.paused_at = paused.now;
  const pauseDto = checkDto(paused);
  expect(pauseDto.game?.ensemble?.voteRemainingMs).toBe(17000);
  expect(pauseDto.allowedActions).not.toContain("ensemble-vote");
});

it("T25 rosters stay in roster order across shuffled seats, setup drafts and a block move", async () => {
  const fixture = await createVisibilityFixture(event);
  const snapshot = await loadStateSnapshot(event.slug, fixture.byPerson.get(event.operators[0])!.tokenHash);
  snapshot.assignments.reverse();
  const state = checkDto(snapshot);
  const expected = [...event.students.slice(0, 6), event.operators[0]];
  expect(state.team?.members.map((p) => p.participantId)).toEqual(expected);
  expect(state.admin?.teams[0].members.map((p) => p.participantId)).toEqual(expected);
  snapshot.event.pending_roster_json = snapshot.people.map((p) => ({ id: p.id, displayName: p.id === event.students[17] ? "운영진D" : p.display_name,
    role: p.id === event.students[17] ? "operator" : p.role, active: true, rosterOrder: p.roster_order }));
  snapshot.people.find((p) => p.id === event.students[17])!.active = false;
  expect(checkDto(snapshot).admin?.registration?.find((p) => p.participantId === event.students[17])).toMatchObject({ displayName: "운영진D", role: "operator", active: true, pending: true });
  const plan = snapshot.assignments.map((a) => ({ participantId: a.participant_id,
    teamKey: snapshot.teams.find((t) => t.id === a.team_id)!.team_key, seatNo: a.seat_no,
    role: snapshot.people.find((p) => p.id === a.participant_id)!.role }));
  snapshot.event.phase = "SETUP"; snapshot.event.current_block = 0; snapshot.event.draft_assignments = plan;
  const setup = checkDto(snapshot);
  expect(setup.allowedActions).not.toContain("start-block-game");
  expect(setup.admin?.nextBlockPlan?.[0].members).toEqual(expected.map((id) => snapshot.people.find((p) => p.id === id)!.display_name));
  snapshot.event.phase = "BLOCK"; snapshot.event.current_block = 2;
  snapshot.assignments = snapshot.assignments.map((a) => ({ ...a, block_no: 2 }));
  snapshot.blocks = snapshot.blocks.map((b) => ({ ...b, block_no: 2, phase: "SEATING", current_game_id: null }));
  const moved = checkDto(snapshot);
  expect(moved.nextBlock?.members).toEqual(expected.map((id) => snapshot.people.find((p) => p.id === id)!.display_name));
  expect(moved.game).toBeUndefined();
  snapshot.event.phase = "BREAK"; snapshot.event.next_block_plan = null;
  expect(checkDto(snapshot).allowedActions).not.toContain("publish-next-block");
  expect(checkDto(snapshot).allowedActions).not.toContain("swap-seats");
  snapshot.event.phase = "ENDED";
  const ended = checkDto(snapshot);
  expect(ended.allowedActions).toEqual([]);
  expect(ended.admin).toBeUndefined();
  expect(ended.profile).toBeUndefined();
  snapshot.session!.participant_id = null;
  expect(() => buildPublicState(snapshot)).toThrow("KANT Mingle 완료");
});
