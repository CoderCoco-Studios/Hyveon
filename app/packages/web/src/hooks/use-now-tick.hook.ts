import { useEffect, useState } from 'react';

/**
 * Re-renders the calling component every `intervalMs` milliseconds by returning fresh
 * `Date.now()` output, so relative-time labels ("Updated 3s ago", staleness hints) stay current
 * without each consumer running its own timer.
 *
 * @param intervalMs - tick interval in milliseconds
 * @returns the current wall-clock time, refreshed on every tick
 */
export function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
