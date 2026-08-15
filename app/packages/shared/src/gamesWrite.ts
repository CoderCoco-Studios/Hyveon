/**
 * Request payload and result types shared between the desktop-main
 * `games.create` / `games.update` / `games.delete` IPC handlers (and their
 * HTTP equivalents) and the web client. Keeping these here — rather than in
 * `desktop-main` or `web` — means both sides of the wire agree on the exact
 * discriminated union without either package importing the other.
 */

import type { GameServer, GameListEntry, RedactedGameServer, GameServerHealthCheck } from './gameServerConfig.js';
import type { GameServerValidationIssue, GameServerHealthCheckAuthWriteInput } from './gameServerValidator.js';

/**
 * Write-side shape of `GameServerHealthCheck.auth`: the operator-submitted
 * {@link GameServerHealthCheckAuthWriteInput}, `null` to explicitly clear an
 * existing credential (deleting its app-owned secret if one backs it), or
 * `undefined` to leave whatever credential is already on record unchanged.
 * Only ever appears in a create/update payload — never in a persisted
 * `GameServerHealthCheck`, which always resolves to a concrete
 * `GameServerHealthCheckAuth | undefined`.
 */
export type GameServerHealthCheckWriteInput = Omit<GameServerHealthCheck, 'auth'> & {
  auth?: GameServerHealthCheckAuthWriteInput | null;
};

/**
 * Write-side shape of a `game_servers` entry submitted to `games.create` /
 * `games.update`: identical to `Omit<GameServer, 'name'>` except
 * `healthCheck`, which uses {@link GameServerHealthCheckWriteInput} so a
 * `basic`/`bearer` credential can be submitted as plaintext rather than a
 * pre-resolved `secretArn`.
 */
export type GameServerWriteConfig = Omit<GameServer, 'name' | 'healthCheck'> & {
  healthCheck?: GameServerHealthCheckWriteInput;
};

/**
 * Successful create/update/delete. `game` is the affected entry's
 * post-write config (omitted for a delete), with any health-check
 * credential redacted via `redactGameServer`; `games` is the full, freshly
 * merged games list so callers can refresh their view without a second
 * round trip.
 */
export interface GameWriteSuccess {
  ok: true;
  game?: RedactedGameServer;
  games: GameListEntry[];
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the current `DeploymentConfig` version — someone else edited the
 * configuration since the caller last read it. `currentVersionId` lets the
 * caller re-fetch and retry.
 */
export interface GameWriteConflict {
  ok: false;
  code: 'conflict';
  expectedVersionId?: string;
  currentVersionId?: string;
  message: string;
}

/** The proposed `game_servers` entry failed {@link GameServerValidationIssue}-shaped structural or business-rule validation. */
export interface GameWriteValidationFailure {
  ok: false;
  code: 'validation';
  issues: GameServerValidationIssue[];
}

/** The named game does not exist (e.g. update/delete targeting an undeclared game). */
export interface GameWriteNotFound {
  ok: false;
  code: 'not_found';
  message: string;
}

/**
 * No configuration bucket is configured — the operator has not finished (or
 * has somehow un-finished) the First-Run Wizard's bootstrap step. Distinct
 * from {@link GameWriteFailure} so a caller can route the operator toward
 * setup instead of showing a generic "something went wrong" message (see
 * `DeploymentConfigService.ConfigurationNotConfiguredError` in `desktop-main`, thrown
 * by every `DeploymentConfigService` write method when
 * `ConfigService.getConfigurationBucket()` resolves `null`).
 */
export interface GameWriteSetupIncomplete {
  ok: false;
  code: 'setup_incomplete';
  message: string;
}

/** Catch-all failure for errors that aren't a conflict, validation failure, not-found, or setup-incomplete (e.g. an unexpected S3 error). */
export interface GameWriteFailure {
  ok: false;
  code: 'error';
  message: string;
}

/**
 * Discriminated union returned by the `games.create` / `games.update` /
 * `games.delete` handlers. Discriminate on `ok` first, then `code` for the
 * failure branches.
 */
export type GameWriteResult =
  | GameWriteSuccess
  | GameWriteConflict
  | GameWriteValidationFailure
  | GameWriteNotFound
  | GameWriteSetupIncomplete
  | GameWriteFailure;

/**
 * Request payload for `games.create`. `expectedVersionId`, when supplied,
 * is checked against the current `DeploymentConfig` version and a
 * {@link GameWriteConflict} is returned on mismatch.
 */
export interface CreateGamePayload {
  name: string;
  config: GameServerWriteConfig;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.update`. Same shape as {@link CreateGamePayload}
 * — `name` identifies the existing game to overwrite with `config`.
 */
export interface UpdateGamePayload {
  name: string;
  config: GameServerWriteConfig;
  expectedVersionId?: string;
}

/** Request payload for `games.delete`. */
export interface DeleteGamePayload {
  name: string;
  expectedVersionId?: string;
}
