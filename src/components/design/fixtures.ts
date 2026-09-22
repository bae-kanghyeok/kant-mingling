import { questions } from "@/content/catalog";
import type { AdminView, Person, PublicGame, PublicState } from "@/lib/contracts";
import type { GlobalConfig, TeamSettings } from "@/server/game/settings";

export const previewViews = [
  ["entry", "입장"], ["profile", "프로필"], ["received", "단서 수신"],
  ["sealed", "단서 비수신"], ["noise", "Noise"], ["ground-truth", "Ground Truth"],
  ["ground-truth-again", "Ground Truth 재등장"], ["vote", "투표"],
  ["results", "투표 결과"], ["reveal", "정답 공개"], ["admin", "관제"],
] as const;
export type PreviewView = typeof previewViews[number][0];

const students: Person[] = Array.from({ length: 18 }, (_, index) => ({
  participantId: `design-student-${index + 1}`,
  displayName: `학생${String(index + 1).padStart(2, "0")}`,
  role: "student",
}));
const operators: Person[] = ["A", "B", "C"].map((key) => ({
  participantId: `design-operator-${key}`, displayName: `운영진${key}`, role: "operator",
}));
export const previewPeople = [...students, ...operators];
const teamMembers = (index: number) => [...students.slice(index * 6, index * 6 + 6), operators[index]];
const syntheticNow = "2026-01-01T09:00:00.000Z";
const weather = questions.find((question) => question.options.A.includes("장마")) ?? questions[0];
const otherQuestion = questions.find((question) => question.id !== weather.id) ?? questions[1];
const questionContext = (question: typeof questions[number]) => ({ category: question.category, options: question.options });

const teamSettings: TeamSettings = {
  preset: "normal", dataSplitGames: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  noiseGames: [2, 3, 4, 5, 6, 7, 8, 9], noiseFirstRange: [2, 3], noiseAutoAdd: true,
  noiseCap: 3, groundTruthGames: [4, 5, 6, 7, 8, 9], groundTruthPerGame: 1,
  gtRealCardsAfterEnsemble: 0, ensembleGames: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ensembleTriggerOverride: null, rareFromRealOrdinal: 7, guessEnableAfter: { game1: 1, others: 3 },
};
const globalSettings: GlobalConfig = {
  studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
  operatorTeamByName: { "운영진A": "A", "운영진B": "B", "운영진C": "C" },
  blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24, presenceWindowSeconds: 15,
  pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30,
};

function createGame(): PublicGame {
  return {
    gameId: "design-preview-game", gameNo: 4, phase: "TURN", turnLead: students[0],
    candidates: teamMembers(0), exhausted: false, guess: { enabled: true, locked: false, noiseCount: 1 },
    cards: [
      { cardNo: 1, recipients: [students[0]], question: questionContext(otherQuestion), text: otherQuestion.options.A },
      { cardNo: 2, recipients: [students[1]] },
      { cardNo: 3, recipients: [students[0]], question: questionContext(weather), text: weather.options.B },
    ],
  };
}

function createAdmin(): AdminView {
  return {
    isHost: true, globalSettings: structuredClone(globalSettings),
    teams: ["A", "B", "C"].map((key, index) => ({
      key, operatorName: operators[index].displayName, phase: "IN_GAME", paused: index === 2,
      gameNo: 4 + index, revealedCount: 3 + index, stage: index === 1 ? "ENSEMBLE_VOTE" : "TURN",
      turnLeadName: students[index * 6].displayName,
      members: teamMembers(index).map((person, memberIndex) => ({ ...person, online: memberIndex !== 3, profileComplete: true, attendance: "present" })),
      timers: { gameElapsedMs: 125000 + index * 30000, blockElapsedMs: 365000, blockTargetMs: 720000 },
      settings: structuredClone(teamSettings), canControl: true, version: 1,
      gameVersion: 1, gameId: `design-game-${key}`,
    })),
    registration: previewPeople.map((person) => ({ ...person, locked: true, profileComplete: true, attendance: "present", active: true })),
    recentLogs: [{ command: "start-game1", actorName: "운영진A", target: null, at: syntheticNow }],
  };
}

/** Synthetic display fixtures only. No server state, credentials or hidden game fields. */
export function createPreviewState(view: PreviewView): PublicState {
  const game = createGame();
  const state: PublicState = {
    serverNow: syntheticNow, poll: { intervalMs: 5000, needsSync: false },
    versions: { session: 1, team: 1, game: 1 },
    event: { slug: "design-preview-only", title: "디자인 미리보기 · 합성 행사", phase: "BLOCK", currentBlock: 2 },
    me: { ...students[0], isHost: false, profileComplete: true, introsSeen: ["tutorial", "noise", "ensemble"] },
    team: { key: "A", phase: "IN_GAME", paused: false, members: teamMembers(0).map((person) => ({ ...person, online: true })), waitingForOthers: false, notInCurrentGame: false },
    game, allowedActions: ["more-data", "guess", "intro-ack"],
  };
  if (view === "entry") {
    state.me = null; state.game = undefined; state.team = undefined;
    state.event.phase = "SETUP"; state.event.currentBlock = 0;
    state.roster = previewPeople.map((person) => ({ ...person, locked: false }));
    state.allowedActions = [];
  }
  if (view === "profile") {
    state.game = undefined; state.team = undefined; state.event.phase = "SETUP"; state.event.currentBlock = 0;
    state.me = { ...state.me!, profileComplete: false };
    state.profile = {
      answers: Object.fromEntries(questions.slice(0, 3).map((question, index) => [question.id, index === 1 ? "B" : "A"])),
      revisions: Object.fromEntries(questions.slice(0, 3).map((question) => [question.id, 1])), complete: false, editable: true,
    };
  }
  if (view === "sealed") {
    game.turnLead = students[1]; state.allowedActions = ["intro-ack"];
    game.cards[2] = { cardNo: 3, recipients: [students[1]] };
  }
  if (view === "noise") game.pendingOverlay = { kind: "noise", cardCount: 3, noiseCount: 1 };
  if (view === "ground-truth" || view === "ground-truth-again") {
    game.cards[0].verified = true; game.groundTruth = { cardNo: 1 };
    game.pendingOverlay = { kind: "ground_truth", cardNo: 1 };
    if (view === "ground-truth-again") state.me!.introsSeen.push("ground_truth");
  }
  if (view === "vote" || view === "results") {
    game.phase = view === "vote" ? "ENSEMBLE_VOTE" : "ENSEMBLE_DISCUSS";
    game.ensemble = {
      stage: view === "vote" ? "VOTE" : "DISCUSS", triggerCardNo: 3, sharer: students[0],
      ...(view === "vote" ? { voteDeadline: "2026-01-01T09:00:30.000Z", myVote: null, myRevision: 0 } : {
        results: teamMembers(0).map((person, index) => ({ ...person, votes: [1, 3, 2, 0, 0, 1, 0][index] })),
      }),
    };
    state.allowedActions = view === "vote" ? ["ensemble-vote"] : ["ensemble-end-discussion"];
  }
  if (view === "reveal") {
    game.phase = "REVEALED"; state.team!.phase = "REVEAL";
    game.reveal = {
      owner: students[1], endReason: "correct",
      cards: [
        { cardNo: 1, question: questionContext(otherQuestion), text: otherQuestion.options.A, status: "GROUND_TRUTH" },
        { cardNo: 2, question: questionContext(weather), text: weather.options.A, status: "NOISE", ownerActualText: weather.options.B },
        { cardNo: 3, question: questionContext(weather), text: weather.options.B, status: "REAL" },
      ],
      behind: { choiceText: weather.options.B, followUp: weather.followUp },
    };
    state.allowedActions = [];
  }
  if (view === "admin") {
    state.me = { ...operators[0], isHost: true, profileComplete: true, introsSeen: ["tutorial", "noise", "ensemble", "ground_truth"] };
    // This operator did not receive these cards. Show only public card metadata.
    game.cards = game.cards.map(({ cardNo, recipients }) => ({ cardNo, recipients }));
    state.admin = createAdmin();
    state.allowedActions = ["pause", "resume", "force-end-game", "end-session", "transfer-host", "unlock-participant", "transfer-turn-lead", "resend-data", "update-team-settings", "update-global-settings", "apply-preset", "mark-attendance", "upsert-participant", "remove-participant"];
  }
  return state;
}
