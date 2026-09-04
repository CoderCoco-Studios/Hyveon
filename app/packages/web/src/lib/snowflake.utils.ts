import { isSnowflake } from '@hyveon/shared';

export { isSnowflake };

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
