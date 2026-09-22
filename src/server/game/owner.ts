import 'server-only';

import { assertPlayableMembers, sameCount } from './metrics';
import type { GameMember, Rng } from './types';

export interface SelectOwnerInput {
  members: readonly GameMember[];
  previousOwnerIdsInBlock: readonly string[];
  rng: Rng;
}

export function selectOwner({ members, previousOwnerIdsInBlock, rng }: SelectOwnerInput): { ownerId: string; fallback: boolean } {
  assertPlayableMembers(members);
  const unused = members.filter((member) => !previousOwnerIdsInBlock.includes(member.id));
  const pool = unused.length ? unused : [...members];
  const ordered = rng.shuffle(pool).sort((a, b) => (a.ownerCount ?? 0) - (b.ownerCount ?? 0));
  for (const member of ordered) {
    const usable = Object.keys(member.answers).some((question) => {
      const count = sameCount(members, member.id, question);
      return count >= 3 && count <= 6 && count !== members.length;
    });
    if (usable) return { ownerId: member.id, fallback: false };
  }
  // Spec fallback: broadest non-unanimous answer, fairness order breaks ties.
  // Q2 also permits all-common profiles; those retain the fairness order.
  const broadest = (member: GameMember) => Math.max(0, ...Object.keys(member.answers)
    .map((question) => sameCount(members, member.id, question)).filter((count) => count !== members.length));
  const bestCount = Math.max(...ordered.map(broadest));
  return { ownerId: ordered.find((member) => broadest(member) === bestCount)!.id, fallback: true };
}
