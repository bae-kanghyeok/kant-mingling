import 'server-only';

import { createHash } from 'node:crypto';
import { GameRuleError, type Rng } from './types';

export function makeRng(seed: string, label: string): Rng {
  let state = createHash('sha256').update(`${seed}:${label}`).digest().readUInt32LE(0);
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new GameRuleError('INVALID_RNG_RANGE');
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    next, int,
    pick: <T>(items: readonly T[]): T => {
      if (!items.length) throw new GameRuleError('EMPTY_RNG_POOL');
      return items[int(0, items.length - 1)];
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index--) {
        const other = int(0, index);
        [result[index], result[other]] = [result[other], result[index]];
      }
      return result;
    },
  };
}
