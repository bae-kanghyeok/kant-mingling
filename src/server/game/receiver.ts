import 'server-only';

import { GameRuleError, type GameMember, type Rng } from './types';

export interface CardDelivery { participantId: string; cardNo: number; reason: 'initial' | 'resend' }
export interface SelectReceiverInput {
  members: readonly GameMember[];
  deliveries: readonly CardDelivery[];
  previousInitialRecipientId: string | null;
  previousTurnLeadId: string | null;
  dataSplit: boolean;
  nowMs: number;
  presenceWindowSeconds: number;
  rng: Rng;
}

export function selectReceiver(input: SelectReceiverInput): { recipientIds: string[]; turnLeadId: string } {
  const { members, deliveries, dataSplit, rng } = input;
  if (!members.length) throw new GameRuleError('NO_GAME_MEMBERS');
  if (!dataSplit) {
    const ordered = [...members].sort((a, b) => a.rosterOrder - b.rosterOrder || a.id.localeCompare(b.id));
    const previous = ordered.findIndex((member) => member.id === input.previousTurnLeadId);
    return { recipientIds: ordered.map((member) => member.id), turnLeadId: ordered[(previous + 1) % ordered.length].id };
  }
  const online = members.filter((member) => member.lastSeenAtMs != null && input.nowMs - member.lastSeenAtMs <= input.presenceWindowSeconds * 1000);
  // Avoid consecutive recipients even if only that person is currently online.
  // Offline members remain recoverable through admin resend/lead transfer.
  let pool = (online.length ? online : members).filter((member) => member.id !== input.previousInitialRecipientId);
  if (!pool.length) pool = members.filter((member) => member.id !== input.previousInitialRecipientId);
  if (!pool.length) pool = [...members];
  const counts = new Map(members.map((member) => [member.id, deliveries.filter((delivery) => delivery.participantId === member.id).length]));
  const least = Math.min(...pool.map((member) => counts.get(member.id) ?? 0));
  const chosen = rng.pick(pool.filter((member) => counts.get(member.id) === least));
  return { recipientIds: [chosen.id], turnLeadId: chosen.id };
}
