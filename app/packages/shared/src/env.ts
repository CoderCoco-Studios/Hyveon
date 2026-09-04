import { parseJsonEnv } from './envJson.js';

/**
 * Reads a required Lambda environment variable, throwing when it's absent or empty.
 *
 * @remarks
 * Several Lambdas call this at module scope (not inside a function body) so a missing
 * config value fails fast at `INIT_FAILURE` rather than partway through an invocation.
 * This function must stay a plain, side-effect-free export so that ordering is preserved
 * verbatim across every call site.
 *
 * @param name - The environment variable name.
 * @returns The variable's value.
 * @throws When `process.env[name]` is absent or empty.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * Parses the comma-separated `GAME_NAMES` environment variable into a trimmed,
 * non-empty list of game names.
 *
 * @returns The configured game names, or `[]` when `GAME_NAMES` is unset.
 */
export function gameNamesFromEnv(): string[] {
  return (process.env['GAME_NAMES'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses a JSON-object-shaped Lambda environment variable keyed by game name.
 *
 * @remarks
 * Thin wrapper over {@link parseJsonEnv} defaulting to `{}` — a malformed or absent value
 * falls back to an empty map instead of throwing, so a bad env var can't crash module init
 * and take down the Lambda for every game (see {@link parseJsonEnv} for the full rationale).
 *
 * @typeParam T - The per-game value type.
 * @param name - The environment variable name.
 * @returns The parsed game-keyed map, or `{}` when `raw` is absent or malformed.
 */
export function parseGameMapEnv<T>(name: string): Record<string, T> {
  return parseJsonEnv(name, process.env[name], {});
}

/**
 * Builds an ECS task-definition family → game name lookup from a game name list, matching
 * the `{game}-server` family naming convention used across the infra program's task
 * definitions.
 *
 * @param names - Game names, typically from {@link gameNamesFromEnv}.
 * @returns Map from `{game}-server` to `game`.
 */
export function familyToGameMap(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((g) => [`${g}-server`, g]));
}
