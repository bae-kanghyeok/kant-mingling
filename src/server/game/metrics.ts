import 'server-only';

import { GameRuleError, type DataCard, type GameMember, type Option } from './types';

export function getAnswer(member: GameMember, questionId: string): Option {
  const answer = member.answers[questionId];
  if (answer !== 'A' && answer !== 'B') throw new GameRuleError('INCOMPLETE_GAME_PROFILE');
  return answer;
}

export function getOwner(members: readonly GameMember[], ownerId: string): GameMember {
  const owner = members.find((member) => member.id === ownerId);
  if (!owner) throw new GameRuleError('OWNER_NOT_IN_GAME');
  return owner;
}

export function assertPlayableMembers(members: readonly GameMember[]): void {
  if (members.length < 2 || members.filter((member) => member.profileComplete).length < 2) throw new GameRuleError('NOT_ENOUGH_COMPLETED_MEMBERS');
  if (new Set(members.map((member) => member.id)).size !== members.length) throw new GameRuleError('DUPLICATE_GAME_MEMBER');
  for (const member of members) {
    if (!member.profileComplete || Object.keys(member.answers).length !== 20 || Object.values(member.answers).some((value) => value !== 'A' && value !== 'B')) {
      throw new GameRuleError('INCOMPLETE_GAME_PROFILE');
    }
  }
  const questions = Object.keys(members[0].answers);
  for (const member of members) for (const question of questions) getAnswer(member, question);
}

export function sameCount(members: readonly GameMember[], ownerId: string, questionId: string): number {
  const answer = getAnswer(getOwner(members, ownerId), questionId);
  return members.filter((member) => getAnswer(member, questionId) === answer).length;
}

export function candidateIds(members: readonly GameMember[], realCards: readonly DataCard[]): string[] {
  if (realCards.some((card) => card.isNoise)) throw new GameRuleError('EXPECTED_REAL_CARDS');
  return members.filter((member) => realCards.every((card) => getAnswer(member, card.questionId) === card.displayedOption)).map((member) => member.id);
}

export function candidateCount(members: readonly GameMember[], realCards: readonly DataCard[]): number {
  return candidateIds(members, realCards).length;
}

export function possibleSet(members: readonly GameMember[], cards: readonly DataCard[], noiseCount: number, groundTruthCardNos: readonly number[] = []): string[] {
  const verified = new Set(groundTruthCardNos);
  return members.filter((member) =>
    cards.filter((card) => getAnswer(member, card.questionId) !== card.displayedOption).length === noiseCount &&
    cards.every((card) => !verified.has(card.cardNo) || getAnswer(member, card.questionId) === card.displayedOption),
  ).map((member) => member.id);
}

export function opposite(option: Option): Option { return option === 'A' ? 'B' : 'A'; }

export function compareLexicographic(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
