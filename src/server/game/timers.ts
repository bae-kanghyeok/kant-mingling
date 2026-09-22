import 'server-only';

export function getReferenceTimers({ nowMs, gameStartedAtMs, revealedAtMs, pausedMsTotal, pausedAtMs, blockStartedAtMs, blockTargetMinutes }: {
  nowMs: number; gameStartedAtMs: number | null; revealedAtMs?: number | null; pausedMsTotal: number;
  pausedAtMs?: number | null; blockStartedAtMs: number | null; blockTargetMinutes: number;
}): { gameElapsedMs: number | null; blockElapsedMs: number | null; blockTargetMs: number } {
  const end = revealedAtMs ?? nowMs;
  const currentPause = pausedAtMs == null ? 0 : Math.max(0, end - pausedAtMs);
  return {
    gameElapsedMs: gameStartedAtMs == null ? null : Math.max(0, end - gameStartedAtMs - pausedMsTotal - currentPause),
    blockElapsedMs: blockStartedAtMs == null ? null : Math.max(0, nowMs - blockStartedAtMs),
    blockTargetMs: blockTargetMinutes * 60_000,
  };
}
