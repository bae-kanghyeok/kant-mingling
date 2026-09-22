import type { TeamSettings, GlobalConfig } from "@/server/game/settings";
export type IntroKey = "tutorial" | "noise" | "ensemble" | "ground_truth";
export type Person = { participantId: string; displayName: string; role: "student" | "operator" };
export type TeamPhase = "SEATING" | "IN_GAME" | "REVEAL" | "BLOCK_DONE";
export type GamePhase = "TURN" | "ENSEMBLE_SHARE" | "ENSEMBLE_VOTE" | "ENSEMBLE_DISCUSS" | "REVEALED";
export type CardQuestion = { category: string; options: { A: string; B: string } };
export interface PublicGame {
  gameId: string; gameNo: number; phase: GamePhase;
  turnLead: Pick<Person,"participantId"|"displayName"> | null;
  candidates: Pick<Person,"participantId"|"displayName">[];
  cards: { cardNo: number; recipients: Pick<Person,"participantId"|"displayName">[]; question?: CardQuestion; text?: string; verified?: true }[];
  exhausted: boolean;
  guess?: { enabled: boolean; locked: boolean; noiseCount?: number };
  ensemble?: { stage: "SHARE"|"VOTE"|"DISCUSS"; triggerCardNo: number; sharer: Pick<Person,"participantId"|"displayName">;
    voteDeadline?: string; voteRemainingMs?: number; myVote?: string|null; myRevision?: number;
    results?: { participantId: string; displayName: string; votes: number }[] };
  groundTruth?: { cardNo: number };
  pendingOverlay?: { kind: "noise"|"ensemble"|"ground_truth"; cardNo?: number; cardCount?: number; noiseCount?: number };
  reveal?: { owner: Pick<Person,"participantId"|"displayName">; endReason: "correct"|"forced"|"session_end";
    cards: { cardNo: number; question: CardQuestion; text: string; status: "REAL"|"NOISE"|"GROUND_TRUTH"; ownerActualText?: string }[];
    behind: { choiceText: string; followUp: string } };
}
export interface AdminView {
  isHost: boolean;
  teams: { key: string; operatorName: string; phase: string; paused: boolean; gameNo: number|null;
    revealedCount: number; stage: string|null; turnLeadName: string|null;
    members: (Person & { online: boolean; profileComplete: boolean; attendance: string })[];
    timers: { gameElapsedMs: number|null; blockElapsedMs: number|null; blockTargetMs: number };
    settings: TeamSettings; canControl: boolean; version: number; gameVersion?: number; gameId?: string }[];
  registration?: (Person & { locked: boolean; profileComplete: boolean; attendance: string; active?: boolean; pending?: boolean })[];
  globalSettings?: GlobalConfig;
  nextBlockPlan?: { teamKey: string; members: string[] }[];
  recentLogs: { command: string; actorName: string; target: string|null; at: string }[];
}
export interface PublicState {
  serverNow: string; poll: { intervalMs: number; needsSync: boolean };
  versions: { session: number; team?: number; game?: number };
  event: { slug: string; title: string; phase: "SETUP"|"BLOCK"|"BREAK"|"ENDED"; currentBlock: number };
  me: (Person & { isHost: boolean; profileComplete: boolean; introsSeen: IntroKey[] })|null;
  roster?: (Person & { locked: boolean })[];
  profile?: { answers: Partial<Record<string,"A"|"B">>; revisions: Partial<Record<string,number>>; complete: boolean; editable: boolean };
  team?: { key: string; phase: TeamPhase; paused: boolean; members: (Person & { online: boolean })[];
    waitingForOthers: boolean; notInCurrentGame: boolean };
  nextBlock?: { teamKey: string; seatNo: number; members: string[] };
  game?: PublicGame; lastReveal?: PublicGame; allowedActions: string[]; admin?: AdminView;
}
