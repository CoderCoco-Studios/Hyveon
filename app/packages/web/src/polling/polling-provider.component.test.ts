import { describe, it, expect } from 'vitest';
import { isStale, STALE_MULTIPLIER, type PollerState } from './polling-provider.component.js';

/** Build a minimal PollerState; tests override individual fields per case. */
function makeState(overrides: Partial<PollerState> = {}): PollerState {
  return {
    intervalMs: 20_000,
    firstAttemptAt: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    loading: false,
    error: null,
    ...overrides,
  };
}

// @spec APP-SHELL-POLL-007
describe('isStale', () => {
  it('should return false when the poller state is undefined', () => {
    expect(isStale(undefined, 0)).toBe(false);
  });

  it('should return false before the first attempt has even fired', () => {
    expect(isStale(makeState(), 60_000)).toBe(false);
  });

  it('should return false when a recent success is within the interval window', () => {
    const now = 100_000;
    const state = makeState({ lastSuccessAt: now - 5_000 });
    expect(isStale(state, now)).toBe(false);
  });

  it('should not consider a poller stale exactly at the 2x interval boundary', () => {
    const now = 100_000;
    const state = makeState({ lastSuccessAt: now - STALE_MULTIPLIER * 20_000 });
    expect(isStale(state, now)).toBe(false);
  });

  it('should mark a poller stale once 2x the interval has elapsed without success', () => {
    const now = 100_000;
    const state = makeState({ lastSuccessAt: now - (STALE_MULTIPLIER * 20_000 + 1) });
    expect(isStale(state, now)).toBe(true);
  });

  it('should mark a never-succeeded poller stale only once 2x the interval has elapsed since the first attempt', () => {
    const now = 100_000;
    const justAttempted = makeState({ firstAttemptAt: now - 5_000, lastAttemptAt: now - 5_000 });
    expect(isStale(justAttempted, now)).toBe(false);

    const longSilent = makeState({
      firstAttemptAt: now - (STALE_MULTIPLIER * 20_000 + 1),
      lastAttemptAt: now - 5_000,
    });
    expect(isStale(longSilent, now)).toBe(true);
  });

  it('should ignore retry-driven lastAttemptAt updates so a perpetually-failing poll still flips stale', () => {
    const now = 100_000;
    // Poll has been retrying every 5s for the past 50s without a success;
    // `lastAttemptAt` is recent, but `firstAttemptAt` is well past 2× interval.
    const failing = makeState({
      firstAttemptAt: now - 50_000,
      lastAttemptAt: now - 1_000,
    });
    expect(isStale(failing, now)).toBe(true);
  });
});
