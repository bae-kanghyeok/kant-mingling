import 'server-only';

import { assertPlayableMembers, compareLexicographic, getAnswer, getOwner, opposite, possibleSet } from './metrics';
import { GameRuleError, type CardSelection, type DataCard, type GameMember, type Rng } from './types';

export interface SelectNoiseCardInput {
  ownerId: string;
  members: readonly GameMember[];
  cards: readonly DataCard[];
  groundTruthCardNos?: readonly number[];
  rng: Rng;
}

export function selectNoiseCard({ ownerId, members, cards, groundTruthCardNos = [], rng }: SelectNoiseCardInput): CardSelection {
  assertPlayableMembers(members);
  const owner = getOwner(members, ownerId);
  const used = new Set(cards.map((card) => card.questionId));
  if (used.size !== cards.length) throw new GameRuleError('DUPLICATE_CARD_QUESTION');
  const available = Object.keys(owner.answers).filter((question) => !used.has(question));
  if (!available.length) return { kind: 'exhausted' };
  const noiseCount = cards.filter((card) => card.isNoise).length;
  const realCount = cards.length - noiseCount;
  const strong = new Set(possibleSet(members, cards, noiseCount, groundTruthCardNos).filter((id) => id !== ownerId));
  const ranked = available.map((questionId) => {
    const noiseValue = opposite(getAnswer(owner, questionId));
    const card: DataCard = { cardNo: cards.length + 1, questionId, displayedOption: noiseValue, trueOption: getAnswer(owner, questionId), isNoise: true };
    const pickers = members.filter((member) => getAnswer(member, questionId) === noiseValue);
    const possible = possibleSet(members, [...cards, card], noiseCount + 1, groundTruthCardNos).length;
    const score = [pickers.length >= 2 && pickers.length <= 5 ? 2 : pickers.length >= 1 ? 1 : 0,
      possible >= 2 && possible <= 3 ? 3 : possible >= 4 ? 2 : realCount >= 7 ? 1 : 0,
      pickers.filter((member) => strong.has(member.id)).length];
    return { card, score };
  }).sort((a, b) => compareLexicographic(b.score, a.score));
  const best = ranked.filter((item) => compareLexicographic(item.score, ranked[0].score) === 0);
  return { kind: 'selected', card: rng.pick(best).card, fallback: null };
}
