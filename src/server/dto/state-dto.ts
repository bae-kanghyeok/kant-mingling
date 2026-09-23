import "server-only";
import type { AdminView, IntroKey, Person, PublicGame, PublicState } from "@/lib/contracts";
import { getQuestion } from "@/content/catalog";
import { loadStateSnapshot, type EventSnapshot, type SnapshotGame, type SnapshotPerson } from "../db/snapshot";
import { DEFAULT_TEAM_SETTINGS, isGmMode, MAX_EVENT_ROUND, type TeamSettings } from "../game/settings";
import { getReferenceTimers } from "../game/timers";
import { selectBehindData } from "../game/behind";
import { makeRng } from "../game/rng";
import type { GameMember, TeamAssignment } from "../game/types";
import { reject } from "../http/respond";

const ms = (value: string | null | undefined) => value ? new Date(value).getTime() : null;
const person = (p: SnapshotPerson): Person => ({ participantId: p.id, displayName: p.display_name, role: p.role });
const named = (p: SnapshotPerson) => ({ participantId: p.id, displayName: p.display_name });
const settings = (value: TeamSettings): TeamSettings => {
  const v = { ...DEFAULT_TEAM_SETTINGS, ...value };
  return { preset: v.preset, dataSplitGames: [...v.dataSplitGames], noiseGames: [...v.noiseGames], noiseFirstRange: [...v.noiseFirstRange],
    noiseAutoAdd: v.noiseAutoAdd, noiseCap: v.noiseCap, groundTruthGames: [...v.groundTruthGames], groundTruthPerGame: v.groundTruthPerGame,
    gtRealCardsAfterEnsemble: v.gtRealCardsAfterEnsemble, ensembleGames: [...v.ensembleGames], ensembleTriggerOverride: v.ensembleTriggerOverride,
    rareFromRealOrdinal: v.rareFromRealOrdinal, guessEnableAfter: { game1: v.guessEnableAfter.game1, others: v.guessEnableAfter.others },
    ...(v.gm ? { gm: { noiseCap: v.gm.noiseCap, groundTruth: v.gm.groundTruth } } : {}) };
};
const online = (s: EventSnapshot, id: string) => s.sessions.some((session) => session.participant_id === id && !session.revoked_at &&
  (ms(session.expires_at) ?? 0) > (ms(s.now) ?? 0) && (ms(session.last_seen_at) ?? 0) >= (ms(s.now) ?? 0) - s.event.config_json.presenceWindowSeconds * 1000);
const locked = (s: EventSnapshot, id: string) => s.sessions.some((session) => session.participant_id === id && !session.revoked_at && (ms(session.expires_at) ?? 0) > (ms(s.now) ?? 0));
const membersFor = (s: EventSnapshot, gameId: string) => s.people.filter((p) => s.members.some((member) => member.game_id === gameId && member.participant_id === p.id));
const assignmentBlock = (s: EventSnapshot) => Math.max(1, s.event.current_block);
const cardContent = (questionId: string, displayedOption: "A" | "B") => {
  const question = getQuestion(questionId);
  return { question: { category: question.category, options: { A: question.options.A, B: question.options.B } },
    text: question.options[displayedOption] };
};

function gameDto(s: EventSnapshot, game: SnapshotGame, me: SnapshotPerson, intros: IntroKey[]): PublicGame {
  const members = membersFor(s, game.id);
  const cards = s.cards.filter((card) => card.game_id === game.id).sort((a, b) => a.card_no - b.card_no);
  const gt = s.groundTruths.find((row) => row.game_id === game.id);
  const gtCard = cards.find((card) => card.id === gt?.card_id);
  const block = s.blocks.find((row) => row.id === game.team_block_id);
  const lead = members.find((p) => p.id === game.turn_lead_participant_id);
  const isRevealed = game.phase === "REVEALED";
  const config = settings(game.config_snapshot);
  const isLead = lead?.id === me.id;
  const gm = isGmMode(s.event.config_json);
  const noiseCount = cards.filter((card) => card.is_noise).length;
  const guessThreshold = game.game_no === 1 ? config.guessEnableAfter.game1 : config.guessEnableAfter.others;
  const out: PublicGame = {
    gameId: game.id, gameNo: game.game_no, phase: game.phase, turnLead: lead ? named(lead) : null,
    ...(gm ? { gm: { guessOpen: !!game.gm_guess_open && !isRevealed } } : {}),
    candidates: members.map(named), exhausted: game.exhausted,
    cards: cards.map((card) => {
      const recipientIds = new Set(s.deliveries.filter((delivery) => delivery.card_id === card.id).map((delivery) => delivery.participant_id));
      const visible = isRevealed || recipientIds.has(me.id);
      return { cardNo: card.card_no, recipients: members.filter((p) => recipientIds.has(p.id)).map(named),
        ...(visible ? cardContent(card.question_id, card.displayed_option) : {}),
        ...(gtCard?.id === card.id ? { verified: true as const } : {}) };
    }),
  };
  if (isLead && !isRevealed) {
    const enabled = game.phase === "TURN" && !block?.paused_at && cards.length >= guessThreshold && !game.guess_locked && (!gm || !!game.gm_guess_open);
    out.guess = { enabled, locked: game.guess_locked, ...(enabled && intros.includes("noise") ? { noiseCount } : {}) };
  }
  if (gtCard) out.groundTruth = { cardNo: gtCard.card_no };
  const sharer = members.find((p) => p.id === game.ensemble_sharer_id);
  if (sharer && game.phase.startsWith("ENSEMBLE_") && game.ensemble_trigger_no !== null) {
    const stage = game.phase === "ENSEMBLE_SHARE" ? "SHARE" : game.phase === "ENSEMBLE_VOTE" ? "VOTE" : "DISCUSS";
    out.ensemble = { stage, triggerCardNo: game.ensemble_trigger_no, sharer: named(sharer) };
    if (stage === "VOTE") {
      if (game.vote_deadline) out.ensemble.voteDeadline = game.vote_deadline;
      if (block?.paused_at && game.vote_remaining_ms !== null) out.ensemble.voteRemainingMs = game.vote_remaining_ms;
      const ownVote = s.votes.find((vote) => vote.game_id === game.id && vote.voter_id === me.id);
      out.ensemble.myVote = ownVote?.pick_id ?? null;
      out.ensemble.myRevision = ownVote?.revision ?? 0;
    }
    if (stage === "DISCUSS") out.ensemble.results = members.map((p) => ({ ...named(p), votes: s.votes.filter((vote) => vote.game_id === game.id && vote.pick_id === p.id).length }));
  }
  if (!isRevealed) {
    if (game.phase.startsWith("ENSEMBLE_") && !intros.includes("ensemble")) out.pendingOverlay = { kind: "ensemble" };
    else if (gtCard && !s.overlays.some((row) => row.game_id === game.id && row.participant_id === me.id && row.kind === "ground_truth")) out.pendingOverlay = { kind: "ground_truth", cardNo: gtCard.card_no };
    else if (cards.length >= guessThreshold && noiseCount > 0 && !intros.includes("noise")) out.pendingOverlay = {
      kind: "noise", cardCount: cards.length, ...(!gm ? { noiseCount } : {}) };
  }
  // Only an eligible Turn Lead may review team-delivered wording while choosing Noise.
  // Keep ordinary cards recipient-scoped and never include which option is true/Noise.
  if (out.guess?.enabled && (out.guess.noiseCount ?? 0) > 0 && !out.pendingOverlay &&
      s.event.phase === "BLOCK" && block?.phase === "IN_GAME") {
    out.guess.cards = cards.filter((card) => s.deliveries.some((delivery) => delivery.card_id === card.id))
      .map((card) => ({ cardNo: card.card_no, ...cardContent(card.question_id, card.displayed_option) }));
  }
  if (isRevealed) {
    const owner = members.find((p) => p.id === game.owner_participant_id);
    if (!owner || !game.end_reason) reject(503, "DB_UNAVAILABLE");
    const engineMembers: GameMember[] = members.map((p) => ({ id: p.id, role: p.role, rosterOrder: p.roster_order,
      profileComplete: !!p.profile_completed_at, answers: Object.fromEntries(s.profiles.filter((answer) => answer.participant_id === p.id).map((answer) => [answer.question_id, answer.option])) }));
    const behind = selectBehindData({ members: engineMembers, ownerId: owner.id,
      cards: cards.map((card) => ({ cardNo: card.card_no, questionId: card.question_id, displayedOption: card.displayed_option, trueOption: card.true_option, isNoise: card.is_noise })),
      groundTruthCardNo: gtCard?.card_no, rng: makeRng(game.rng_seed, "behind") });
    out.reveal = { owner: named(owner), endReason: game.end_reason,
      cards: cards.map((card) => ({ cardNo: card.card_no, ...cardContent(card.question_id, card.displayed_option),
        status: gtCard?.id === card.id ? "GROUND_TRUTH" : card.is_noise ? "NOISE" : "REAL",
        ...(card.is_noise ? { ownerActualText: getQuestion(card.question_id).options[card.true_option] } : {}) })),
      behind: behind ? { choiceText: `${owner.display_name}님의 선택: ‘${getQuestion(behind.questionId).options[behind.trueOption]}’`, followUp: getQuestion(behind.questionId).followUp }
        : { choiceText: "아직 공개된 Data가 없어요.", followUp: "서로에게 궁금한 점을 이야기해보세요." } };
  }
  return out;
}

function planDto(s: EventSnapshot, assignments: TeamAssignment[]) {
  const pending = s.event.pending_roster_json;
  return [...new Set(assignments.map((a) => a.teamKey))].sort().map((teamKey) => ({ teamKey,
    members: assignments.filter((a) => a.teamKey === teamKey).sort((a, b) =>
      (pending?.find((p) => p.id === a.participantId)?.rosterOrder ?? s.people.find((p) => p.id === a.participantId)?.roster_order ?? 0) -
      (pending?.find((p) => p.id === b.participantId)?.rosterOrder ?? s.people.find((p) => p.id === b.participantId)?.roster_order ?? 0))
      .map((a) => pending?.find((p) => p.id === a.participantId)?.displayName ?? s.people.find((p) => p.id === a.participantId)?.display_name ?? "참가자") }));
}

function adminDto(s: EventSnapshot, me: SnapshotPerson, isHost: boolean): AdminView {
  const currentAssignments = s.assignments.filter((a) => a.block_no === assignmentBlock(s));
  const teams = s.teams.filter((team) => currentAssignments.some((a) => a.team_id === team.id));
  const admin: AdminView = { isHost, teams: teams.map((team) => {
    const block = s.blocks.find((b) => b.team_id === team.id && b.block_no === s.event.current_block);
    const game = s.games.find((g) => g.id === block?.current_game_id);
    const participants = s.people.filter((p) => currentAssignments.some((a) => a.team_id === team.id && a.participant_id === p.id));
    return { key: team.team_key, operatorName: s.people.find((p) => p.id === team.operator_participant_id)?.display_name ?? "미배정",
      ...(isGmMode(s.event.config_json) ? { rotationReady: !!block?.rotation_ready } : {}),
      phase: block?.phase ?? "SEATING", paused: !!block?.paused_at, gameNo: game?.game_no ?? null,
      revealedCount: game ? s.cards.filter((card) => card.game_id === game.id).length : 0, stage: game?.phase ?? null,
      turnLeadName: s.people.find((p) => p.id === game?.turn_lead_participant_id)?.display_name ?? null,
      members: participants.map((p) => ({ ...person(p), online: online(s, p.id), profileComplete: !!p.profile_completed_at, attendance: p.attendance })),
      timers: getReferenceTimers({ nowMs: ms(s.now)!, gameStartedAtMs: ms(game?.started_at), revealedAtMs: ms(game?.revealed_at),
        pausedMsTotal: game?.paused_ms_total ?? 0, pausedAtMs: ms(block?.paused_at), blockStartedAtMs: ms(block?.started_at),
        blockTargetMinutes: s.event.config_json.blockTargetMinutes[Math.min(2, Math.max(0, s.event.current_block - 1))] }),
      settings: settings(block?.settings_json ?? team.settings_json), canControl: isHost || team.operator_participant_id === me.id,
      version: block?.team_version ?? s.event.session_version, ...(game ? { gameId: game.id, gameVersion: game.game_version } : {}) };
  }), recentLogs: s.logs.filter((log) => !["COMMON_CARD_FALLBACK", "RARE_CARD_FALLBACK", "owner_fallback"].includes(log.command))
    .map((log) => ({ command: log.command, actorName: s.people.find((p) => p.id === log.actor_participant_id)?.display_name ?? "시스템", target: log.target, at: log.created_at })) };
  admin.registration = s.people.map((p) => {
    const draft = s.event.pending_roster_json?.find((row) => row.id === p.id);
    return { participantId: p.id, displayName: draft?.displayName ?? p.display_name, role: draft?.role ?? p.role,
      locked: locked(s, p.id), profileComplete: !!p.profile_completed_at, attendance: p.attendance,
      active: draft ? draft.active !== false : p.active,
      ...(draft && (draft.active !== p.active || draft.displayName !== p.display_name || draft.role !== p.role) ? { pending: true } : {}) };
  });
  if (isHost) {
    const v = s.event.pending_config_json ?? s.event.config_json;
    admin.globalSettings = { studentCount: v.studentCount, teamCount: v.teamCount, moveCountPerTeam: v.moveCountPerTeam,
      ...(v.gameplayMode ? { gameplayMode: v.gameplayMode } : {}),
      operatorTeamByName: Object.fromEntries(Object.entries(v.operatorTeamByName)), blockTargetMinutes: [...v.blockTargetMinutes],
      sessionTtlHours: v.sessionTtlHours, presenceWindowSeconds: v.presenceWindowSeconds, pollInGameMs: v.pollInGameMs, pollIdleMs: v.pollIdleMs, voteSeconds: v.voteSeconds };
    const plan = s.event.phase === "SETUP" ? s.event.draft_assignments : s.event.phase === "BREAK" ? s.event.next_block_plan?.assignments : null;
    if (plan) admin.nextBlockPlan = planDto(s, plan);
  }
  return admin;
}

export function buildPublicState(s: EventSnapshot): PublicState {
  if (!s.session) reject(401, "UNAUTHENTICATED");
  const me = s.people.find((p) => p.id === s.session?.participant_id && p.active);
  const isHost = me?.role === "operator" && me.id === s.event.host_participant_id;
  const gm = isGmMode(s.event.config_json);
  const gmEvent = gm ? { gameplayMode: "gm" as const, rotationRequested: !!s.event.rotation_requested } : {};
  const intros = s.intros.filter((row) => row.participant_id === me?.id).map((row) => row.intro_key);
  if (s.event.phase === "ENDED") {
    if (!me) reject(410, "ENDED");
    const previous = s.games.filter((g) => g.phase === "REVEALED" && s.members.some((m) => m.game_id === g.id && m.participant_id === me.id))
      .sort((a, b) => (ms(b.revealed_at) ?? 0) - (ms(a.revealed_at) ?? 0))[0];
    return { serverNow: s.now, poll: { intervalMs: s.event.config_json.pollIdleMs, needsSync: false },
      versions: { session: s.event.session_version }, event: { slug: s.event.slug, title: s.event.title, phase: "ENDED", currentBlock: s.event.current_block, teamCount: s.event.config_json.teamCount, ...gmEvent },
      me: { ...person(me), isHost, profileComplete: !!me.profile_completed_at, introsSeen: intros }, allowedActions: [],
      ...(previous ? { lastReveal: gameDto(s, previous, me, intros) } : {}) };
  }
  const assignment = s.assignments.find((a) => a.block_no === assignmentBlock(s) && a.participant_id === me?.id);
  const team = s.teams.find((t) => t.id === assignment?.team_id);
  const block = s.blocks.find((b) => b.team_id === team?.id && b.block_no === s.event.current_block);
  const game = s.games.find((g) => g.id === block?.current_game_id);
  const needsSync = s.games.some((g) => g.phase === "ENSEMBLE_VOTE" && g.vote_deadline && ms(g.vote_deadline)! <= ms(s.now)! && !s.blocks.find((b) => b.id === g.team_block_id)?.paused_at);
  const out: PublicState = { serverNow: s.now, poll: { intervalMs: block?.phase === "IN_GAME" ? s.event.config_json.pollInGameMs : s.event.config_json.pollIdleMs, needsSync },
    versions: { session: s.event.session_version, ...(block ? { team: block.team_version } : {}) },
    event: { slug: s.event.slug, title: s.event.title, phase: s.event.phase, currentBlock: s.event.current_block, teamCount: s.event.config_json.teamCount, ...gmEvent },
    me: me ? { ...person(me), isHost, profileComplete: !!me.profile_completed_at, introsSeen: intros } : null, allowedActions: [] };
  if (!me) {
    out.roster = s.people.filter((p) => p.active).map((p) => ({ ...person(p), locked: locked(s, p.id) }));
    out.allowedActions = ["claim", "operator"];
    return out;
  }
  const myAnswers = s.profiles.filter((answer) => answer.participant_id === me.id);
  out.profile = { answers: Object.fromEntries(myAnswers.map((answer) => [answer.question_id, answer.option])),
    revisions: Object.fromEntries(myAnswers.map((answer) => [answer.question_id, answer.revision])), complete: !!me.profile_completed_at, editable: !me.profile_locked_at };
  out.allowedActions.push("intro-ack");
  if (out.profile.editable) out.allowedActions.push("profile-save");
  if (!out.profile.complete && out.profile.editable) out.allowedActions.push("profile-submit", "release");
  if (team && (s.event.phase !== "SETUP" || s.event.teams_published_at)) {
    const teamMembers = s.people.filter((p) => s.assignments.some((a) => a.block_no === assignmentBlock(s) && a.team_id === team.id && a.participant_id === p.id));
    const inGame = !!game && s.members.some((member) => member.game_id === game.id && member.participant_id === me.id);
    out.team = { key: team.team_key, phase: block?.phase ?? "SEATING", paused: !!block?.paused_at,
      members: teamMembers.map((p) => ({ ...person(p), online: online(s, p.id) })),
      waitingForOthers: block?.phase === "BLOCK_DONE" && s.blocks.some((b) => b.block_no === s.event.current_block && b.phase !== "BLOCK_DONE"),
      notInCurrentGame: !!game && !inGame };
    if (block?.phase === "SEATING" && assignment) out.nextBlock = { teamKey: team.team_key, seatNo: assignment.seat_no, members: teamMembers.map((p) => p.display_name) };
    if (game && inGame) {
      out.game = gameDto(s, game, me, intros); out.versions.game = game.game_version;
      const control = me.role === "operator" && (isHost || team.operator_participant_id === me.id);
      if (!block?.paused_at) {
        if (game.phase === "TURN" && game.turn_lead_participant_id === me.id) {
          if (!gm && !game.exhausted) out.allowedActions.push("more-data");
          if (out.game.guess?.enabled) out.allowedActions.push("guess");
        }
        if (gm && control && game.phase === "TURN" && !game.exhausted) out.allowedActions.push("next-card");
        if (game.phase === "ENSEMBLE_SHARE" && (control || (!gm && game.ensemble_sharer_id === me.id))) out.allowedActions.push("ensemble-shared");
        if (game.phase === "ENSEMBLE_DISCUSS" && (control || (!gm && game.ensemble_sharer_id === me.id))) out.allowedActions.push("ensemble-end-discussion");
        if (game.phase === "ENSEMBLE_VOTE" && ms(game.vote_deadline)! > ms(s.now)!) out.allowedActions.push("ensemble-vote");
      }
    }
  }
  if (s.event.phase === "BREAK" || block?.phase === "SEATING" || block?.phase === "BLOCK_DONE") {
    const previous = s.games.filter((g) => g.phase === "REVEALED" && s.members.some((m) => m.game_id === g.id && m.participant_id === me.id))
      .sort((a, b) => (ms(b.revealed_at) ?? 0) - (ms(a.revealed_at) ?? 0))[0];
    if (previous) out.lastReveal = gameDto(s, previous, me, intros);
  }
  if (me.role === "operator") {
    out.admin = adminDto(s, me, isHost);
    out.allowedActions.push("unlock-participant", "mark-attendance");
    if (isHost) {
      out.allowedActions.push("transfer-host", "update-global-settings", "end-session");
      if (gm || s.event.current_block < 3) out.allowedActions.push("upsert-participant", "remove-participant");
      if (gm && s.event.phase === "BLOCK") {
        if (s.event.rotation_requested) out.allowedActions.push("cancel-rotation");
        else if (s.event.current_block < MAX_EVENT_ROUND) out.allowedActions.push("request-rotation");
      }
      if (s.event.phase === "SETUP") {
        out.allowedActions.push("assign-teams");
        if (s.event.draft_assignments) out.allowedActions.push("publish-teams", "swap-seats");
        if (s.event.teams_published_at) out.allowedActions.push("start-game1");
      }
      if (s.event.phase === "BREAK" && s.event.next_block_plan?.assignments.length) out.allowedActions.push("publish-next-block", "swap-seats");
    }
    const controlled = out.admin.teams.filter((t) => t.canControl);
    if (controlled.length) out.allowedActions.push("update-team-settings", "apply-preset");
    if (s.event.phase === "BLOCK" && !s.event.rotation_requested && controlled.some((t) => t.phase === "SEATING")) out.allowedActions.push("start-block-game");
    if (!s.event.rotation_requested && controlled.some((t) => t.phase === "REVEAL")) out.allowedActions.push(gm ? "gm-next-game" : "next-game");
    if (gm && s.event.rotation_requested && s.event.phase === "BLOCK" && controlled.some((t) => ["SEATING", "REVEAL"].includes(t.phase))) out.allowedActions.push("rotation-ready");
    if (controlled.some((t) => t.phase === "IN_GAME")) out.allowedActions.push("force-end-game");
    if (controlled.some((t) => t.phase === "IN_GAME" && t.stage === "TURN")) out.allowedActions.push("transfer-turn-lead");
    if (controlled.some((t) => t.phase === "IN_GAME" && ["TURN", "ENSEMBLE_SHARE"].includes(t.stage ?? ""))) out.allowedActions.push("resend-data");
    // The GM remote operates the viewer's own game. A different team's open
    // gate must not enable the head GM's closed/locked game controls.
    if (gm) for (const team of controlled.filter((t) => t.key === out.team?.key && t.phase === "IN_GAME" && t.stage === "TURN" && !t.paused)) {
      const game = s.games.find((g) => g.id === team.gameId)!;
      const count = s.cards.filter((c) => c.game_id === game.id).length;
      const config = settings(game.config_snapshot);
      if (game.gm_guess_open) out.allowedActions.push("close-guess");
      else if (!game.guess_locked && count >= (game.game_no === 1 ? config.guessEnableAfter.game1 : config.guessEnableAfter.others)) out.allowedActions.push("open-guess");
    }
    if (controlled.some((t) => !t.paused && t.stage === "ENSEMBLE_SHARE")) out.allowedActions.push("ensemble-shared");
    if (controlled.some((t) => !t.paused && t.stage === "ENSEMBLE_DISCUSS")) out.allowedActions.push("ensemble-end-discussion");
    if (controlled.some((t) => t.phase === "IN_GAME" && !t.paused)) out.allowedActions.push("pause");
    if (controlled.some((t) => t.phase === "IN_GAME" && t.paused)) out.allowedActions.push("resume");
  }
  out.allowedActions = [...new Set(out.allowedActions)];
  return out;
}

export async function getState(slug: string, tokenHash: string): Promise<PublicState> {
  return buildPublicState(await loadStateSnapshot(slug, tokenHash));
}
