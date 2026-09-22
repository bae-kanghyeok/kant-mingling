import { describe, expect, it } from 'vitest';
import { afterCardPublished, getEnsembleTrigger, isVoteOpen, pauseVote, resumeVote, tallyEnsembleVotes } from '../../src/server/game/ensemble';
import { advanceGroundTruth, selectGroundTruth } from '../../src/server/game/ground-truth';
import { selectReceiver } from '../../src/server/game/receiver';
import { selectBehindData } from '../../src/server/game/behind';
import { getReferenceTimers } from '../../src/server/game/timers';
import { DEFAULT_TEAM_SETTINGS } from '../../src/server/game/settings';
import { makeRng } from '../../src/server/game/rng';
import type { DataCard, GameMember } from '../../src/server/game/types';

const people: GameMember[] = Array.from({ length: 7 }, (_, index) => ({
  id: `p${index}`, role: index === 0 ? 'operator' : 'student', rosterOrder: index, profileComplete: true, lastSeenAtMs: 9000,
  answers: { rare: index === 0 ? 'A' : 'B', broad: index < 3 ? 'A' : 'B', other: index < 4 ? 'A' : 'B' },
}));
const card = (cardNo: number, questionId: string): DataCard => ({ cardNo, questionId, displayedOption: 'A', trueOption: 'A', isNoise: false });

describe('T11 receiver and T17 Ensemble', () => {
  it('uses the lead as shared-card spokesperson and fires on first-card publication', () => {
    expect(getEnsembleTrigger({ gameNo: 1, memberCount: 7, settings: DEFAULT_TEAM_SETTINGS })).toBe(4);
    const triggerNo = getEnsembleTrigger({ gameNo: 1, memberCount: 2, settings: DEFAULT_TEAM_SETTINGS });
    expect(triggerNo).toBe(1);
    expect(afterCardPublished({ cardNo: 1, triggerNo, ensembleDone: false, turnLeadId: 'p0' })).toEqual({ phase: 'ENSEMBLE_SHARE', sharerId: 'p0' });
    expect(afterCardPublished({ cardNo: 1, triggerNo, ensembleDone: true, turnLeadId: 'p0' }).phase).toBe('TURN');
    const off = selectReceiver({ members: people, deliveries: [], previousInitialRecipientId: null, previousTurnLeadId: 'p0', dataSplit: false, nowMs: 10000, presenceWindowSeconds: 15, rng: makeRng('split', 'receiver') });
    expect(off.recipientIds).toHaveLength(7);
    expect(off.turnLeadId).toBe('p1');
    expect(afterCardPublished({ cardNo: 4, triggerNo: 4, ensembleDone: false, turnLeadId: off.turnLeadId }).sharerId).toBe('p1');
  });
  it('prioritizes online least-served recipients including resends and avoids consecutive initial recipients', () => {
    const result = selectReceiver({ members: people, deliveries: people.slice(0, 6).map((m, i) => ({ participantId: m.id, cardNo: i + 1, reason: 'resend' as const })), previousInitialRecipientId: 'p5', previousTurnLeadId: 'p5', dataSplit: true, nowMs: 10000, presenceWindowSeconds: 15, rng: makeRng('least', 'receiver') });
    expect(result.turnLeadId).toBe('p6');
    const mostlyOffline = people.map((m, i) => ({ ...m, lastSeenAtMs: i === 0 ? 9000 : -100000 }));
    const next = selectReceiver({ members: mostlyOffline, deliveries: [], previousInitialRecipientId: 'p0', previousTurnLeadId: 'p0', dataSplit: true, nowMs: 10000, presenceWindowSeconds: 15, rng: makeRng('offline', 'receiver') });
    expect(next.turnLeadId).not.toBe('p0');
  });
  it('excludes nonvotes, includes zero totals, and closes exactly at the deadline', () => {
    expect(tallyEnsembleVotes(people, [{ voterId: 'p0', pickId: 'p0' }, { voterId: 'p1', pickId: 'p0' }])).toEqual(people.map((p) => ({ participantId: p.id, votes: p.id === 'p0' ? 2 : 0 })));
    expect(() => tallyEnsembleVotes(people, [{ voterId: 'stranger', pickId: 'p0' }])).toThrow();
    expect(isVoteOpen({ nowMs: 30000, deadlineMs: 30000, paused: false, phase: 'ENSEMBLE_VOTE' })).toBe(false);
    expect(resumeVote(90000, pauseVote(20000, 30000))).toBe(100000);
  });
});

describe('T18 Ground Truth E06 and Behind the Data', () => {
  const base = { members: people, ownerId: 'p0', cards: [card(1, 'rare')], attempts: [], results: [], rng: makeRng('gt', 'select') };
  it('retries pending-at-zero after each real card and announces only once', () => {
    const pending = advanceGroundTruth({ ...base, gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: { status: 'none', needed: 0, cardNo: null }, event: 'ensemble-finished' });
    expect(pending).toEqual({ status: 'pending', needed: 0, cardNo: null });
    const stillPending = advanceGroundTruth({ ...base, gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: pending, event: 'real-card' });
    expect(stillPending.needed).toBe(0);
    const announced = advanceGroundTruth({ ...base, cards: [...base.cards, card(2, 'broad')], gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: stillPending, event: 'real-card' });
    expect(announced).toEqual({ status: 'announced', needed: 0, cardNo: 2 });
    expect(advanceGroundTruth({ ...base, gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: announced, event: 'real-card' })).toEqual(announced);
  });
  it('honors count zero and hard-mode wait without activating before Ensemble', () => {
    const none = { status: 'none' as const, needed: 0, cardNo: null };
    expect(advanceGroundTruth({ ...base, gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: none, event: 'real-card' })).toEqual(none);
    expect(advanceGroundTruth({ ...base, gameNo: 4, settings: { ...DEFAULT_TEAM_SETTINGS, groundTruthPerGame: 0 }, state: none, event: 'ensemble-finished' })).toEqual(none);
    const hard = advanceGroundTruth({ ...base, gameNo: 4, settings: { ...DEFAULT_TEAM_SETTINGS, gtRealCardsAfterEnsemble: 1 }, state: none, event: 'ensemble-finished' });
    expect(hard).toEqual({ status: 'pending', needed: 1, cardNo: null });
    expect(advanceGroundTruth({ ...base, gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, state: hard, event: 'game-ended' }).status).toBe('skipped');
  });
  it('prioritizes falsely accused real cards and ignores noisy or identifying cards', () => {
    const cards = [card(1, 'rare'), card(2, 'broad'), card(3, 'other')];
    expect(selectGroundTruth({ ...base, cards, attempts: [{ ownerPick: 'p1', noisePicks: [1, 3], correct: false }] })?.cardNo).toBe(3);
    expect(selectGroundTruth({ ...base, cards, results: [{ participantId: 'p3', votes: 2 }] })?.cardNo).toBe(2);
    expect(selectBehindData({ members: people, ownerId: 'p0', cards, groundTruthCardNo: 3, rng: makeRng('behind', 'pick') })?.cardNo).toBe(3);
  });
});

it('T23 reference timers freeze a paused/revealed GAME but never change state', () => {
  expect(getReferenceTimers({ nowMs: 100000, gameStartedAtMs: 1000, revealedAtMs: 50000, pausedMsTotal: 2000, pausedAtMs: 40000, blockStartedAtMs: 0, blockTargetMinutes: 12 })).toEqual({ gameElapsedMs: 37000, blockElapsedMs: 100000, blockTargetMs: 720000 });
});
