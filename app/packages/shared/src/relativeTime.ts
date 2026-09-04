/**
 * Formats how long ago a moment was as a coarse, human-readable string
 * ("5 minutes ago", "3 hours ago", "2 days ago").
 *
 * @remarks
 * Deliberately coarse (minutes/hours/days) rather than exact — callers use this for
 * decisions like "is this lock/run plausibly still in progress vs. abandoned", which
 * cares about orders of magnitude, not second-level precision. Shared by
 * `PulumiLockRecovery.formatLockAge` (desktop-main, `Date`-based) and
 * `submission-banners.component.tsx`'s `formatLockAge` (web, ISO-string-based) — both
 * adapt their own timestamp shape into a millisecond delta and call this.
 *
 * @param ms - Elapsed time in milliseconds. Negative values (clock skew) are clamped to 0.
 * @returns The elapsed time as a coarse "... ago" string.
 */
export function formatRelativeAge(ms: number): string {
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
