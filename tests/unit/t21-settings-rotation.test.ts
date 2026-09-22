import { describe, expect, it } from 'vitest';
import { applyPreset, DEFAULT_GLOBAL_CONFIG, DEFAULT_TEAM_SETTINGS, getTeamKeys, parseGlobalConfig, parseTeamSettings, validateRosterConfig } from '../../src/server/game/settings';
import { createInitialAssignments } from '../../src/server/game/teams';
import { planRotation, updatePairHistory } from '../../src/server/game/rotation';
import { makeRng } from '../../src/server/game/rng';
import type { RosterEntry } from '../../src/server/game/types';

function roster(students: number, operators: number): RosterEntry[] {
  return Array.from({ length: students + operators }, (_, index) => ({ id: `p${index}`, displayName: `합성 ${index}`, role: index < students ? 'student' : 'operator', rosterOrder: index }));
}

describe('T22 validated settings', () => {
  it('honors F16 max one GT and rejects a GT-without-Ensemble combination', () => {
    expect(() => parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, groundTruthPerGame: 2 })).toThrow();
    expect(() => parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, ensembleGames: [] })).toThrow();
    expect(parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, ensembleGames: [], groundTruthPerGame: 0 }).groundTruthPerGame).toBe(0);
    expect(() => parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, noiseGames: [1, 2] })).toThrow();
    expect(() => parseTeamSettings({ ...DEFAULT_TEAM_SETTINGS, noiseFirstRange: [3, 2] })).toThrow();
    expect(applyPreset(DEFAULT_TEAM_SETTINGS, 'easy').noiseAutoAdd).toBe(false);
    expect(applyPreset(DEFAULT_TEAM_SETTINGS, 'hard').gtRealCardsAfterEnsemble).toBe(1);
  });
  it('validates actual roster counts, host replacement and feasible move counts', () => {
    const config = { ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: {} };
    expect(validateRosterConfig(config, roster(18, 3))).toEqual(config);
    expect(() => validateRosterConfig(config, roster(17, 3))).toThrow('STUDENT_COUNT_MISMATCH');
    expect(() => validateRosterConfig(config, roster(18, 2))).toThrow('OPERATOR_COUNT_MISMATCH');
    expect(() => validateRosterConfig(config, roster(18, 3), 'removed')).toThrow('HOST_REPLACEMENT_REQUIRED');
    expect(validateRosterConfig(config, roster(18, 3), 'removed', 'p18')).toEqual(config);
    expect(() => parseGlobalConfig({ ...config, moveCountPerTeam: 7 })).toThrow();
    expect(getTeamKeys(26).at(-1)).toBe('Z');
    expect(() => getTeamKeys(27)).toThrow('INVALID_TEAM_COUNT');
    expect(() => parseGlobalConfig({ ...config, studentCount: 27, teamCount: 27 })).toThrow();
  });
});

describe('T21 weighted rotation without fixed 18/3/3 assumptions', () => {
  it.each([[18, 3, 3], [11, 4, 2], [7, 2, 1], [12, 3, 0]])('keeps seats, operators and exact moves for %i students/%i teams/%i moves', (students, teams, moves) => {
    const config = parseGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, studentCount: students, teamCount: teams, moveCountPerTeam: moves, operatorTeamByName: {} });
    const assignments = createInitialAssignments({ config, roster: roster(students, teams), rng: makeRng('initial', `${students}`) });
    const history = updatePairHistory(assignments, []);
    const next = planRotation({ assignments, moveCountPerTeam: moves, nextBlockNo: 2, pairHistory: history, samples: 100, rng: makeRng('rotation', `${students}`) });
    expect(new Set(next.assignments.map((a) => a.participantId)).size).toBe(students + teams);
    for (const key of getTeamKeys(teams)) {
      const before = assignments.filter((a) => a.teamKey === key && a.role === 'student');
      const after = next.assignments.filter((a) => a.teamKey === key && a.role === 'student');
      expect(after).toHaveLength(before.length);
      expect(before.filter((a) => after.some((b) => b.participantId === a.participantId))).toHaveLength(before.length - moves);
      expect(next.assignments.find((a) => a.teamKey === key && a.role === 'operator')).toEqual(assignments.find((a) => a.teamKey === key && a.role === 'operator'));
    }
    expect(next.search.optimalityGuaranteed).toBe(false);
    expect(next.search.validSamples).toBe(100);
  });
  it('prefers feasible triple restrictions before lexicographic pair costs and preserves history', () => {
    const config = { ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: {} };
    const initial = createInitialAssignments({ config, roster: roster(18, 3), rng: makeRng('init', 'triple') });
    const pairs = updatePairHistory(initial, []);
    const next = planRotation({ assignments: initial, moveCountPerTeam: 3, nextBlockNo: 2, pairHistory: pairs, samples: 1000, rng: makeRng('rotation', 'triple') });
    expect(next.cost.sameSourceIncomingTriples).toBe(0);
    const third = planRotation({ assignments: next.assignments, moveCountPerTeam: 3, nextBlockNo: 3, pairHistory: updatePairHistory(next.assignments, pairs), previousGroups: next.groups, samples: 1000, rng: makeRng('rotation', 'third') });
    expect(third.cost.repeatedTriples).toBe(0);
    expect(third.search.constraintsRelaxed).toBe(false);
    expect(pairs.every((p) => p.count === 1)).toBe(true);
  });
  it('supports explicit next-block roster/capacity changes and rejects impossible distribution', () => {
    const config = { ...DEFAULT_GLOBAL_CONFIG, studentCount: 4, teamCount: 2, moveCountPerTeam: 1, operatorTeamByName: {} };
    const initial = createInitialAssignments({ config, roster: roster(4, 2), rng: makeRng('initial', 'change') });
    const targets = [{ teamKey: 'A', operatorId: 'p4', studentCapacity: 3 }, { teamKey: 'B', operatorId: 'p5', studentCapacity: 2 }];
    const next = planRotation({ assignments: initial, activeStudentIds: ['p0', 'p1', 'p2', 'p3', 'new'], targetTeams: targets, moveCountPerTeam: 1, nextBlockNo: 2, pairHistory: [], samples: 10, rng: makeRng('rot', 'new') });
    expect(next.assignments.filter((a) => a.teamKey === 'A' && a.role === 'student')).toHaveLength(3);
    expect(next.assignments.some((a) => a.participantId === 'new')).toBe(true);
    const changed = [{ teamKey: 'A', operatorId: 'p4', studentCapacity: 1 }, { teamKey: 'B', operatorId: 'p5', studentCapacity: 3 }];
    const resized = planRotation({ assignments: initial, targetTeams: changed, moveCountPerTeam: 1, nextBlockNo: 2, pairHistory: [], samples: 2, rng: makeRng('resize', 'rot') });
    expect(resized.assignments.filter((person) => person.teamKey === 'A' && person.role === 'student')).toHaveLength(1);
    expect(() => planRotation({ assignments: initial, targetTeams: changed, moveCountPerTeam: 4, nextBlockNo: 2, pairHistory: [], samples: 2, rng: makeRng('bad', 'rot') })).toThrow('IMPOSSIBLE_ROTATION');
  });
  it('moves every member of a removed team when changing three teams to two and eighteen students to seventeen', () => {
    const config = { ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: {} };
    const initial = createInitialAssignments({ config, roster: roster(18, 3), rng: makeRng('init', 'reduce') });
    const removedStudent = initial.find((person) => person.teamKey === 'A' && person.role === 'student')!.participantId;
    const activeStudentIds = initial.filter((person) => person.role === 'student' && person.participantId !== removedStudent).map((person) => person.participantId);
    const operator = (key: string) => initial.find((person) => person.teamKey === key && person.role === 'operator')!.participantId;
    const targetTeams = [{ teamKey: 'A', operatorId: operator('A'), studentCapacity: 9 }, { teamKey: 'B', operatorId: operator('B'), studentCapacity: 8 }];
    for (const moveCountPerTeam of [0, 3, 6]) {
      const next = planRotation({ assignments: initial, activeStudentIds, targetTeams, moveCountPerTeam, nextBlockNo: 2,
        pairHistory: updatePairHistory(initial, []), samples: 50, rng: makeRng('reduce', `${moveCountPerTeam}`) });
      expect(next.assignments).toHaveLength(19);
      expect(next.assignments.some((person) => person.participantId === removedStudent || person.participantId === operator('C') || person.teamKey === 'C')).toBe(false);
      expect(next.assignments.filter((person) => person.teamKey === 'A' && person.role === 'student')).toHaveLength(9);
      expect(next.assignments.filter((person) => person.teamKey === 'B' && person.role === 'student')).toHaveLength(8);
      expect(new Set(next.assignments.map((person) => person.participantId)).size).toBe(19);
    }
  });
  it('replaces an operator without changing normal student movement', () => {
    const initial = createInitialAssignments({ config: { ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: {} }, roster: roster(18, 3), rng: makeRng('init', 'operator') });
    const targetTeams = ['A', 'B', 'C'].map((teamKey) => ({ teamKey, studentCapacity: 6,
      operatorId: teamKey === 'B' ? 'new-operator' : initial.find((person) => person.teamKey === teamKey && person.role === 'operator')!.participantId }));
    const next = planRotation({ assignments: initial, targetTeams, moveCountPerTeam: 3, nextBlockNo: 2, pairHistory: [], samples: 50, rng: makeRng('replace', 'operator') });
    expect(next.assignments.find((person) => person.teamKey === 'B' && person.role === 'operator')?.participantId).toBe('new-operator');
    for (const team of targetTeams) {
      const previous = new Set(initial.filter((person) => person.teamKey === team.teamKey && person.role === 'student').map((person) => person.participantId));
      expect(next.assignments.filter((person) => person.teamKey === team.teamKey && person.role === 'student' && previous.has(person.participantId))).toHaveLength(3);
    }
  });
  it('fills a newly added fourth team and shifts excess seats even when requested moves are zero', () => {
    const initial = createInitialAssignments({ config: { ...DEFAULT_GLOBAL_CONFIG, operatorTeamByName: {} }, roster: roster(18, 3), rng: makeRng('init', 'increase') });
    const targetTeams = ['A', 'B', 'C', 'D'].map((teamKey, index) => ({ teamKey, studentCapacity: [5, 5, 4, 4][index],
      operatorId: teamKey === 'D' ? 'fourth-operator' : initial.find((person) => person.teamKey === teamKey && person.role === 'operator')!.participantId }));
    for (const moveCountPerTeam of [0, 3]) {
      const next = planRotation({ assignments: initial, targetTeams, moveCountPerTeam, nextBlockNo: 2, pairHistory: [], samples: 50, rng: makeRng('increase', `${moveCountPerTeam}`) });
      expect(next.assignments).toHaveLength(22);
      for (const team of targetTeams) expect(next.assignments.filter((person) => person.teamKey === team.teamKey && person.role === 'student')).toHaveLength(team.studentCapacity);
      expect(new Set(next.assignments.map((person) => person.participantId)).size).toBe(22);
    }
  });
});
