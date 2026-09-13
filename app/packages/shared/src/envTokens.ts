/**
 * The `${hyveon.<namespace>.<name>}` interpolation tokens supported in game
 * server environment variable values, and helpers for finding and
 * substituting them. The grammar is allow-list only: any `${hyveon.*}`
 * sequence outside {@link ALLOWED_HYVEON_ENV_TOKENS} is a validation error,
 * while all other text (including `${OTHER_VAR}` shell syntax) is opaque.
 */

/** The v1 token catalog, keyed by a descriptive alias. */
export const HYVEON_ENV_TOKENS = {
  /** Resolves to the game's DNS name `<game>.<zone>` at deploy time. */
  publicAddress: '${hyveon.network.public-address}',
  /** Resolves to the task's public IPv4 at container boot. */
  publicIpv4: '${hyveon.network.public-ipv4}',
} as const;

/** One of the allow-listed interpolation tokens. */
export type HyveonEnvToken = (typeof HYVEON_ENV_TOKENS)[keyof typeof HYVEON_ENV_TOKENS];

/** Every legal token, for membership checks in the validator. */
export const ALLOWED_HYVEON_ENV_TOKENS: ReadonlySet<string> = new Set(Object.values(HYVEON_ENV_TOKENS));

/** Matches every `${hyveon....}` candidate sequence, legal or not. */
export const HYVEON_TOKEN_CANDIDATE_PATTERN = /\$\{hyveon\.[^}]*\}/g;

/** Returns every `${hyveon....}` sequence in `value`, in order, including unknown ones. */
export function findHyveonTokenCandidates(value: string): string[] {
  return [...value.matchAll(HYVEON_TOKEN_CANDIDATE_PATTERN)].map((match) => match[0]);
}

/** Returns whether `value` contains `token` at least once. */
export function valueUsesToken(value: string, token: HyveonEnvToken): boolean {
  return value.includes(token);
}

/** Replaces every occurrence of `token` in `value` with `replacement`, leaving all other text untouched. */
export function substituteHyveonToken(value: string, token: HyveonEnvToken, replacement: string): string {
  return value.split(token).join(replacement);
}
