import 'server-only';

import { sameCount } from './metrics';
import type { DataCard, GameMember, Rng } from './types';

export function selectBehindData({ members, ownerId, cards, groundTruthCardNo, rng }: {
  members: readonly GameMember[]; ownerId: string; cards: readonly DataCard[]; groundTruthCardNo?: number | null; rng: Rng;
}): DataCard | null {
  const real = cards.filter((card) => !card.isNoise);
  const verified = real.find((card) => card.cardNo === groundTruthCardNo);
  if (verified) return verified;
  const common = real.filter((card) => { const count = sameCount(members, ownerId, card.questionId); return count >= 2 && count <= 4; });
  return common.length ? rng.pick(common) : [...real].sort((a, b) => a.cardNo - b.cardNo)[0] ?? null;
}
