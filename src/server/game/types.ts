import 'server-only';

export type Option = 'A' | 'B';
export type ProfileAnswers = Readonly<Record<string, Option>>;
export type ParticipantRole = 'student' | 'operator';

export interface GameMember {
  id: string;
  role: ParticipantRole;
  rosterOrder: number;
  answers: ProfileAnswers;
  profileComplete: boolean;
  ownerCount?: number;
  lastSeenAtMs?: number | null;
}

/** Private engine value. Never spread this object into a public DTO. */
export interface DataCard {
  cardNo: number;
  questionId: string;
  displayedOption: Option;
  trueOption: Option;
  isNoise: boolean;
}

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

export class GameRuleError extends Error {
  constructor(public readonly code: string, message: string = code) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export type CardFallback = 'COMMON_CARD_FALLBACK' | 'RARE_CARD_FALLBACK' | null;
export type CardSelection =
  | { kind: 'selected'; card: DataCard; fallback: CardFallback }
  | { kind: 'exhausted' };

export interface TeamAssignment {
  participantId: string;
  teamKey: string;
  role: ParticipantRole;
  seatNo: number;
}

export interface RosterEntry {
  id: string;
  displayName: string;
  role: ParticipantRole;
  active?: boolean;
  rosterOrder: number;
}

export type GamePhase = 'TURN' | 'ENSEMBLE_SHARE' | 'ENSEMBLE_VOTE' | 'ENSEMBLE_DISCUSS' | 'REVEALED';

export interface GuessAttempt {
  ownerPick: string;
  noisePicks: readonly number[];
  correct: boolean;
}

export interface EnsembleVote {
  voterId: string;
  pickId: string;
}

export interface VoteResult {
  participantId: string;
  votes: number;
}
