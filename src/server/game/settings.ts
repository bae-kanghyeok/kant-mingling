import 'server-only';

import { z } from 'zod';
import { GameRuleError, type RosterEntry } from './types';

const gameNumbers = z.array(z.number().int().min(1).max(9)).refine(
  (values) => new Set(values).size === values.length,
  'GAME 번호는 중복될 수 없습니다.',
);

export const globalConfigSchema = z.object({
  studentCount: z.number().int().min(2),
  teamCount: z.number().int().min(2).max(26),
  moveCountPerTeam: z.number().int().min(0),
  operatorTeamByName: z.record(z.string().min(1), z.string().min(1)),
  blockTargetMinutes: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  sessionTtlHours: z.number().positive(),
  presenceWindowSeconds: z.number().positive(),
  pollInGameMs: z.number().int().positive(),
  pollIdleMs: z.number().int().positive(),
  voteSeconds: z.literal(30),
}).strict().superRefine((value, ctx) => {
  if (value.studentCount < value.teamCount) {
    ctx.addIssue({ code: 'custom', path: ['studentCount'], message: '각 조에 학생 자리가 하나 이상 필요합니다.' });
  }
  if (value.moveCountPerTeam > Math.floor(value.studentCount / value.teamCount)) {
    ctx.addIssue({ code: 'custom', path: ['moveCountPerTeam'], message: '이동 인원은 가장 작은 조의 학생 정원을 넘을 수 없습니다.' });
  }
  if (new Set(Object.values(value.operatorTeamByName)).size !== Object.keys(value.operatorTeamByName).length) {
    ctx.addIssue({ code: 'custom', path: ['operatorTeamByName'], message: '한 조에 운영진은 한 명만 배치합니다.' });
  }
});

export const teamSettingsSchema = z.object({
  preset: z.enum(['easy', 'normal', 'hard', 'custom']),
  dataSplitGames: gameNumbers,
  noiseGames: gameNumbers.refine((games) => !games.includes(1), 'GAME 1은 Noise를 사용하지 않습니다.'),
  noiseFirstRange: z.tuple([z.number().int().min(2).max(3), z.number().int().min(2).max(3)]),
  noiseAutoAdd: z.boolean(),
  noiseCap: z.number().int().min(0).max(5),
  groundTruthGames: gameNumbers,
  groundTruthPerGame: z.union([z.literal(0), z.literal(1)]),
  gtRealCardsAfterEnsemble: z.number().int().min(0).max(19),
  ensembleGames: gameNumbers,
  ensembleTriggerOverride: z.number().int().min(1).max(20).nullable(),
  rareFromRealOrdinal: z.number().int().min(3).max(20),
  guessEnableAfter: z.object({ game1: z.literal(1), others: z.literal(3) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.noiseFirstRange[0] > value.noiseFirstRange[1]) {
    ctx.addIssue({ code: 'custom', path: ['noiseFirstRange'], message: '등장 구간의 시작이 끝보다 늦을 수 없습니다.' });
  }
  if (value.groundTruthPerGame === 1 && value.groundTruthGames.some((game) => !value.ensembleGames.includes(game))) {
    ctx.addIssue({ code: 'custom', path: ['groundTruthGames'], message: 'Ground Truth를 쓰는 GAME은 Ensemble도 켜야 합니다.' });
  }
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type TeamSettings = z.infer<typeof teamSettingsSchema>;
export type Preset = 'easy' | 'normal' | 'hard';

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  studentCount: 18, teamCount: 3, moveCountPerTeam: 3,
  operatorTeamByName: { '운영진A': 'A', '운영진B': 'B', '운영진C': 'C' },
  blockTargetMinutes: [12, 12, 15], sessionTtlHours: 24,
  presenceWindowSeconds: 15, pollInGameMs: 2000, pollIdleMs: 5000, voteSeconds: 30,
};

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  preset: 'normal', dataSplitGames: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  noiseGames: [2, 3, 4, 5, 6, 7, 8, 9], noiseFirstRange: [2, 3],
  noiseAutoAdd: true, noiseCap: 3, groundTruthGames: [4, 5, 6, 7, 8, 9],
  groundTruthPerGame: 1, gtRealCardsAfterEnsemble: 0,
  ensembleGames: [1, 2, 3, 4, 5, 6, 7, 8, 9], ensembleTriggerOverride: null,
  rareFromRealOrdinal: 7, guessEnableAfter: { game1: 1, others: 3 },
};

export const parseGlobalConfig = (value: unknown): GlobalConfig => globalConfigSchema.parse(value);
export const parseTeamSettings = (value: unknown): TeamSettings => teamSettingsSchema.parse(value);

export function applyPreset(settings: TeamSettings, preset: Preset): TeamSettings {
  const changes = {
    easy: { rareFromRealOrdinal: 5, noiseAutoAdd: false, noiseCap: 1, gtRealCardsAfterEnsemble: 0 },
    normal: { rareFromRealOrdinal: 7, noiseAutoAdd: true, noiseCap: 3, gtRealCardsAfterEnsemble: 0 },
    hard: { rareFromRealOrdinal: 9, noiseAutoAdd: true, noiseCap: 3, gtRealCardsAfterEnsemble: 1 },
  }[preset];
  return parseTeamSettings({ ...settings, ...changes, preset });
}

export function getTeamKeys(count: number): string[] {
  if (!Number.isInteger(count) || count < 2 || count > 26) throw new GameRuleError('INVALID_TEAM_COUNT');
  return Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index));
}

export function getStudentCapacities(config: Pick<GlobalConfig, 'studentCount' | 'teamCount'>): number[] {
  return Array.from({ length: config.teamCount }, (_, index) =>
    Math.floor(config.studentCount / config.teamCount) + (index < config.studentCount % config.teamCount ? 1 : 0));
}

/** Validate effective next-block roster, not historic records that must be retained. */
export function validateRosterConfig(
  configInput: GlobalConfig, roster: readonly RosterEntry[], currentHostId?: string, nextHostId?: string,
): GlobalConfig {
  const config = parseGlobalConfig(configInput);
  const active = roster.filter((member) => member.active !== false);
  if (new Set(roster.map((member) => member.id)).size !== roster.length) throw new GameRuleError('DUPLICATE_PARTICIPANT');
  if (active.filter((member) => member.role === 'student').length !== config.studentCount) throw new GameRuleError('STUDENT_COUNT_MISMATCH');
  const operators = active.filter((member) => member.role === 'operator');
  if (operators.length !== config.teamCount) throw new GameRuleError('OPERATOR_COUNT_MISMATCH');
  const keys = new Set(getTeamKeys(config.teamCount));
  for (const [name, key] of Object.entries(config.operatorTeamByName)) {
    if (!keys.has(key) || operators.filter((member) => member.displayName === name).length !== 1) throw new GameRuleError('INVALID_OPERATOR_ASSIGNMENT');
  }
  const effectiveHost = nextHostId ?? currentHostId;
  if (effectiveHost && !operators.some((member) => member.id === effectiveHost)) throw new GameRuleError('HOST_REPLACEMENT_REQUIRED');
  return config;
}
