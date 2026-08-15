/**
 * Write-side orchestrator for the `games.create` / `games.update` /
 * `games.delete` IPC channels (and their HTTP equivalents) — see issue #98.
 *
 * Each operation follows the same shape:
 *  1. Validate the proposed entry via `validateGameServer()` (skipped for
 *     `deleteGame`, which has no config to validate), using the current
 *     declared `gameServers` list (`DeploymentConfigService.getGameServers()`) as the
 *     sibling set for the cross-game port-collision check.
 *  2. Delegate the actual config mutation to `DeploymentConfigService.addGameServer()` /
 *     `updateGameServer()` / `removeGameServer()`, forwarding
 *     `expectedVersionId` so the S3-mode conditional-put guard is honoured.
 *  3. Translate the handful of error shapes those calls can throw into the
 *     matching `GameWriteResult` failure variant (see the per-method docs
 *     below for the exact mapping).
 *  4. On success, invalidate both the `DeploymentConfigService` and `ConfigService`
 *     caches, emit a structured audit log entry (both the winston log line
 *     and a persisted `AuditService.record()` call carrying the before/after
 *     game config and the write's `versionId`), and return the updated game
 *     plus a freshly `mergeGameLists()`d games list so callers can refresh
 *     their view without a second round trip.
 */
import { Injectable } from '@nestjs/common';
import type {
  AuditAction,
  CreateGamePayload,
  DeleteGamePayload,
  GameServer,
  GameWriteResult,
  UpdateGamePayload,
} from '@hyveon/shared';
import { OptimisticLockError, redactGameServer, validateGameServer } from '@hyveon/shared';
import type { GameServerWriteConfig } from '@hyveon/shared';
import { validateHealthCheckAuthInput } from '@hyveon/shared/gameServerValidator';
import { deleteHealthCheckAuthSecret, upsertHealthCheckAuthSecret } from '@hyveon/shared/secrets/secretsStore';
import { logger } from '../logger.js';
import { AuditService } from './AuditService.js';
import { ConfigService } from './ConfigService.js';
import { ConfigurationNotConfiguredError, GameServerEntryError, DeploymentConfigService } from './DeploymentConfigService.js';
import { computeDriftFromOutputs } from './DriftService.js';
import { mergeGameLists } from './mergeGameLists.js';

/** The three write operations this service performs — used to tag the audit log entry. */
type GameWriteAction = 'create' | 'update' | 'delete';

/**
 * A syntactically-valid-but-inert Secrets Manager ARN used only to satisfy
 * `gameServerHealthCheckAuthSchema`'s `secretArn` pattern during the
 * structural pre-validation pass in {@link GamesWriteService.previewResolvedHealthCheckAuth} —
 * never persisted, never used to address a real secret. See that method's
 * doc comment for why a placeholder is needed at all.
 */
const STRUCTURAL_PREVIEW_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:pending-structural-preview';

/** Maps a {@link GameWriteAction} to the {@link AuditAction} recorded via `AuditService.record()`. */
const AUDIT_ACTION_BY_WRITE_ACTION: Record<GameWriteAction, AuditAction> = {
  create: 'add',
  update: 'edit',
  delete: 'remove',
};

/**
 * Validates and writes `gameServers` create/update/delete requests — see
 * the file-level doc comment above for the full flow. A thin orchestration
 * layer over `DeploymentConfigService` (the actual config mutation) and
 * `validateGameServer` (the shared structural/business-rule validator);
 * holds no state of its own.
 */
@Injectable()
export class GamesWriteService {
  constructor(
    private readonly config: ConfigService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Adds a brand-new `gameServers` entry. Validates `payload.config` via
   * `validateGameServer()` against every currently-declared game (so a port
   * collision against an existing game is caught), then delegates to
   * `DeploymentConfigService.addGameServer()`.
   *
   * Before any of that: rejects a `payload.name` that already exists in
   * `siblings` up front, with its own `{ code: 'validation' }` result.
   * `validateGameServer()` has no duplicate-name rule of its own, so without
   * this early check a duplicate name would only be caught later by
   * `addGameServer()` throwing `GameServerEntryError` — by which point
   * `resolveHealthCheckAuthSecret()` would already have overwritten the
   * existing game's live health-check secret with the about-to-be-rejected
   * credential. This check must run before that AWS mutation, not just
   * before the config write.
   *
   * Failure mapping:
   *  - Structural/business-rule validation failure → `{ code: 'validation' }`
   *    with the full issue list.
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `GameServerEntryError` with `reason: 'invalid-name'` or `'duplicate-name'`
   *    (the proposed name is malformed, or — in a race the up-front check above
   *    doesn't catch, e.g. a concurrent create of the same name — already exists
   *    in `gameServers`) → `{ code: 'validation' }` with a single `path: 'name'` issue.
   *  - `GameServerEntryError` with any other reason (`'structural'` — the
   *    config document parsed but its `gameServers` map is missing/not an
   *    object) → the catch-all `{ code: 'error' }`, since it isn't a name
   *    problem at all. A malformed-JSON parse failure lands here too, but as
   *    a plain `Error` (from `DeploymentConfigService.parseConfigContents()`), never a
   *    `GameServerEntryError` — it's mentioned here only because it produces
   *    the same `{ code: 'error' }` outcome, not because it shares the type.
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so a caller can route the operator toward the
   *    setup wizard instead of a generic failure message.
   */
  async createGame(payload: CreateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.createGame: creating game server entry', { game: payload.name });
    const authIssues = validateHealthCheckAuthInput(payload.config.healthCheck?.auth);
    if (authIssues.length > 0) {
      return { ok: false, code: 'validation', issues: authIssues };
    }

    const siblings = await this.deploymentConfig.getGameServers();

    // Duplicate-name check first: validateGameServer has no such rule
    // (checkPortCollisions explicitly skips self-name comparisons), so
    // without this a duplicate `payload.name` was only ever caught later by
    // `addGameServer()` throwing — by which point resolveHealthCheckAuthSecret
    // below would already have overwritten the EXISTING game's live secret
    // with the about-to-be-rejected credential. Must run before both the
    // structural preview and the real secret mutation.
    if (siblings.some((sibling) => sibling.name === payload.name)) {
      return {
        ok: false,
        code: 'validation',
        issues: [{ path: 'name', message: `A game server named "${payload.name}" already exists.` }],
      };
    }

    // Structural pass first, against a placeholder-secretArn preview that
    // performs no Secrets Manager call — see resolveHealthCheckAuthSecret's
    // doc comment for why the AWS-mutating call must not run until this
    // (port collisions, cpu/memory pairing, etc.) has already succeeded.
    const structuralPreview = this.previewResolvedHealthCheckAuth(payload.config, null);
    const structuralValidation = validateGameServer(payload.name, structuralPreview, siblings);
    if (!structuralValidation.success) {
      return { ok: false, code: 'validation', issues: structuralValidation.issues };
    }

    const resolvedConfig = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, null);
    const validation = validateGameServer(payload.name, resolvedConfig, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.addGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof GameServerEntryError && (err.reason === 'invalid-name' || err.reason === 'duplicate-name')) {
        return { ok: false, code: 'validation', issues: [{ path: 'name', message: err.message }] };
      }
      if (err instanceof ConfigurationNotConfiguredError) {
        return this.setupIncompleteResult(err);
      }
      return this.errorResult(err);
    }

    return this.successResult('create', name, validation.data, { before: null, after: validation.data, versionId: write.versionId });
  }

  /**
   * Replaces an existing `gameServers` entry's value in place. Validates
   * `payload.config` via `validateGameServer()` against every declared game
   * (the entry being edited is skipped for self-collisions by
   * `validateGameServer()` itself), then delegates to
   * `DeploymentConfigService.updateGameServer()`.
   *
   * Failure mapping:
   *  - Structural/business-rule validation failure → `{ code: 'validation' }`
   *    with the full issue list.
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `GameServerEntryError` (`payload.name` doesn't exist in `gameServers`,
   *    or the config document parsed but its `gameServers` map is missing/
   *    not an object) → `{ code: 'not_found' }`, regardless of its specific
   *    `reason` — this write path never throws an
   *    `'invalid-name'`/`'duplicate-name'` error (the name is already
   *    known-good, being an existing key), so any error here means
   *    "couldn't find/apply the update." Note this does NOT cover malformed
   *    JSON itself (a `JSON.parse` failure) — that's a plain `Error` from
   *    `DeploymentConfigService.parseConfigContents()`, not a `GameServerEntryError`,
   *    and falls through to the generic `{ code: 'error' }` below instead.
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so a caller can route the operator toward the
   *    setup wizard instead of a generic failure message.
   */
  async updateGame(payload: UpdateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.updateGame: updating game server entry', { game: payload.name });
    const siblings = await this.deploymentConfig.getGameServers();
    const before = siblings.find((sibling) => sibling.name === payload.name) ?? null;

    const authIssues = validateHealthCheckAuthInput(payload.config.healthCheck?.auth);
    if (authIssues.length > 0) {
      return { ok: false, code: 'validation', issues: authIssues };
    }

    // Structural pass first, against a placeholder-secretArn preview that
    // performs no Secrets Manager call — see resolveHealthCheckAuthSecret's
    // doc comment for why the AWS-mutating call must not run until this
    // (port collisions, cpu/memory pairing, etc.) has already succeeded.
    const structuralPreview = this.previewResolvedHealthCheckAuth(payload.config, before);
    const structuralValidation = validateGameServer(payload.name, structuralPreview, siblings);
    if (!structuralValidation.success) {
      return { ok: false, code: 'validation', issues: structuralValidation.issues };
    }

    // resolveHealthCheckAuthSecret now owns the "omitted auth means unchanged"
    // splice that used to live inline here — see its own doc comment.
    const incomingConfig = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, before);

    const validation = validateGameServer(payload.name, incomingConfig, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.updateGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof GameServerEntryError) {
        return { ok: false, code: 'not_found', message: err.message };
      }
      if (err instanceof ConfigurationNotConfiguredError) {
        return this.setupIncompleteResult(err);
      }
      return this.errorResult(err);
    }

    return this.successResult('update', name, validation.data, { before, after: validation.data, versionId: write.versionId });
  }

  /**
   * Removes a `gameServers` entry. Skips `validateGameServer()` entirely —
   * there's no proposed config to validate — and delegates straight to
   * `DeploymentConfigService.removeGameServer()`.
   *
   * Failure mapping:
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `GameServerEntryError` (`payload.name` doesn't exist in `gameServers`,
   *    or the config document parsed but its `gameServers` map is missing/
   *    not an object) → `{ code: 'not_found' }`, regardless of its specific
   *    `reason` — see {@link updateGame}'s doc for why this catch is
   *    intentionally blanket, and for the malformed-JSON case this does
   *    NOT cover (falls through to `{ code: 'error' }` instead).
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so a caller can route the operator toward the
   *    setup wizard instead of a generic failure message.
   */
  async deleteGame(payload: DeleteGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.deleteGame: deleting game server entry', { game: payload.name });
    const siblings = await this.deploymentConfig.getGameServers();
    const before = siblings.find((sibling) => sibling.name === payload.name) ?? null;

    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.removeGameServer(payload.name, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof GameServerEntryError) {
        return { ok: false, code: 'not_found', message: err.message };
      }
      if (err instanceof ConfigurationNotConfiguredError) {
        return this.setupIncompleteResult(err);
      }
      return this.errorResult(err);
    }

    if (before?.healthCheck?.auth && (before.healthCheck.auth.type === 'basic' || before.healthCheck.auth.type === 'bearer')) {
      await this.deleteAppOwnedSecret(payload.name, before.healthCheck.auth.secretArn);
    }

    return this.successResult('delete', payload.name, undefined, { before, after: null, versionId: write.versionId });
  }

  /**
   * Shared success path for all three operations: invalidates both the
   * `DeploymentConfigService` and `ConfigService` caches so the next read reflects the
   * write, emits the existing structured winston log line (action, game
   * name), persists an `AuditService.record()` entry carrying
   * `audit.before`/`audit.after`/
   * `audit.versionId` under the mapped {@link AuditAction} (via
   * {@link AUDIT_ACTION_BY_WRITE_ACTION}), and builds the refreshed
   * `mergeGameLists()` list. `game` is omitted for `'delete'`, matching
   * `GameWriteSuccess.game`'s "omitted for a delete" contract — `name` is
   * passed separately so both log lines still record which game was
   * affected even when there's no `game` object to pull it from.
   */
  private async successResult(
    action: GameWriteAction,
    name: string,
    game: GameServer | undefined,
    audit: { before: GameServer | null; after: GameServer | null; versionId?: string },
  ): Promise<GameWriteResult> {
    this.deploymentConfig.invalidateCache();
    this.config.invalidateCache();

    // A write only reaches this point once `DeploymentConfigService.writeConfig()` has
    // already succeeded, which requires a configured configuration bucket
    // (`ConfigurationNotConfiguredError` otherwise) — so `mode` is always
    // `'s3'` here; there is no local-file mode.
    logger.info('Game server write', { action, game: name, mode: 's3' });

    await this.audit.record({
      action: AUDIT_ACTION_BY_WRITE_ACTION[action],
      game: name,
      before: audit.before ? redactGameServer(audit.before) : null,
      after: audit.after ? redactGameServer(audit.after) : null,
      versionId: audit.versionId,
    });

    const declared = await this.deploymentConfig.getGameServers();
    const outputs = await this.config.getStackOutputs();
    const driftReport = computeDriftFromOutputs(declared, outputs);
    const games = mergeGameLists(declared, outputs?.gameNames ?? [], driftReport.entries);

    return { ok: true, game: game ? redactGameServer(game) : undefined, games };
  }

  /**
   * Builds a `GameWriteConflict` from a caught {@link OptimisticLockError},
   * forwarding both etags. Logged at `warn` — a stale `expectedVersionId` is
   * an expected, recoverable race (another write landed first), not an
   * unexpected failure, but the operator still needs a record of it to
   * explain a rejected save.
   */
  private conflictResult(err: OptimisticLockError): GameWriteResult {
    logger.warn('Game server write rejected — stale expectedVersionId', {
      message: err.message,
      expectedVersionId: err.expectedEtag,
      currentVersionId: err.currentEtag,
    });
    return {
      ok: false,
      code: 'conflict',
      expectedVersionId: err.expectedEtag,
      currentVersionId: err.currentEtag,
      message: err.message,
    };
  }

  /**
   * Builds a `GameWriteSetupIncomplete` from a caught
   * `ConfigurationNotConfiguredError` — no configuration bucket is
   * configured, so this write was never going to reach `RemoteFileStore` at
   * all. Logged at `warn` (not `error`, mirroring `DeploymentConfigService`'s own
   * "expected pre-wizard-completion state" treatment of this error) so a
   * routine "setup incomplete" attempt doesn't read as a genuine incident.
   */
  private setupIncompleteResult(err: ConfigurationNotConfiguredError): GameWriteResult {
    logger.warn('Game server write rejected — no configuration bucket configured', { err: err.message });
    return { ok: false, code: 'setup_incomplete', message: err.message };
  }

  /**
   * Builds the catch-all `GameWriteFailure` for any error that isn't a
   * conflict/validation/not-found/setup-incomplete (e.g. an unexpected S3
   * error). Logs the original error server-side but returns a stable,
   * generic message to the caller — the raw error can contain filesystem
   * paths or other infra details that shouldn't be forwarded verbatim as an
   * HTTP 500 body.
   */
  private errorResult(err: unknown): GameWriteResult {
    logger.error('Game server write failed', { err });
    return { ok: false, code: 'error', message: 'An unexpected error occurred while writing the game server configuration' };
  }

  /**
   * Pure, non-mutating preview of what {@link resolveHealthCheckAuthSecret}
   * would eventually produce, used to run `validateGameServer`'s structural/
   * business-rule checks (port collisions, cpu/memory pairing, etc. — rules
   * that have nothing to do with `auth` itself) *before* any Secrets Manager
   * call happens.
   *
   * Mirrors {@link resolveHealthCheckAuthSecret}'s branching exactly, except
   * it never calls `upsertHealthCheckAuthSecret`/`deleteHealthCheckAuthSecret`:
   * a `basic`/`bearer` credential gets {@link STRUCTURAL_PREVIEW_SECRET_ARN}
   * in place of a real secret ARN (the persisted schema requires some
   * pattern-matching `secretArn` regardless of `type`, and no real one exists
   * until the write actually happens), and the delete-on-clear/delete-on-
   * switch-to-raw cases are simply skipped, since a delete doesn't change
   * the shape being validated.
   *
   * Callers must still call {@link resolveHealthCheckAuthSecret} (only once
   * this structural pass has succeeded) to get the real, persistable config
   * and to actually perform the Secrets Manager mutation.
   *
   * @param config - The proposed write-side config (may be `undefined` when the entry has no `healthCheck` at all).
   * @param before - The entry's prior persisted state, or `null` for a brand-new game.
   * @returns `config` with `healthCheck.auth` resolved to a validation-ready shape — never the real persisted one.
   */
  private previewResolvedHealthCheckAuth(config: GameServerWriteConfig, before: GameServer | null): Omit<GameServer, 'name'> {
    if (!config.healthCheck) {
      return { ...config, healthCheck: undefined };
    }

    const { auth, ...healthCheckRest } = config.healthCheck;
    const beforeAuth = before?.healthCheck?.auth;

    if (auth === undefined) {
      return { ...config, healthCheck: { ...healthCheckRest, auth: beforeAuth } };
    }

    if (auth === null) {
      return { ...config, healthCheck: { ...healthCheckRest, auth: undefined } };
    }

    const type = auth.type ?? 'raw';
    if (type === 'raw') {
      return { ...config, healthCheck: { ...healthCheckRest, auth: { type: 'raw', secretArn: auth.secretArn as string } } };
    }

    return { ...config, healthCheck: { ...healthCheckRest, auth: { type, secretArn: STRUCTURAL_PREVIEW_SECRET_ARN } } };
  }

  /**
   * Resolves `config.healthCheck.auth` into the persisted
   * `GameServerHealthCheckAuth` shape (`{ type?, secretArn }`), performing
   * whatever Secrets Manager write the declared change requires:
   *  - `auth` omitted → leave `before`'s credential unchanged (existing
   *    behavior, unchanged from before this feature).
   *  - `auth === null` → explicit clear. Deletes `before`'s app-owned secret
   *    (if `before.auth.type` was `'basic'`/`'bearer'`) and returns `config`
   *    with `healthCheck.auth` unset.
   *  - `auth.type` `'raw'`/absent → the operator-supplied `secretArn` is
   *    used as-is (already required by {@link validateHealthCheckAuthInput}
   *    before this method runs). If `before`'s credential was app-owned
   *    (`'basic'`/`'bearer'`), its now-orphaned secret is deleted.
   *  - `auth.type` `'basic'`/`'bearer'` → builds the secret value
   *    (`JSON.stringify({ username, password })` or the raw `token`) and
   *    calls {@link upsertHealthCheckAuthSecret}, which creates the secret on
   *    first save and updates it in place on every subsequent edit (see
   *    that function's own doc for why no separate "does it already exist"
   *    check is needed).
   *
   * @remarks
   * Must only be called after {@link previewResolvedHealthCheckAuth}'s
   * structural preview has already passed `validateGameServer` — this method
   * is the one that actually talks to Secrets Manager
   * (`upsertHealthCheckAuthSecret`/`deleteHealthCheckAuthSecret`), and that
   * write must never happen ahead of a structural check that's unrelated to
   * `auth` but could still reject the overall entry (a port collision, bad
   * cpu/memory pairing, etc.) — doing so would leave a live secret mutated or
   * deleted for a save that was never actually persisted.
   *
   * Never called for a `deleteGame` — that path calls
   * {@link deleteHealthCheckAuthSecret} directly in {@link deleteGame} once
   * the config removal itself has succeeded.
   *
   * @param gameId - The `game_servers` map key this entry is being saved under.
   * @param config - The proposed write-side config (may be `undefined` when the entry has no `healthCheck` at all).
   * @param before - The entry's prior persisted state, or `null` for a brand-new game.
   * @returns `config` with `healthCheck.auth` resolved to the persisted shape (or `undefined`), ready for `validateGameServer`.
   */
  private async resolveHealthCheckAuthSecret(
    gameId: string,
    config: GameServerWriteConfig,
    before: GameServer | null,
  ): Promise<Omit<GameServer, 'name'>> {
    if (!config.healthCheck) {
      if (before?.healthCheck?.auth && (before.healthCheck.auth.type === 'basic' || before.healthCheck.auth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, before.healthCheck.auth.secretArn);
      }
      return { ...config, healthCheck: undefined };
    }

    const { auth, ...healthCheckRest } = config.healthCheck;
    const beforeAuth = before?.healthCheck?.auth;

    if (auth === undefined) {
      return { ...config, healthCheck: { ...healthCheckRest, auth: beforeAuth } };
    }

    if (auth === null) {
      if (beforeAuth && (beforeAuth.type === 'basic' || beforeAuth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, beforeAuth.secretArn);
      }
      return { ...config, healthCheck: { ...healthCheckRest, auth: undefined } };
    }

    const type = auth.type ?? 'raw';
    if (type === 'raw') {
      if (beforeAuth && (beforeAuth.type === 'basic' || beforeAuth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, beforeAuth.secretArn);
      }
      return { ...config, healthCheck: { ...healthCheckRest, auth: { type: 'raw', secretArn: auth.secretArn as string } } };
    }

    const secretValue = type === 'basic' ? JSON.stringify({ username: auth.username, password: auth.password }) : (auth.token as string);
    const secretArn = await this.upsertAppOwnedSecret(gameId, secretValue);
    return { ...config, healthCheck: { ...healthCheckRest, auth: { type, secretArn } } };
  }

  /** Wraps {@link upsertHealthCheckAuthSecret}, normalizing and logging any Secrets Manager failure per this repo's logging convention. */
  private async upsertAppOwnedSecret(gameId: string, value: string): Promise<string> {
    try {
      return await upsertHealthCheckAuthSecret(gameId, value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('GamesWriteService.resolveHealthCheckAuthSecret: failed to create/update the health-check credential secret', {
        game: gameId,
        error: message,
      });
      throw new Error(`Failed to save the health-check credential: ${message}`);
    }
  }

  /** Wraps {@link deleteHealthCheckAuthSecret}, logging (not throwing on) a Secrets Manager failure — a delete-cleanup failure must not block the config write it's tidying up after. */
  private async deleteAppOwnedSecret(gameId: string, secretArn: string): Promise<void> {
    try {
      await deleteHealthCheckAuthSecret(gameId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GamesWriteService.resolveHealthCheckAuthSecret: failed to delete an orphaned health-check credential secret', {
        game: gameId,
        secretArn,
        error: message,
      });
    }
  }
}
