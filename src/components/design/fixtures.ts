import { questions } from "@/content/catalog";
import type { AdminView, Person, PublicGame, PublicState } from "@/lib/contracts";
import type { GlobalConfig, TeamSettings } from "@/server/game/settings";

export const previewScenarios = [
  { key: "entry", label: "첫 입장", group: "등록 · 준비", description: "QR 링크로 처음 들어왔을 때의 환영 화면입니다." },
  { key: "tutorial", label: "게임 방법", group: "등록 · 준비", description: "Data Owner, 단서 공유, Turn Lead를 세 장으로 안내합니다." },
  { key: "names", label: "이름 선택", group: "등록 · 준비", description: "학생은 이름을 선택하고, 운영진은 추가 코드 인증을 받습니다." },
  { key: "operator", label: "운영진 로그인", group: "등록 · 준비", description: "화면 체험에서는 임의의 글자를 입력해도 넘어갑니다. 실제 코드는 입력하지 마세요." },
  { key: "profile", label: "프로필 작성", group: "등록 · 준비", description: "A/B 질문에 답하거나 ‘합성 답변 20개 채우기’로 제출 화면까지 확인하세요." },
  { key: "waiting", label: "조 배정 전", group: "등록 · 준비", description: "프로필 제출 후 호스트가 조를 배정할 때까지 기다립니다." },
  { key: "seating", label: "조 배정 · 착석", group: "등록 · 준비", description: "자신의 조와 함께할 사람을 확인한 뒤 게임 시작을 기다립니다." },
  { key: "received", label: "첫 단서 수신", group: "단서 · 특수 규칙", description: "첫 단서를 받은 사람에게 질문 원문과 선택한 답이 보입니다." },
  { key: "sealed", label: "다른 사람의 단서", group: "단서 · 특수 규칙", description: "수신자가 아닌 사람은 전달 대상만 보고 말로 단서를 듣습니다." },
  { key: "turn-lead", label: "Turn Lead", group: "단서 · 특수 규칙", description: "마지막 수신자가 추가 단서 또는 추리를 선택합니다." },
  { key: "noise", label: "Noise 첫 안내", group: "단서 · 특수 규칙", description: "Noise가 있다는 사실과 개수만 알립니다. 어느 단서인지는 공개하지 않습니다." },
  { key: "noise-again", label: "Noise 추가 안내", group: "단서 · 특수 규칙", description: "Noise가 늘었을 때도 같은 안내 방식으로 현재 개수만 표시합니다." },
  { key: "ensemble-intro", label: "Ensemble 안내", group: "단서 · 특수 규칙", description: "개별 생각을 먼저 모으는 Ensemble 규칙을 안내합니다." },
  { key: "ensemble-share", label: "Ensemble 단서 공유", group: "단서 · 특수 규칙", description: "수신자가 단서를 말로 전달하고 ‘공유했어요’를 누릅니다." },
  { key: "vote", label: "Ensemble 투표", group: "단서 · 특수 규칙", description: "30초 동안 각자 후보를 고릅니다. 둘러보기의 결과는 ‘다음 화면’으로 확인하세요." },
  { key: "results", label: "투표 결과 · 토론", group: "단서 · 특수 규칙", description: "정답을 공개하지 않고 선택 분포를 보며 이유를 이야기합니다." },
  { key: "ground-truth", label: "Ground Truth 첫 안내", group: "단서 · 특수 규칙", description: "단서 하나가 실제 Data임을 확인해 줍니다." },
  { key: "ground-truth-again", label: "Ground Truth 재등장", group: "단서 · 특수 규칙", description: "이미 규칙을 본 사람에게는 짧은 안내가 나타납니다." },
  { key: "guess", label: "최종 추리 입력", group: "추리 · 결과", description: "Data Owner 한 명과 Noise 단서를 함께 선택합니다. 이 예시는 오답 화면으로 이어집니다." },
  { key: "wrong", label: "오답 안내", group: "추리 · 결과", description: "오답이면 새 단서를 본 뒤 다시 추리하도록 안내합니다." },
  { key: "reveal", label: "정답 · 후속 대화", group: "추리 · 결과", description: "정답과 실제/Noise 단서를 공개하고 대화를 이어갈 질문을 제공합니다." },
  { key: "paused", label: "일시정지", group: "운영 · 자리 이동", description: "운영진이 멈춘 동안 참가자의 게임 조작은 비활성화됩니다." },
  { key: "late-join", label: "늦게 합류", group: "운영 · 자리 이동", description: "현재 게임 도중 합류한 참가자는 다음 게임부터 참여합니다." },
  { key: "block-waiting", label: "다른 조 대기", group: "운영 · 자리 이동", description: "우리 조가 먼저 블록을 마치면 다른 조를 기다리며 대화를 계속합니다." },
  { key: "block-complete", label: "다음 조 공개 대기", group: "운영 · 자리 이동", description: "모든 조의 블록이 끝나면 호스트의 다음 조 공개를 기다립니다." },
  { key: "seat-move", label: "자리 이동", group: "운영 · 자리 이동", description: "새 조와 자리 번호를 확인합니다. 재접속할 필요가 없습니다." },
  { key: "final-waiting", label: "마지막 대화", group: "운영 · 자리 이동", description: "마지막 블록 후 전체 종료 전까지 대화를 이어갑니다." },
  { key: "ended", label: "전체 종료", group: "운영 · 자리 이동", description: "행사 종료 안내와 마지막 게임 결과 다시 보기를 확인합니다." },
  { key: "admin-setup", label: "호스트 시작 준비", group: "관리자", description: "조 편성 → 조 배정 공개 → Game 1 전체 시작 순서로 눌러볼 수 있습니다." },
  { key: "admin", label: "진행 관제", group: "관리자", description: "세 조의 진행과 연결 상태, 일시정지·복구·전체 종료를 확인합니다." },
  { key: "admin-people", label: "참가자 관리", group: "관리자", description: "합성 명단의 출석·잠금 해제·명단 관리 화면입니다. 저장은 실행하지 않습니다." },
  { key: "admin-settings", label: "게임 설정", group: "관리자", description: "조별 규칙과 호스트의 전체 설정을 확인합니다. 저장은 실행하지 않습니다." },
  { key: "admin-logs", label: "운영 기록", group: "관리자", description: "합성 운영 기록을 보여줍니다. 실제 DB의 로그는 읽지 않습니다." },
] as const;
export type PreviewView = typeof previewScenarios[number]["key"];
export const previewViews = previewScenarios.map(({ key, label }) => [key, label] as const);
export const previewGroups = [...new Set(previewScenarios.map(({ group }) => group))];
export const isAdminPreview = (view: PreviewView) => view === "admin" || view.startsWith("admin-");

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
const thirdQuestion = questions.find((question) => question.id !== weather.id && question.id !== otherQuestion.id) ?? questions[2];
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
    recentLogs: [
      { command: "resume", actorName: "운영진A", target: "A조", at: syntheticNow },
      { command: "pause", actorName: "운영진A", target: "A조", at: "2026-01-01T08:59:00.000Z" },
      { command: "publish-next-block", actorName: "운영진A", target: null, at: "2026-01-01T08:53:00.000Z" },
      { command: "start-game1", actorName: "운영진A", target: null, at: "2026-01-01T08:40:00.000Z" },
    ],
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
  if (["entry", "tutorial", "names", "operator"].includes(view)) {
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
  if (view === "received") {
    game.gameNo = 1; state.event.currentBlock = 1;
    game.cards = [{ cardNo: 1, recipients: [students[0]], question: questionContext(weather), text: weather.options.B }];
    game.guess = { enabled: true, locked: false };
  }
  if (["waiting", "seating", "seat-move", "late-join"].includes(view)) {
    state.game = undefined;
    if (view === "waiting") { state.team = undefined; state.event.phase = "SETUP"; state.event.currentBlock = 0; }
    else if (view === "late-join") state.team!.notInCurrentGame = true;
    else state.team!.phase = "SEATING";
    if (view === "seating") state.event.currentBlock = 1;
    if (view === "seat-move") {
      const movedMembers = [students[0], ...students.slice(6, 11), operators[1]];
      state.team = { ...state.team!, key: "B", members: movedMembers.map((person) => ({ ...person, online: true })) };
      state.nextBlock = { teamKey: "B", seatNo: 3, members: movedMembers.map((person) => person.displayName) };
    }
    state.allowedActions = [];
  }
  if (view === "noise" || view === "noise-again") {
    if (view === "noise") state.me!.introsSeen = state.me!.introsSeen.filter((intro) => intro !== "noise");
    else {
      game.cards.push({ cardNo: 4, recipients: [students[2]] }, { cardNo: 5, recipients: [students[0]], question: questionContext(otherQuestion), text: otherQuestion.options.B });
      game.guess!.noiseCount = 2;
    }
    game.pendingOverlay = { kind: "noise", cardCount: game.cards.length, noiseCount: game.guess!.noiseCount };
  }
  if (view === "ground-truth" || view === "ground-truth-again") {
    game.cards[0].verified = true; game.groundTruth = { cardNo: 1 };
    game.pendingOverlay = { kind: "ground_truth", cardNo: 1 };
    if (view === "ground-truth-again") state.me!.introsSeen.push("ground_truth");
  }
  if (["ensemble-intro", "ensemble-share", "vote", "results"].includes(view)) {
    const sharing = view === "ensemble-share";
    const voting = view === "vote" || view === "ensemble-intro";
    game.phase = sharing ? "ENSEMBLE_SHARE" : voting ? "ENSEMBLE_VOTE" : "ENSEMBLE_DISCUSS";
    game.ensemble = {
      stage: sharing ? "SHARE" : voting ? "VOTE" : "DISCUSS", triggerCardNo: 3, sharer: students[0],
      ...(voting ? { voteDeadline: "2026-01-01T09:00:30.000Z", myVote: null, myRevision: 0 } : !sharing ? {
        results: teamMembers(0).map((person, index) => ({ ...person, votes: [1, 3, 2, 0, 0, 1, 0][index] })),
      } : {}),
    };
    state.allowedActions = sharing ? ["ensemble-shared"] : voting ? ["ensemble-vote"] : ["ensemble-end-discussion"];
    if (view === "ensemble-intro") { game.pendingOverlay = { kind: "ensemble" }; state.me!.introsSeen = state.me!.introsSeen.filter((intro) => intro !== "ensemble"); }
  }
  if (["reveal", "block-waiting", "block-complete", "final-waiting", "ended"].includes(view)) {
    game.phase = "REVEALED"; state.team!.phase = "REVEAL";
    game.reveal = {
      owner: students[1], endReason: "correct",
      cards: [
        { cardNo: 1, question: questionContext(otherQuestion), text: otherQuestion.options.A, status: "GROUND_TRUTH" },
        { cardNo: 2, question: questionContext(thirdQuestion), text: thirdQuestion.options.A, status: "NOISE", ownerActualText: thirdQuestion.options.B },
        { cardNo: 3, question: questionContext(weather), text: weather.options.B, status: "REAL" },
      ],
      behind: { choiceText: weather.options.B, followUp: weather.followUp },
    };
    state.allowedActions = [];
    if (view !== "reveal") {
      state.team!.phase = "BLOCK_DONE";
      state.team!.waitingForOthers = view === "block-waiting";
      if (view === "block-complete") state.event.phase = "BREAK";
      if (view === "final-waiting" || view === "ended") { state.event.currentBlock = 3; game.gameNo = 9; }
      if (view === "ended") state.event.phase = "ENDED";
    }
  }
  if (view === "wrong") { game.guess!.enabled = false; game.guess!.locked = true; state.allowedActions = ["more-data"]; }
  if (view === "paused") { state.team!.paused = true; state.allowedActions = []; }
  if (isAdminPreview(view)) {
    state.me = { ...operators[0], isHost: true, profileComplete: true, introsSeen: ["tutorial", "noise", "ensemble", "ground_truth"] };
    // This operator did not receive these cards. Show only public card metadata.
    game.cards = game.cards.map(({ cardNo, recipients }) => ({ cardNo, recipients }));
    state.admin = createAdmin();
    state.allowedActions = ["pause", "resume", "force-end-game", "end-session", "transfer-host", "unlock-participant", "transfer-turn-lead", "resend-data", "update-team-settings", "update-global-settings", "apply-preset", "mark-attendance", "upsert-participant", "remove-participant"];
    if (view === "admin-setup") {
      state.event.phase = "SETUP"; state.event.currentBlock = 0; state.game = undefined; state.team = undefined;
      state.admin.teams = []; state.admin.recentLogs = [];
      state.allowedActions = ["assign-teams", "unlock-participant", "update-global-settings", "mark-attendance", "upsert-participant", "remove-participant"];
    }
  }
  return state;
}
