import 'server-only';

import type { TeamSettings } from './settings';
import { GameRuleError, type DataCard, type GamePhase } from './types';

export interface EvaluateGuessInput {
  gameNo: number;
  settings: TeamSettings;
  phase: GamePhase;
  paused: boolean;
  guessLocked: boolean;
  cards: readonly DataCard[];
  memberIds: readonly string[];
  ownerId: string;
  ownerPick: string;
  noisePicks: readonly number[];
  groundTruthCardNos?: readonly number[];
  noiseIntroSeen: boolean;
}

export function evaluateGuess(input: EvaluateGuessInput): { correct: boolean; guessLocked: boolean; exhausted: boolean } {
  const exhausted = input.cards.length === 20;
  if (input.paused) throw new GameRuleError('PAUSED');
  if (input.phase !== 'TURN') throw new GameRuleError('WRONG_PHASE');
  if (input.guessLocked && !exhausted) throw new GameRuleError('GUESS_LOCKED');
  if (input.cards.length < (input.gameNo === 1 ? input.settings.guessEnableAfter.game1 : input.settings.guessEnableAfter.others)) throw new GameRuleError('NOT_ENOUGH_DATA');
  const noises = input.cards.filter((card) => card.isNoise).map((card) => card.cardNo);
  const cardNos = new Set(input.cards.map((card) => card.cardNo));
  if (!input.memberIds.includes(input.ownerPick) || new Set(input.noisePicks).size !== input.noisePicks.length || input.noisePicks.length !== noises.length || input.noisePicks.some((number) => !cardNos.has(number) || input.groundTruthCardNos?.includes(number))) {
    throw new GameRuleError('INVALID_GUESS');
  }
  if (noises.length && !input.noiseIntroSeen) throw new GameRuleError('INTRO_REQUIRED');
  const correct = input.ownerPick === input.ownerId && noises.every((number) => input.noisePicks.includes(number));
  return { correct, guessLocked: !correct && !exhausted, exhausted };
}
