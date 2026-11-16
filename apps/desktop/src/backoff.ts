// Restart policy for an owned core: waits 1 s, 2 s, then 5 s; gives up after 5 restarts inside 2 minutes.

export const RESTART_DELAYS_MS = [1000, 2000, 5000];
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 120_000;

export interface RestartPolicy {
  /** Called when core exits unexpectedly. Returns the delay before restarting, or null to give up. */
  next(now: number): number | null;
  reset(): void;
}

export function restartPolicy(): RestartPolicy {
  let attempts: number[] = [];
  return {
    next(now) {
      attempts = attempts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (attempts.length >= MAX_RESTARTS) return null;
      const delay = RESTART_DELAYS_MS[Math.min(attempts.length, RESTART_DELAYS_MS.length - 1)]!;
      attempts.push(now);
      return delay;
    },
    reset() {
      attempts = [];
    },
  };
}
