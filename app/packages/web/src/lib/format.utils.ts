/** Formats an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Formats a dollar amount with sensible precision for the value's magnitude.
 *
 * @remarks
 * `digits` overrides the default precision (2 digits, or 4 below $1 when `precise` is set); `grouping`
 * defaults to `true` (thousands separators via `toLocaleString`) — pass `false` for callers that need
 * plain fixed-point output (e.g. matching a prior `toFixed` call site byte-for-byte). The `en-US` locale
 * is pinned explicitly (not `undefined`) so the decimal separator stays `.` regardless of the operator's
 * OS locale — `toLocaleString(undefined, ...)` would otherwise localize it (e.g. `,` under `de-DE`),
 * which is a behavior change from the `toFixed` call sites this replaced.
 * @param value - the dollar amount to format
 * @param opts - formatting options
 */
export function formatUsd(value: number, opts: { precise?: boolean; digits?: number; grouping?: boolean } = {}): string {
  const digits = opts.digits ?? (opts.precise ? (value < 1 ? 4 : 2) : 2);
  const grouping = opts.grouping ?? true;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouping })}`;
}

/** Formats a byte count with binary units (`1.5 MB`); whole bytes below 1 KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Formats a duration in seconds as `1h 02m`, `3m 05s`, or `42s`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
