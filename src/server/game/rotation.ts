import 'server-only';

import { compareLexicographic } from './metrics';
import { GameRuleError, type Rng, type TeamAssignment } from './types';

export interface PairHistory { aId: string; bId: string; count: number }
export interface RotationGroup { memberIds: string[]; kind: 'stayed' | 'moved'; teamKey: string }
export interface RotationInput {
  assignments: readonly TeamAssignment[];
  moveCountPerTeam: number;
  nextBlockNo: number;
  pairHistory: readonly PairHistory[];
  previousGroups?: readonly RotationGroup[];
  operatorHistory?: Readonly<Record<string, readonly string[]>>;
  /** Explicit next-block roster/config changes. Omit to preserve current seats. */
  targetTeams?: readonly { teamKey: string; operatorId: string; studentCapacity: number }[];
  activeStudentIds?: readonly string[];
  samples?: number;
  rng: Rng;
}
export interface RotationResult {
  assignments: TeamAssignment[];
  groups: RotationGroup[];
  cost: { repeatedTriples: number; repeatedPairs: number; sameSourceIncomingTriples: number; sameOperatorThreeBlocks: number };
  search: { method: 'sampled'; validSamples: number; constraintsRelaxed: boolean; optimalityGuaranteed: false };
}

export const pairKey = (a: string, b: string): string => JSON.stringify(a < b ? [a, b] : [b, a]);
const chooseThree = (n: number) => n < 3 ? 0 : n * (n - 1) * (n - 2) / 6;

function tripleKeys(ids: readonly string[]): string[] {
  const sorted = [...ids].sort();
  const keys: string[] = [];
  for (let a = 0; a < sorted.length - 2; a++) for (let b = a + 1; b < sorted.length - 1; b++) for (let c = b + 1; c < sorted.length; c++) keys.push(JSON.stringify([sorted[a], sorted[b], sorted[c]]));
  return keys;
}

/** Maximum matching handles arbitrary team counts, uneven capacities and new members. */
function distributeMovers(movers: readonly { id: string; source: string | null }[], slots: readonly string[], rng: Rng): Map<string, string> | null {
  if (movers.length !== slots.length) return null;
  const shuffledSlots = rng.shuffle(slots);
  const occupant: (number | undefined)[] = Array(slots.length).fill(undefined);
  const shuffledMovers = rng.shuffle(movers);
  const assign = (index: number, visited: Set<number>): boolean => {
    for (let slot = 0; slot < shuffledSlots.length; slot++) {
      if (visited.has(slot) || shuffledSlots[slot] === shuffledMovers[index].source) continue;
      visited.add(slot);
      if (occupant[slot] === undefined || assign(occupant[slot]!, visited)) { occupant[slot] = index; return true; }
    }
    return false;
  };
  for (let index = 0; index < shuffledMovers.length; index++) if (!assign(index, new Set())) return null;
  return new Map(occupant.map((index, slot) => [shuffledMovers[index!].id, shuffledSlots[slot]]));
}

export function planRotation(input: RotationInput): RotationResult {
  const { assignments, rng, moveCountPerTeam } = input;
  if (!Number.isInteger(input.nextBlockNo) || input.nextBlockNo < 2 || input.nextBlockNo > 32767) throw new GameRuleError('INVALID_BLOCK');
  if (!Number.isInteger(moveCountPerTeam) || moveCountPerTeam < 0) throw new GameRuleError('INVALID_MOVE_COUNT');
  if (new Set(assignments.map((assignment) => assignment.participantId)).size !== assignments.length) throw new GameRuleError('DUPLICATE_PARTICIPANT');
  const currentStudents = assignments.filter((assignment) => assignment.role === 'student');
  const currentTeams = [...new Set(assignments.map((assignment) => assignment.teamKey))].sort();
  const targetTeams = input.targetTeams ? [...input.targetTeams] : currentTeams.map((teamKey) => {
    const operator = assignments.find((assignment) => assignment.teamKey === teamKey && assignment.role === 'operator');
    if (!operator) throw new GameRuleError('INVALID_OPERATOR_ASSIGNMENT');
    return { teamKey, operatorId: operator.participantId, studentCapacity: currentStudents.filter((assignment) => assignment.teamKey === teamKey).length };
  });
  if (targetTeams.length < 1 || new Set(targetTeams.map((team) => team.teamKey)).size !== targetTeams.length || new Set(targetTeams.map((team) => team.operatorId)).size !== targetTeams.length || targetTeams.some((team) => !Number.isInteger(team.studentCapacity) || team.studentCapacity < 1)) throw new GameRuleError('INVALID_TARGET_TEAMS');
  if (targetTeams.length === 1 && moveCountPerTeam !== 0) throw new GameRuleError('INVALID_MOVE_COUNT');
  const activeIds = input.activeStudentIds ? [...input.activeStudentIds] : currentStudents.map((assignment) => assignment.participantId);
  const active = new Set(activeIds);
  if (active.size !== activeIds.length || activeIds.length !== targetTeams.reduce((sum, team) => sum + team.studentCapacity, 0)) throw new GameRuleError('STUDENT_CAPACITY_MISMATCH');
  if (targetTeams.some((team) => active.has(team.operatorId))) throw new GameRuleError('INVALID_OPERATOR_ASSIGNMENT');
  const sourceById = new Map(currentStudents.map((assignment) => [assignment.participantId, assignment.teamKey]));
  const currentByTeam = new Map(currentTeams.map((key) => [key, currentStudents.filter((assignment) => assignment.teamKey === key && active.has(assignment.participantId))]));
  const structureChanged = activeIds.length !== currentStudents.length || activeIds.some((id) => !sourceById.has(id)) ||
    targetTeams.length !== currentTeams.length || targetTeams.some((team) => {
      const before = assignments.filter((assignment) => assignment.teamKey === team.teamKey);
      return before.filter((assignment) => assignment.role === 'student').length !== team.studentCapacity ||
        before.find((assignment) => assignment.role === 'operator')?.participantId !== team.operatorId;
    });
  const retainByTeam = new Map<string, number>();
  for (const [key, students] of currentByTeam) {
    const capacity = targetTeams.find((team) => team.teamKey === key)?.studentCapacity ?? 0;
    if (!structureChanged && moveCountPerTeam > students.length) throw new GameRuleError('INVALID_MOVE_COUNT');
    // A removed team keeps nobody. Changed rosters/capacities may require extra
    // moves, or have fewer people than the requested move count. Reserve incoming
    // seats as well, so a shrunken team does not become full before matching.
    retainByTeam.set(key, structureChanged ? Math.max(0, Math.min(students.length, capacity) - moveCountPerTeam) : students.length - moveCountPerTeam);
  }
  const pairs = new Map(input.pairHistory.map((pair) => [pairKey(pair.aId, pair.bId), pair.count]));
  const oldTriples = new Set((input.previousGroups ?? []).flatMap((group) => tripleKeys(group.memberIds)));
  const requestedSamples = input.samples ?? 30_000;
  if (!Number.isInteger(requestedSamples) || requestedSamples < 1) throw new GameRuleError('INVALID_SAMPLE_COUNT');
  // A single team has only one destination. Keep existing seat order and append
  // new members, instead of changing seats to match roster order between blocks.
  const seatOrder = targetTeams.length === 1 ? [
    ...currentStudents.filter((person) => active.has(person.participantId))
      .sort((a, b) => Number(b.teamKey === targetTeams[0].teamKey) - Number(a.teamKey === targetTeams[0].teamKey) || a.teamKey.localeCompare(b.teamKey) || a.seatNo - b.seatNo)
      .map((person) => person.participantId),
    ...activeIds.filter((id) => !sourceById.has(id)),
  ] : activeIds;
  const samples = targetTeams.length === 1 ? 1 : requestedSamples;
  let best: RotationResult | null = null;
  let bestScore: number[] = [];
  let equalBest = 0;
  let validSamples = 0;
  for (let sample = 0; sample < samples; sample++) {
    const destinations = new Map<string, string>();
    const movers: { id: string; source: string | null }[] = [];
    for (const [key, students] of currentByTeam) {
      const shuffled = rng.shuffle(students);
      const retain = retainByTeam.get(key)!;
      shuffled.slice(0, retain).forEach((student) => destinations.set(student.participantId, key));
      shuffled.slice(retain).forEach((student) => movers.push({ id: student.participantId, source: key }));
    }
    activeIds.filter((id) => !sourceById.has(id)).forEach((id) => movers.push({ id, source: null }));
    const slots = targetTeams.flatMap((team) => Array.from({ length: team.studentCapacity - [...destinations.values()].filter((key) => key === team.teamKey).length }, () => team.teamKey));
    const moved = distributeMovers(movers, slots, rng);
    if (!moved) continue;
    validSamples++;
    for (const [id, key] of moved) destinations.set(id, key);
    const next: TeamAssignment[] = [];
    const groups: RotationGroup[] = [];
    let repeatedPairs = 0;
    let repeatedTriples = 0;
    let sameSourceIncomingTriples = 0;
    let sameOperatorThreeBlocks = 0;
    for (const team of targetTeams) {
      const ids = seatOrder.filter((id) => destinations.get(id) === team.teamKey);
      next.push({ participantId: team.operatorId, teamKey: team.teamKey, role: 'operator', seatNo: 0 });
      ids.forEach((id, index) => next.push({ participantId: id, teamKey: team.teamKey, role: 'student', seatNo: index + 1 }));
      const stayed = ids.filter((id) => sourceById.get(id) === team.teamKey);
      const incoming = ids.filter((id) => sourceById.get(id) !== team.teamKey);
      groups.push({ kind: 'stayed', teamKey: team.teamKey, memberIds: stayed }, { kind: 'moved', teamKey: team.teamKey, memberIds: incoming });
      for (const group of [stayed, incoming]) repeatedTriples += tripleKeys(group).filter((key) => oldTriples.has(key)).length;
      for (const source of currentTeams) sameSourceIncomingTriples += chooseThree(incoming.filter((id) => sourceById.get(id) === source).length);
      for (let a = 0; a < ids.length - 1; a++) for (let b = a + 1; b < ids.length; b++) repeatedPairs += pairs.get(pairKey(ids[a], ids[b])) ?? 0;
      if (input.nextBlockNo >= 3) for (const id of ids) {
        const history = input.operatorHistory?.[id];
        if (history && history.length >= 2 && history.slice(-2).every((operatorId) => operatorId === team.operatorId)) sameOperatorThreeBlocks++;
      }
    }
    // E14: feasible triple restrictions before costs; pair repetition is the
    // primary objective among candidates satisfying the same restriction tier.
    const score = [repeatedTriples + sameSourceIncomingTriples, repeatedPairs, sameOperatorThreeBlocks];
    const comparison = best ? compareLexicographic(score, bestScore) : -1;
    if (comparison < 0) { bestScore = score; equalBest = 1; }
    else if (comparison === 0) equalBest++;
    if (comparison < 0 || (comparison === 0 && rng.int(1, equalBest) === 1)) {
      best = { assignments: next, groups, cost: { repeatedTriples, repeatedPairs, sameSourceIncomingTriples, sameOperatorThreeBlocks }, search: { method: 'sampled', validSamples: 0, constraintsRelaxed: score[0] > 0, optimalityGuaranteed: false } };
    }
  }
  if (!best) throw new GameRuleError('IMPOSSIBLE_ROTATION');
  best.search.validSamples = validSamples;
  return best;
}

/** Called exactly once per completed block by the transactional service. */
export function updatePairHistory(assignments: readonly TeamAssignment[], previous: readonly PairHistory[]): PairHistory[] {
  const history = new Map(previous.map((pair) => [pairKey(pair.aId, pair.bId), { ...pair }]));
  for (const teamKey of new Set(assignments.map((assignment) => assignment.teamKey))) {
    const ids = assignments.filter((assignment) => assignment.teamKey === teamKey).map((assignment) => assignment.participantId).sort();
    for (let a = 0; a < ids.length - 1; a++) for (let b = a + 1; b < ids.length; b++) {
      const key = pairKey(ids[a], ids[b]);
      const old = history.get(key);
      history.set(key, { aId: ids[a], bId: ids[b], count: (old?.count ?? 0) + 1 });
    }
  }
  return [...history.values()];
}
