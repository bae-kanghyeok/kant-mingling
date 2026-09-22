import 'server-only';

import { parseTeamSettings, type TeamSettings } from './settings';
import type { Rng } from './types';

export function createNoisePlan({ gameNo, settings, rng }: { gameNo: number; settings: TeamSettings; rng: Rng }): number[] {
  const config = parseTeamSettings(settings);
  if (!config.noiseGames.includes(gameNo) || config.noiseCap === 0) return [];
  const slots = [rng.int(config.noiseFirstRange[0], config.noiseFirstRange[1])];
  if (!config.noiseAutoAdd) return slots;
  const deadlines = [6, 9, 12, 15];
  for (let index = 1; index < config.noiseCap; index++) {
    const low = slots[index - 1] + 1;
    const high = deadlines[index - 1];
    const all = Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
    const nonConsecutive = all.filter((slot) => slot !== low);
    slots.push(rng.pick(nonConsecutive.length ? nonConsecutive : all));
  }
  return slots;
}

/** Q1 minimum: the first random Noise is guaranteed at 3, never at 2. */
export function minimumNoiseCount(revealedCount: number, gameNo: number, settings: TeamSettings): number {
  if (!settings.noiseGames.includes(gameNo) || revealedCount < 3 || settings.noiseCap === 0) return 0;
  const target = !settings.noiseAutoAdd ? 1 : revealedCount < 6 ? 1 : revealedCount < 9 ? 2 : 3;
  return Math.min(settings.noiseCap, target);
}
