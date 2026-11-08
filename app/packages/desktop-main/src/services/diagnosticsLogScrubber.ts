/**
 * AWS access-key-id shape: `AKIA` (long-term) or `ASIA` (temporary/STS
 * session) prefix followed by 16 uppercase alphanumeric characters.
 */
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * An unlabelled 40-character base64-ish AWS secret access key that follows an access key id within a few
 * separator characters (`id secret`, `id:secret`, `id, secret`). Anchoring on the id keeps arbitrary 40-character
 * hashes (git SHAs, object ids) untouched.
 */
const AWS_SECRET_AFTER_KEY_ID_PATTERN = /(\b(?:AKIA|ASIA)[A-Z0-9]{16}\b[^A-Za-z0-9+/\n]{1,6})[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g;

/** A Discord bot token: base64 user id, 6-7 character timestamp, 27+ character HMAC, dot-separated. */
const DISCORD_TOKEN_PATTERN = /\b[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}\b/g;

/** The credential of an `Authorization` header or JSON/meta pair (`Bearer`, `Bot` or `Basic` scheme); the label stays. */
const AUTHORIZATION_HEADER_PATTERN = /(\bauthorization(?:\\*['"])?\s*[:=]\s*(?:\\*['"])?(?:Bearer|Bot|Basic)\s+)[^\s"'\\,}]+/gi;

/** A `Bearer <credential>` of 16 or more token characters outside any header label (the scheme word stays). */
const BEARER_CREDENTIAL_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

/** Presigned-URL query parameters that carry signature material; matches through the next `&`, quote or whitespace. */
const PRESIGNED_URL_PARAM_PATTERN = /(\bX-Amz-(?:Signature|Security-Token|Credential)=)[^&\s"']+/gi;

/**
 * A `token`/`key`/`secret`/`password`/`passphrase`-ish label (optionally hyphenated or underscored, e.g.
 * `bot-token`, `apiKey`, `db_password`), followed by `:`/`=` and a run of six or more base64url/hex-ish characters
 * (`.` and `=` included so dotted tokens and padded values are redacted whole) — the shape of a value someone
 * accidentally logged alongside its own label. Deliberately does not match short words like "key" or "secret" used in
 * ordinary prose (e.g. "the key thing"), since those aren't followed by a `:`/`=` and a value run.
 *
 * Also matches JSON-shaped pairs (`"botToken":"…"`, `"apiKey": "…"`, `'apiKey': '…'`, and the backslash-escaped
 * quotes of JSON nested inside JSON strings, at any depth): the label may carry a closing quote before the separator, and the
 * value may carry an opening quote.
 */
const LABELED_SECRET_VALUE_PATTERN =
  /\b([\w-]*(?:token|key|secret|passphrase|password|passwd)[\w-]*(?:\\*['"])?\s*[:=]\s*(?:\\*['"])?)([A-Za-z0-9+/_.=-]{6,})/gi;

const REDACTED = '[REDACTED]';

// @spec APP-DIAG-SCRUB-001, APP-DIAG-SCRUB-002, APP-DIAG-SCRUB-003, APP-DIAG-SCRUB-004, APP-DIAG-SCRUB-006
// @spec APP-DIAG-SCRUB-007, APP-DIAG-SCRUB-008, APP-DIAG-SCRUB-009, APP-DIAG-SCRUB-010
/**
 * Regex-based secret scrubber applied to log text before it's included in a diagnostics bundle, written to the app
 * log from the renderer, or returned in a log tail. Defense-in-depth only — the primary safeguard remains "never log
 * secrets" per `.claude/rules/logging.md`; this catches the shapes it was written for and no others: AWS access key
 * ids and the secret key that follows one, Discord tokens, `Authorization`/`Bearer` credentials, presigned-URL
 * signature parameters, and long-enough values behind a token/key/secret/password/passphrase label.
 *
 * Pure function — no I/O.
 *
 * @param text - Raw log text (may be multi-line) to scrub.
 * @returns The same text with recognized secret-shaped substrings replaced by `[REDACTED]`.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(AWS_SECRET_AFTER_KEY_ID_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AWS_ACCESS_KEY_ID_PATTERN, REDACTED)
    .replace(PRESIGNED_URL_PARAM_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AUTHORIZATION_HEADER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_CREDENTIAL_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(DISCORD_TOKEN_PATTERN, REDACTED)
    .replace(LABELED_SECRET_VALUE_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}
