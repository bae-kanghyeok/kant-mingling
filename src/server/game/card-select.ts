import 'server-only';

import { assertPlayableMembers, candidateCount, getAnswer, getOwner, sameCount } from './metrics';
import { GameRuleError, type CardFallback, type CardSelection, type DataCard, type GameMember, type Rng } from './types';

export interface SelectRealCardInput {
  ownerId: string;
  members: readonly GameMember[];
  cards: readonly DataCard[];
  rareFromRealOrdinal: number;
  rng: Rng;
}

export function selectRealCard({ ownerId, members, cards, rareFromRealOrdinal, rng }: SelectRealCardInput): CardSelection {
  assertPlayableMembers(members);
  const owner = getOwner(members, ownerId);
  const used = new Set(cards.map((card) => card.questionId));
  if (used.size !== cards.length) throw new GameRuleError('DUPLICATE_CARD_QUESTION');
  const remaining = Object.keys(owner.answers).filter((question) => !used.has(question));
  if (!remaining.length) return { kind: 'exhausted' };
  const realCards = cards.filter((card) => !card.isNoise);
  const ordinal = realCards.length + 1;
  const count = (question: string) => sameCount(members, ownerId, question);
  let available = remaining.filter((question) => count(question) !== members.length && (ordinal >= rareFromRealOrdinal || count(question) > 2));
  let fallback: CardFallback = null;
  if (!available.length) {
    available = remaining.filter((question) => count(question) === members.length);
    if (available.length) fallback = 'COMMON_CARD_FALLBACK';
    else { available = remaining; fallback = 'RARE_CARD_FALLBACK'; }
  }
  const asCard = (questionId: string): DataCard => ({
    cardNo: cards.length + 1, questionId, displayedOption: getAnswer(owner, questionId),
    trueOption: getAnswer(owner, questionId), isNoise: false,
  });
  if (ordinal <= 2 && !fallback) {
    for (const counts of [[3, 4], [5], [6]]) {
      const tier = available.filter((question) => counts.includes(count(question)));
      if (tier.length) return { kind: 'selected', card: asCard(rng.pick(tier)), fallback };
    }
  }
  const [min, max] = ordinal <= 4 ? [2, 4] : ordinal < rareFromRealOrdinal ? [2, 3] : [1, 2];
  const distances = available.map((question) => {
    const after = candidateCount(members, [...realCards, asCard(question)]);
    return { question, distance: after < min ? min - after : after > max ? after - max : 0 };
  });
  const best = Math.min(...distances.map((item) => item.distance));
  return { kind: 'selected', card: asCard(rng.pick(distances.filter((item) => item.distance === best)).question), fallback };
}
