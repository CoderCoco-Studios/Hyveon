/** AWS access-key-id shape: `AKIA` followed by 16 uppercase alphanumeric characters. */
const AWS_ACCESS_KEY_ID_PATTERN = /\bAKIA[A-Z0-9]{16}\b/g;

/**
 * A `token`/`key`/`secret`-ish label (optionally hyphenated, e.g.
 * `bot-token`, `apiKey`), followed by `:`/`=` and a long (16+ char) run of
 * base64url/hex-ish characters — the shape of a value someone accidentally
 * logged alongside its own label. Deliberately does not match short words
 * like "key" or "secret" used in ordinary prose (e.g. "the key thing"),
 * since those aren't followed by a `:`/`=` and a long value run.
 */
const LABELED_SECRET_VALUE_PATTERN = /\b[\w-]*(?:token|key|secret)[\w-]*\s*[:=]\s*['"]?([A-Za-z0-9+/_-]{16,})['"]?/gi;

/**
 * Regex-based secret scrubber applied to already-collected log text before
 * it's included in a diagnostics bundle. Defense-in-depth only — the
 * primary safeguard remains "never log secrets" per
 * `.claude/rules/logging.md`; this catches the shapes it was written for
 * and no others.
 *
 * Pure function — no I/O.
 *
 * @param text - Raw log text (may be multi-line) to scrub.
 * @returns The same text with recognized secret-shaped substrings replaced
 *   by `[REDACTED]`.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(AWS_ACCESS_KEY_ID_PATTERN, '[REDACTED]')
    .replace(LABELED_SECRET_VALUE_PATTERN, (match, value: string) => match.replace(value, '[REDACTED]'));
}
