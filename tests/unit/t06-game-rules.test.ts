import { describe, expect, it } from 'vitest';
import { selectOwner } from '../../src/server/game/owner';
import { selectRealCard } from '../../src/server/game/card-select';
import { selectNoiseCard } from '../../src/server/game/noise-select';
import { createNoisePlan, minimumNoiseCount } from '../../src/server/game/noise-plan';
import { candidateCount, possibleSet, sameCount } from '../../src/server/game/metrics';
import { makeRng } from '../../src/server/game/rng';
import { DEFAULT_TEAM_SETTINGS, parseTeamSettings } from '../../src/server/game/settings';
import { evaluateGuess } from '../../src/server/game/guess';
import type { DataCard, GameMember } from '../../src/server/game/types';

function members(count = 7, identical = false): GameMember[] {
  return Array.from({ length: count }, (_, person) => ({
    id: `p${person}`, role: person === 0 ? 'operator' : 'student', rosterOrder: person,
    profileComplete: true, ownerCount: 0,
    answers: Object.fromEntries(Array.from({ length: 20 }, (_, q) => [`Q${String(q + 1).padStart(2, '0')}`, identical || ((person + q) % count < Math.ceil(count / 2)) ? 'A' : 'B'])),
  }));
}

describe('T06/T07 Owner and truthful card selection', () => {
  it('requires two complete profiles even if the caller requests a forced start', () => {
    expect(() => selectOwner({ members: members(1), previousOwnerIdsInBlock: [], rng: makeRng('x', 'owner') })).toThrow('NOT_ENOUGH_COMPLETED_MEMBERS');
    expect(() => selectOwner({ members: members(2).map((m, i) => ({ ...m, profileComplete: i === 0 })), previousOwnerIdsInBlock: [], rng: makeRng('x', 'owner') })).toThrow();
  });
  it('avoids previous Owners and prefers lower event Owner counts', () => {
    const people = members().map((m, i) => ({ ...m, ownerCount: i === 3 ? 0 : 2 }));
    expect(selectOwner({ members: people, previousOwnerIdsInBlock: [], rng: makeRng('x', 'owner') }).ownerId).toBe('p3');
    expect(selectOwner({ members: people, previousOwnerIdsInBlock: ['p3'], rng: makeRng('x', 'owner') }).ownerId).not.toBe('p3');
  });
  it('keeps all-identical data playable for 20 distinct truthful cards', () => {
    const people = members(7, true);
    const owner = selectOwner({ members: people, previousOwnerIdsInBlock: [], rng: makeRng('same', 'owner') });
    expect(owner.fallback).toBe(true);
    const cards: DataCard[] = [];
    for (let n = 1; n <= 20; n++) {
      const result = selectRealCard({ members: people, ownerId: owner.ownerId, cards, rareFromRealOrdinal: 7, rng: makeRng('same', `card:${n}`) });
      expect(result.kind).toBe('selected');
      if (result.kind !== 'selected') throw new Error('early exhaustion');
      expect(result.fallback).toBe('COMMON_CARD_FALLBACK');
      expect(result.card.displayedOption).toBe('A');
      cards.push(result.card);
    }
    expect(new Set(cards.map((c) => c.questionId)).size).toBe(20);
    expect(selectRealCard({ members: people, ownerId: owner.ownerId, cards, rareFromRealOrdinal: 7, rng: makeRng('same', 'end') })).toEqual({ kind: 'exhausted' });
  });
  it('uses the broadest non-unanimous fallback when no normal first clue exists', () => {
    const people = members(10).map((member, index) => ({ ...member, ownerCount: index < 8 ? 2 : 0,
      answers: Object.fromEntries(Object.keys(member.answers).map((question) => [question, index < 8 ? 'A' : 'B'])) })) as GameMember[];
    const owner = selectOwner({ members: people, previousOwnerIdsInBlock: [], rng: makeRng('fallback', 'owner') });
    expect(owner.fallback).toBe(true);
    expect(sameCount(people, owner.ownerId, 'Q01')).toBe(8);
  });
  it('uses common unused answers before relaxing rare answers, including two-person teams', () => {
    const people = members(2).map((m, i) => ({ ...m, answers: Object.fromEntries(Object.keys(m.answers).map((q, j) => [q, j === 0 || i === 0 ? 'A' : 'B'])) })) as GameMember[];
    const first = selectRealCard({ members: people, ownerId: 'p0', cards: [], rareFromRealOrdinal: 7, rng: makeRng('rare', '1') });
    expect(first.kind).toBe('selected');
    if (first.kind !== 'selected') throw new Error('missing card');
    expect(first.card.questionId).toBe('Q01');
    expect(first.fallback).toBe('COMMON_CARD_FALLBACK');
    const second = selectRealCard({ members: people, ownerId: 'p0', cards: [first.card], rareFromRealOrdinal: 7, rng: makeRng('rare', '2') });
    expect(second.kind === 'selected' && second.fallback).toBe('RARE_CARD_FALLBACK');
  });
  it('uses broad normal opening cards when available', () => {
    const people = members();
    const cards: DataCard[] = [];
    for (let n = 1; n <= 6; n++) {
      const selection = selectRealCard({ members: people, ownerId: 'p0', cards, rareFromRealOrdinal: 7, rng: makeRng('broad', `card:${n}`) });
      if (selection.kind !== 'selected') throw new Error('early exhaustion');
      expect(selection.fallback).toBeNull();
      expect(sameCount(people, 'p0', selection.card.questionId)).toBeGreaterThanOrEqual(3);
      cards.push(selection.card);
    }
    expect(candidateCount(people, cards)).toBeGreaterThanOrEqual(1);
  });
});

describe('T08/T09/T16 deterministic Noise and possible candidates', () => {
  it('satisfies approved minima at every count across caps, modes and seeds', () => {
    const firstPositions = new Set<number>();
    for (let seed = 0; seed < 100; seed++) for (let cap = 0; cap <= 5; cap++) for (const auto of [false, true]) {
      const settings = parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, noiseCap: cap, noiseAutoAdd: auto });
      const slots = createNoisePlan({ gameNo: 2, settings, rng: makeRng(String(seed), 'noise') });
      expect(slots).toEqual(createNoisePlan({ gameNo: 2, settings, rng: makeRng(String(seed), 'noise') }));
      expect(slots).not.toContain(1);
      expect(new Set(slots).size).toBe(slots.length);
      if (cap > 0) {
        firstPositions.add(slots[0]);
        expect(slots[0]).toBeGreaterThanOrEqual(2);
        expect(slots[0]).toBeLessThanOrEqual(3);
        expect(slots.filter((slot) => slot <= 3)).toHaveLength(1);
      }
      expect(slots).toHaveLength(cap === 0 ? 0 : auto ? cap : 1);
      for (let n = 1; n <= 20; n++) expect(slots.filter((slot) => slot <= n).length).toBeGreaterThanOrEqual(minimumNoiseCount(n, 2, settings));
    }
    expect(firstPositions).toEqual(new Set([2, 3]));
    expect(createNoisePlan({ gameNo: 1, settings: DEFAULT_TEAM_SETTINGS, rng: makeRng('1', 'noise') })).toEqual([]);
  });
  it('keeps Owner possible through mixed truthful/noise cards and verified real cards', () => {
    const people = members();
    for (let seed = 0; seed < 12; seed++) {
      const slots = createNoisePlan({ gameNo: 4, settings: DEFAULT_TEAM_SETTINGS, rng: makeRng(String(seed), 'noise') });
      const cards: DataCard[] = [];
      for (let n = 1; n <= 20; n++) {
        const common = { members: people, ownerId: 'p0', cards, rng: makeRng(String(seed), `card:${n}`) };
        const selected = slots.includes(n) ? selectNoiseCard(common) : selectRealCard({ ...common, rareFromRealOrdinal: 7 });
        if (selected.kind !== 'selected') throw new Error('early exhaustion');
        cards.push(selected.card);
        expect(selected.card.isNoise).toBe(slots.includes(n));
        expect(selected.card.isNoise).toBe(selected.card.trueOption !== selected.card.displayedOption);
        expect(possibleSet(people, cards, cards.filter((c) => c.isNoise).length, [1])).toContain('p0');
      }
      expect(new Set(cards.map((c) => c.questionId)).size).toBe(20);
    }
  });
});

describe('T13/T14 guess contract', () => {
  const card = (n: number, noise = false): DataCard => ({ cardNo: n, questionId: `Q${n}`, displayedOption: noise ? 'B' : 'A', trueOption: 'A', isNoise: noise });
  const base = { gameNo: 2, settings: DEFAULT_TEAM_SETTINGS, phase: 'TURN' as const, paused: false, guessLocked: false, memberIds: ['p0', 'p1'], ownerId: 'p0', ownerPick: 'p0', cards: [card(1), card(2, true), card(3)], noisePicks: [2], noiseIntroSeen: true };
  it('accepts only the correct Owner and full exact Noise set', () => {
    expect(evaluateGuess(base)).toEqual({ correct: true, guessLocked: false, exhausted: false });
    expect(evaluateGuess({ ...base, ownerPick: 'p1' })).toEqual({ correct: false, guessLocked: true, exhausted: false });
    expect(evaluateGuess({ ...base, noisePicks: [3] }).correct).toBe(false);
    expect(() => evaluateGuess({ ...base, noisePicks: [2, 2] })).toThrow('INVALID_GUESS');
    expect(() => evaluateGuess({ ...base, groundTruthCardNos: [2] })).toThrow('INVALID_GUESS');
  });
  it('applies first-game exception and unlocks repeated guesses only after 20 cards', () => {
    expect(evaluateGuess({ ...base, gameNo: 1, cards: [card(1)], noisePicks: [] }).correct).toBe(true);
    expect(() => evaluateGuess({ ...base, cards: [card(1)], noisePicks: [] })).toThrow('NOT_ENOUGH_DATA');
    expect(() => evaluateGuess({ ...base, guessLocked: true })).toThrow('GUESS_LOCKED');
    expect(() => evaluateGuess({ ...base, noiseIntroSeen: false })).toThrow('INTRO_REQUIRED');
    expect(() => evaluateGuess({ ...base, phase: 'ENSEMBLE_VOTE' })).toThrow('WRONG_PHASE');
    expect(evaluateGuess({ ...base, cards: Array.from({ length: 20 }, (_, index) => card(index + 1)), noisePicks: [], ownerPick: 'p1', guessLocked: true })).toEqual({ correct: false, guessLocked: false, exhausted: true });
  });
});
