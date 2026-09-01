const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Validates a Discord snowflake ID (17–20 digit numeric string). */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value.trim());
}

/**
 * Split a free-form blob (newline / comma / whitespace separated) into a
 * `valid`/`invalid` snowflake bucket. Used for bulk-paste handling.
 */
export function parseSnowflakes(input: string): { valid: string[]; invalid: string[] } {
  const tokens = input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    if (isSnowflake(t)) valid.push(t);
    else invalid.push(t);
  }
  return { valid, invalid };
}

/** Deduplicate, preserving the original order. */
export function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
