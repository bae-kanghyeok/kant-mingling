import 'server-only';

import { getAnswer, sameCount } from './metrics';
import type { TeamSettings } from './settings';
import type { DataCard, GameMember, GuessAttempt, Rng, VoteResult } from './types';

export interface GroundTruthSelectionInput {
  members: readonly GameMember[];
  ownerId: string;
  cards: readonly DataCard[];
  attempts: readonly GuessAttempt[];
  results: readonly VoteResult[];
  rng: Rng;
}

export function selectGroundTruth(input: GroundTruthSelectionInput): DataCard | null {
  const real = input.cards.filter((card) => !card.isNoise && sameCount(input.members, input.ownerId, card.questionId) !== 1);
  if (!real.length) return null;
  const frequency = (card: DataCard) => input.attempts.filter((attempt) => !attempt.correct && attempt.noisePicks.includes(card.cardNo)).length;
  const maxFrequency = Math.max(...real.map(frequency));
  let pool = maxFrequency > 0 ? real.filter((card) => frequency(card) === maxFrequency) : [];
  if (!pool.length) {
    const maxVotes = Math.max(0, ...input.results.map((result) => result.votes));
    const topIds = new Set(maxVotes > 0 ? input.results.filter((result) => result.votes === maxVotes).map((result) => result.participantId) : []);
    const topMembers = input.members.filter((member) => topIds.has(member.id));
    pool = real.filter((card) => topMembers.some((member) => getAnswer(member, card.questionId) !== card.displayedOption));
  }
  if (!pool.length) pool = real;
  const common = pool.filter((card) => { const count = sameCount(input.members, input.ownerId, card.questionId); return count >= 2 && count <= 4; });
  return input.rng.pick(common.length ? common : pool);
}

export interface GroundTruthState {
  status: 'none' | 'pending' | 'announced' | 'skipped';
  needed: number;
  cardNo: number | null;
}

export interface AdvanceGroundTruthInput extends GroundTruthSelectionInput {
  gameNo: number;
  settings: TeamSettings;
  state: GroundTruthState;
  event: 'ensemble-finished' | 'real-card' | 'game-ended';
}

export function advanceGroundTruth(input: AdvanceGroundTruthInput): GroundTruthState {
  const { state, settings, event } = input;
  if (state.status === 'announced' || state.status === 'skipped') return { ...state };
  if (event === 'game-ended') return { status: 'skipped', needed: 0, cardNo: null };
  if (settings.groundTruthPerGame === 0 || !settings.groundTruthGames.includes(input.gameNo) || !settings.ensembleGames.includes(input.gameNo)) return { ...state };
  let needed = Math.max(0, state.needed);
  if (event === 'ensemble-finished' && state.status === 'none') needed = settings.gtRealCardsAfterEnsemble;
  else if (event === 'real-card' && state.status === 'pending') needed = Math.max(0, needed - 1);
  else return { ...state };
  if (needed > 0) return { status: 'pending', needed, cardNo: null };
  const card = selectGroundTruth(input);
  return card ? { status: 'announced', needed: 0, cardNo: card.cardNo } : { status: 'pending', needed: 0, cardNo: null };
}
