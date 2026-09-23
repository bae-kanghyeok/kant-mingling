import { describe, expect, it } from "vitest";
import { buildPublicState } from "@/server/dto/state-dto";
import type { EventSnapshot } from "@/server/db/snapshot";
import { DEFAULT_GLOBAL_CONFIG, DEFAULT_TEAM_SETTINGS, gmGameSettings, isGmMode, parseGlobalConfig, parseTeamSettings } from "@/server/game/settings";
import { createNoisePlan } from "@/server/game/noise-plan";
import { makeRng } from "@/server/game/rng";
import { planRotation } from "@/server/game/rotation";
import type { TeamAssignment } from "@/server/game/types";

const now = "2026-09-29T03:00:00.000Z";
function snapshot(viewer = "p1"): EventSnapshot {
  const people: EventSnapshot["people"] = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, display_name: `합성${i}`,
    role: i === 0 ? "operator" : "student", roster_order: i, attendance: "present", active: true,
    profile_completed_at: now, profile_locked_at: now }));
  return {
    now, event: { id: "event", slug: "dev-gm-unit", title: "GM", phase: "BLOCK", current_block: 8,
      host_participant_id: "p0", config_json: { ...DEFAULT_GLOBAL_CONFIG, gameplayMode: "gm", studentCount: 3, teamCount: 1, moveCountPerTeam: 0 },
      session_version: 1, teams_published_at: now, pending_config_json: null, pending_roster_json: null,
      draft_assignments: null, next_block_plan: null, rotation_requested: false },
    session: { id: "session", participant_id: viewer, last_seen_at: now }, people,
    sessions: people.map(p => ({ participant_id: p.id, last_seen_at: now, expires_at: "2026-09-30T03:00:00.000Z", revoked_at: null })),
    profiles: [], teams: [{ id: "team", team_key: "A", operator_participant_id: "p0", settings_json: DEFAULT_TEAM_SETTINGS }],
    assignments: people.map((p, i) => ({ participant_id: p.id, team_id: "team", block_no: 8, seat_no: i })),
    blocks: [{ id: "block", team_id: "team", block_no: 8, phase: "IN_GAME", current_game_id: "game", team_version: 1,
      settings_json: DEFAULT_TEAM_SETTINGS, paused_at: null, started_at: now, rotation_ready: false }],
    games: [{ id: "game", team_id: "team", team_block_id: "block", block_no: 8, game_no: 15,
      config_snapshot: gmGameSettings(DEFAULT_TEAM_SETTINGS, 15), owner_participant_id: "p2", rng_seed: "a".repeat(32),
      phase: "TURN", turn_lead_participant_id: "p1", guess_locked: false, exhausted: false, gm_guess_open: false,
      ensemble_trigger_no: 2, ensemble_sharer_id: "p1", ensemble_done: true, vote_deadline: null, vote_remaining_ms: null,
      game_version: 3, paused_ms_total: 0, started_at: now, revealed_at: null, end_reason: null }],
    cards: [1, 2, 3].map(n => ({ id: `card${n}`, game_id: "game", card_no: n, question_id: `Q0${n}`,
      displayed_option: n === 2 ? "B" : "A", true_option: "A", is_noise: n === 2 })),
    members: people.map(p => ({ game_id: "game", participant_id: p.id })),
    deliveries: [1, 2, 3].map(n => ({ card_id: `card${n}`, participant_id: `p${n}` })),
    votes: [], groundTruths: [], intros: people.flatMap(p => ["tutorial", "noise", "ensemble"].map(intro_key =>
      ({ participant_id: p.id, intro_key: intro_key as "tutorial" | "noise" | "ensemble" }))), overlays: [],
    logs: ["COMMON_CARD_FALLBACK", "RARE_CARD_FALLBACK", "owner_fallback", "open-guess"].map(command =>
      ({ actor_participant_id: "p0", command, target: null, created_at: now })),
  };
}

describe("GM feature snapshots and seat rounds", () => {
  it("leaves existing events classic and validates the explicit opt-in", () => {
    expect(isGmMode(parseGlobalConfig(DEFAULT_GLOBAL_CONFIG))).toBe(false);
    expect(isGmMode(parseGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, gameplayMode: "gm" }))).toBe(true);
    expect(() => parseGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, gameplayMode: "anything" })).toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5])("plans a maximum of %i Noise cards independently of game number", cap => {
    const base = parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, gm: { noiseCap: cap, groundTruth: true } });
    for (const gameNo of [2, 10, 300]) {
      const settings = gmGameSettings(base, gameNo);
      for (let seed = 0; seed < 30; seed++) {
        const slots = createNoisePlan({ gameNo, settings, rng: makeRng(String(seed), "gm") });
        expect(slots).toHaveLength(cap);
        expect(new Set(slots).size).toBe(cap);
        expect(slots.every(n => n >= 2 && n <= 20)).toBe(true);
        expect(slots.filter(n => n <= 1)).toHaveLength(0);
      }
      expect(settings.groundTruthGames).toEqual([gameNo]);
      expect(settings.dataSplitGames).toEqual([gameNo]);
    }
    const first = gmGameSettings(base, 1);
    expect(first.noiseCap).toBe(0);
    expect(first.groundTruthPerGame).toBe(0);
    expect(base.gm?.noiseCap).toBe(cap);
  });
  it("preserves a one-team seat arrangement past round three", () => {
    const assignments: TeamAssignment[] = [0, 3, 1, 2].map((id, seatNo) => ({ participantId: `p${id}`, teamKey: "A", role: id === 0 ? "operator" : "student", seatNo }));
    const next = planRotation({ assignments, moveCountPerTeam: 0, nextBlockNo: 8, pairHistory: [], rng: makeRng("gm", "round8") });
    expect(next.assignments).toEqual(assignments);
    expect(() => planRotation({ assignments, moveCountPerTeam: 0, nextBlockNo: 32768, pairHistory: [], rng: makeRng("gm", "bad") })).toThrow("INVALID_BLOCK");
  });
});

describe("GM public state and recovery boundaries", () => {
  it("scopes head GM guess controls to their own team even when another controlled team's gate is available", () => {
    const state = snapshot("p0");
    const secondPeople = state.people.map((person, index) => ({ ...person, id: `p${index + 4}`, display_name: `합성${index + 4}`, roster_order: index + 4 }));
    state.people.push(...secondPeople);
    state.event.config_json = { ...state.event.config_json, studentCount: 6, teamCount: 2, moveCountPerTeam: 1,
      operatorTeamByName: { 합성0: "A", 합성4: "B" } };
    state.teams.push({ ...state.teams[0], id: "team-b", team_key: "B", operator_participant_id: "p4" });
    state.blocks.push({ ...state.blocks[0], id: "block-b", team_id: "team-b", current_game_id: "game-b" });
    state.games.push({ ...state.games[0], id: "game-b", team_id: "team-b", team_block_id: "block-b", owner_participant_id: "p6", turn_lead_participant_id: "p5", ensemble_sharer_id: "p5" });
    state.assignments.push(...secondPeople.map((person, index) => ({ participant_id: person.id, team_id: "team-b", block_no: 8, seat_no: index })));
    state.members.push(...secondPeople.map(person => ({ game_id: "game-b", participant_id: person.id })));
    state.cards.push(...state.cards.map(card => ({ ...card, id: `${card.id}-b`, game_id: "game-b" })));
    state.games[0].guess_locked = true;
    let view = buildPublicState(state);
    expect(view.admin?.teams.find(team => team.key === "B")?.canControl).toBe(true);
    expect(view.game?.gameId).toBe("game");
    expect(view.allowedActions).not.toContain("open-guess");
    expect(view.allowedActions).not.toContain("close-guess");
    state.games[1].gm_guess_open = true;
    expect(buildPublicState(state).allowedActions).not.toContain("close-guess");
    state.games[0].guess_locked = false;
    view = buildPublicState(state);
    expect(view.allowedActions).toContain("open-guess");
    expect(view.allowedActions).not.toContain("close-guess");
    state.games[0].gm_guess_open = true;
    view = buildPublicState(state);
    expect(view.allowedActions).toContain("close-guess");
    expect(view.allowedActions).not.toContain("open-guess");
    state.blocks[0].paused_at = now;
    expect(buildPublicState(state).allowedActions).not.toContain("close-guess");
  });
  it("persists the closed/open gate in recovered lead state and scopes review text to an open guess", () => {
    const state = snapshot();
    const closed = buildPublicState(state);
    expect(closed.event).toMatchObject({ gameplayMode: "gm", currentBlock: 8, rotationRequested: false });
    expect(closed.game?.guess).toEqual({ enabled: false, locked: false });
    expect(closed.allowedActions).not.toContain("more-data");
    expect(closed.allowedActions).not.toContain("guess");
    state.games[0].gm_guess_open = true;
    const opened = buildPublicState(state);
    expect(opened.game?.guess?.enabled).toBe(true);
    expect(opened.game?.guess?.noiseCount).toBe(1);
    expect(opened.game?.guess?.cards).toHaveLength(3);
    expect(opened.game?.cards.filter(card => card.text)).toHaveLength(1);
    state.games[0].guess_locked = true;
    state.games[0].gm_guess_open = false;
    expect(buildPublicState(state).game?.guess).toEqual({ enabled: false, locked: true });
  });
  it("GM pacing permissions do not expose other recipients' text or private selection logs", () => {
    const state = snapshot("p0");
    const gm = buildPublicState(state);
    expect(gm.allowedActions).toEqual(expect.arrayContaining(["next-card", "open-guess", "request-rotation"]));
    expect(gm.game?.cards.some(card => card.text)).toBe(false);
    expect(gm.game?.guess).toBeUndefined();
    expect(gm.admin?.recentLogs.map(log => log.command)).toEqual(["open-guess"]);
    expect(gm.admin?.teams[0].timers.blockTargetMs).toBe(15 * 60 * 1000);
    state.games[0].owner_participant_id = "p0";
    expect(buildPublicState(state)).toEqual(gm);
  });
  it("announces only Noise presence until the lead's approved guess is available", () => {
    const state = snapshot();
    state.intros = state.intros.filter(row => row.intro_key !== "noise");
    const before = buildPublicState(state);
    expect(before.game?.pendingOverlay).toEqual({ kind: "noise", cardCount: 3 });
    expect(before.game?.guess).not.toHaveProperty("noiseCount");
    state.games[0].gm_guess_open = true;
    expect(buildPublicState(state).game?.guess).not.toHaveProperty("noiseCount");
    state.intros.push({ participant_id: "p1", intro_key: "noise" });
    expect(buildPublicState(state).game?.guess?.noiseCount).toBe(1);
  });
  it("leaves voting to everyone while removing student stage controls", () => {
    const state = snapshot();
    state.games[0].phase = "ENSEMBLE_SHARE";
    expect(buildPublicState(state).allowedActions).not.toContain("ensemble-shared");
    state.games[0].phase = "ENSEMBLE_DISCUSS";
    expect(buildPublicState(state).allowedActions).not.toContain("ensemble-end-discussion");
    state.games[0].phase = "ENSEMBLE_VOTE";
    state.games[0].vote_deadline = "2026-09-29T03:00:30.000Z";
    expect(buildPublicState(state).allowedActions).toContain("ensemble-vote");
  });
  it("blocks new games during a requested rotation and offers readiness only after reveal", () => {
    const state = snapshot("p0");
    state.event.rotation_requested = true;
    expect(buildPublicState(state).allowedActions).not.toContain("rotation-ready");
    state.blocks[0].phase = "REVEAL";
    const ready = buildPublicState(state);
    expect(ready.allowedActions).toContain("rotation-ready");
    expect(ready.allowedActions).not.toContain("gm-next-game");
    expect(ready.allowedActions).toContain("cancel-rotation");
  });
});
