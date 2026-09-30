import 'server-only';

import { getStudentCapacities, getTeamKeys, validateRosterConfig, type GlobalConfig } from './settings';
import { GameRuleError, type Rng, type RosterEntry, type TeamAssignment } from './types';

export interface InitialAssignmentsInput { config: GlobalConfig; roster: readonly RosterEntry[]; rng: Rng }

export function createInitialAssignments({ config: input, roster, rng }: InitialAssignmentsInput): TeamAssignment[] {
  const config = validateRosterConfig(input, roster);
  const keys = getTeamKeys(config.teamCount);
  const capacities = getStudentCapacities(config);
  const active = roster.filter((member) => member.active !== false);
  const operators = active.filter((member) => member.role === 'operator').sort((a, b) => a.rosterOrder - b.rosterOrder);
  const assignments: TeamAssignment[] = [];
  const assignedOperators = new Set<string>();
  for (const [name, teamKey] of Object.entries(config.operatorTeamByName)) {
    const operator = operators.find((member) => member.displayName === name)!;
    assignments.push({ participantId: operator.id, teamKey, role: 'operator', seatNo: 0 });
    assignedOperators.add(operator.id);
  }
  for (const key of keys) {
    if (!assignments.some((assignment) => assignment.teamKey === key)) {
      const operator = operators.find((member) => !assignedOperators.has(member.id));
      if (!operator) throw new GameRuleError('OPERATOR_COUNT_MISMATCH');
      assignments.push({ participantId: operator.id, teamKey: key, role: 'operator', seatNo: 0 });
      assignedOperators.add(operator.id);
    }
  }
  const students = rng.shuffle(active.filter((member) => member.role === 'student'));
  // Spread ready students as evenly as seats allow, so no-shows never pile into one team.
  // Everyone else keeps a seat for a late arrival. With everyone ready this equals a plain fill.
  const ready = students.filter((member) => member.ready !== false);
  const waiting = students.filter((member) => member.ready === false);
  const readyQuota = keys.map(() => 0);
  for (let given = 0; given < ready.length; given++) {
    let pick = -1;
    readyQuota.forEach((count, index) => { if (count < capacities[index] && (pick < 0 || count < readyQuota[pick])) pick = index; });
    if (pick < 0) throw new GameRuleError('STUDENT_COUNT_MISMATCH');
    readyQuota[pick]++;
  }
  let readyOffset = 0, waitingOffset = 0;
  keys.forEach((key, index) => {
    for (let seat = 1; seat <= capacities[index]; seat++) {
      const student = seat <= readyQuota[index] ? ready[readyOffset++] : waiting[waitingOffset++];
      assignments.push({ participantId: student.id, teamKey: key, role: 'student', seatNo: seat });
    }
  });
  return assignments;
}

export function swapAssignmentSeats(assignments: readonly TeamAssignment[], firstId: string, secondId: string): TeamAssignment[] {
  const first = assignments.find((assignment) => assignment.participantId === firstId);
  const second = assignments.find((assignment) => assignment.participantId === secondId);
  if (!first || !second || first.role !== 'student' || second.role !== 'student') throw new GameRuleError('INVALID_SEAT_SWAP');
  return assignments.map((assignment) => {
    if (assignment.participantId === firstId) return { ...assignment, teamKey: second.teamKey, seatNo: second.seatNo };
    if (assignment.participantId === secondId) return { ...assignment, teamKey: first.teamKey, seatNo: first.seatNo };
    return { ...assignment };
  });
}
