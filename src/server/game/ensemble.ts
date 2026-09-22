import 'server-only';

import type { TeamSettings } from './settings';
import { GameRuleError, type EnsembleVote, type GameMember, type VoteResult } from './types';

export function getEnsembleTrigger({ gameNo, memberCount, settings }: { gameNo: number; memberCount: number; settings: TeamSettings }): number | null {
  if (!settings.ensembleGames.includes(gameNo)) return null;
  if (!Number.isInteger(memberCount) || memberCount < 2) throw new GameRuleError('NOT_ENOUGH_COMPLETED_MEMBERS');
  const trigger = settings.ensembleTriggerOverride ?? Math.ceil(memberCount / 2);
  if (trigger < 1 || trigger > 20) throw new GameRuleError('INVALID_ENSEMBLE_TRIGGER');
  return trigger;
}

/** Call after *every* card publication, including the first generated card. */
export function afterCardPublished({ cardNo, triggerNo, ensembleDone, turnLeadId }: {
  cardNo: number; triggerNo: number | null; ensembleDone: boolean; turnLeadId: string;
}): { phase: 'TURN' | 'ENSEMBLE_SHARE'; sharerId: string | null } {
  const shouldStart = !ensembleDone && triggerNo === cardNo;
  return { phase: shouldStart ? 'ENSEMBLE_SHARE' : 'TURN', sharerId: shouldStart ? turnLeadId : null };
}

export function tallyEnsembleVotes(members: readonly Pick<GameMember, 'id' | 'rosterOrder'>[], votes: readonly EnsembleVote[]): VoteResult[] {
  const ids = new Set(members.map((member) => member.id));
  const voters = new Set<string>();
  for (const vote of votes) {
    if (!ids.has(vote.voterId) || !ids.has(vote.pickId) || voters.has(vote.voterId)) throw new GameRuleError('INVALID_ENSEMBLE_VOTE');
    voters.add(vote.voterId);
  }
  return [...members].sort((a, b) => a.rosterOrder - b.rosterOrder || a.id.localeCompare(b.id)).map((member) => ({
    participantId: member.id, votes: votes.filter((vote) => vote.pickId === member.id).length,
  }));
}

export function isVoteOpen({ nowMs, deadlineMs, paused, phase }: { nowMs: number; deadlineMs: number | null; paused: boolean; phase: string }): boolean {
  return phase === 'ENSEMBLE_VOTE' && !paused && deadlineMs !== null && nowMs < deadlineMs;
}

export function pauseVote(nowMs: number, deadlineMs: number): number { return Math.max(0, deadlineMs - nowMs); }
export function resumeVote(nowMs: number, remainingMs: number): number { return nowMs + Math.max(0, remainingMs); }
