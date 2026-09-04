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
 * plain fixed-point output (e.g. matching a prior `toFixed` call site byte-for-byte).
 * @param value - the dollar amount to format
 * @param opts - formatting options
 */
export function formatUsd(value: number, opts: { precise?: boolean; digits?: number; grouping?: boolean } = {}): string {
  const digits = opts.digits ?? (opts.precise ? (value < 1 ? 4 : 2) : 2);
  const grouping = opts.grouping ?? true;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouping })}`;
}
