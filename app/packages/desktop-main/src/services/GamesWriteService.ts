/**
 * Write-side orchestrator for the `games.create` / `games.update` /
 * `games.delete` IPC channels.
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
import { OptimisticLockError, errMessage, redactGameServer, validateGameServer } from '@hyveon/shared';
import type { GameServerWriteConfig } from '@hyveon/shared';
import { validateHealthCheckAuthInput } from '@hyveon/shared/gameServerValidator';
import {
  deleteHealthCheckAuthSecret,
  readHealthCheckAuthSecret,
  upsertHealthCheckAuthSecret,
} from '@hyveon/shared/secrets/secretsStore';
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

/**
 * The deferred half of a health-check secret change: `rollback` undoes an upsert when the config write fails, `commit`
 * runs the orphan deletes once it succeeds. Both swallow and log their own Secrets Manager failures.
 */
interface SecretChange {
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

/** The outcome of {@link GamesWriteService.resolveHealthCheckAuthSecret}: a persistable config plus its deferred secret change, or a modeled failure. */
type ResolvedHealthCheck = { config: Omit<GameServer, 'name'>; change: SecretChange } | { failure: GameWriteResult };

/** A no-op {@link SecretChange} for saves that touch no app-owned secret. */
const NO_SECRET_CHANGE: SecretChange = { rollback: async () => undefined, commit: async () => undefined };

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
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly audit: AuditService,
  ) {}

  // @spec GAME-VALID-001, GAME-HTTPS-003, GAME-WRITE-001, GAME-WRITE-002, GAME-WRITE-003, GAME-WRITE-008
  // @spec GAME-WRITE-004, GAME-WRITE-005, GAME-WRITE-006, GAME-WRITE-009, GAME-WRITE-011, GAME-WRITE-013
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
    return this.exclusive(() => this.createGameLocked(payload));
  }

  /** createGame body, run under the write lock. */
  private async createGameLocked(payload: CreateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.createGame: creating game server entry', { game: payload.name });
    const authIssues = validateHealthCheckAuthInput(payload.config.healthCheck?.auth);
    if (authIssues.length > 0) {
      return { ok: false, code: 'validation', issues: authIssues };
    }

    const siblings = await this.readSiblings();
    if (!Array.isArray(siblings)) {
      return siblings;
    }

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

    const resolved = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, null);
    if ('failure' in resolved) {
      return resolved.failure;
    }
    const secretChange = resolved.change;
    const validation = validateGameServer(payload.name, resolved.config, siblings);
    if (!validation.success) {
      await secretChange.rollback();
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.addGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      await secretChange.rollback();
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

    await secretChange.commit();
    return this.successResult('create', name, validation.data, { before: null, after: validation.data, versionId: write.versionId });
  }

  // @spec GAME-VALID-001, GAME-VALID-008, GAME-HTTPS-003, GAME-WRITE-001, GAME-WRITE-003, GAME-WRITE-008
  // @spec GAME-WRITE-004, GAME-WRITE-005, GAME-WRITE-006, GAME-WRITE-010, GAME-WRITE-011, GAME-WRITE-013
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
   *  - `GameServerEntryError` with `reason: 'not-found'` (`payload.name` doesn't
   *    exist in `gameServers`) → `{ code: 'not_found' }`. Any other reason
   *    (`'structural'` — the `gameServers` map is missing/not an object) → the
   *    catch-all `{ code: 'error' }`, so a broken document is not reported as
   *    a missing game. Malformed JSON is a plain `Error` and also lands there.
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so a caller can route the operator toward the
   *    setup wizard instead of a generic failure message.
   */
  async updateGame(payload: UpdateGamePayload): Promise<GameWriteResult> {
    return this.exclusive(() => this.updateGameLocked(payload));
  }

  /** updateGame body, run under the write lock. */
  private async updateGameLocked(payload: UpdateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.updateGame: updating game server entry', { game: payload.name });
    const siblings = await this.readSiblings();
    if (!Array.isArray(siblings)) {
      return siblings;
    }
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

    const resolved = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, before);
    if ('failure' in resolved) {
      return resolved.failure;
    }
    const secretChange = resolved.change;

    const validation = validateGameServer(payload.name, resolved.config, siblings);
    if (!validation.success) {
      await secretChange.rollback();
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.updateGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      await secretChange.rollback();
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof GameServerEntryError && err.reason === 'not-found') {
        return { ok: false, code: 'not_found', message: err.message };
      }
      if (err instanceof ConfigurationNotConfiguredError) {
        return this.setupIncompleteResult(err);
      }
      return this.errorResult(err);
    }

    await secretChange.commit();
    return this.successResult('update', name, validation.data, { before, after: validation.data, versionId: write.versionId });
  }

  // @spec RT-HEALTH-CRED-005, RT-HEALTH-CRED-006
  // @spec GAME-WRITE-006, GAME-WRITE-007, GAME-WRITE-008, GAME-WRITE-010, GAME-WRITE-011, GAME-WRITE-013
  /**
   * Removes a `gameServers` entry. Skips `validateGameServer()` entirely —
   * there's no proposed config to validate — and delegates straight to
   * `DeploymentConfigService.removeGameServer()`.
   *
   * Failure mapping:
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `GameServerEntryError` with `reason: 'not-found'` (`payload.name` doesn't
   *    exist in `gameServers`) → `{ code: 'not_found' }`. Any other reason
   *    (`'structural'` — the `gameServers` map is missing/not an object) → the
   *    catch-all `{ code: 'error' }`, so a broken document is not reported as
   *    a missing game. Malformed JSON is a plain `Error` and also lands there.
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so a caller can route the operator toward the
   *    setup wizard instead of a generic failure message.
   */
  async deleteGame(payload: DeleteGamePayload): Promise<GameWriteResult> {
    return this.exclusive(() => this.deleteGameLocked(payload));
  }

  /** deleteGame body, run under the write lock. */
  private async deleteGameLocked(payload: DeleteGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.deleteGame: deleting game server entry', { game: payload.name });
    const siblings = await this.readSiblings();
    if (!Array.isArray(siblings)) {
      return siblings;
    }
    const before = siblings.find((sibling) => sibling.name === payload.name) ?? null;

    let write: { etag: string; versionId?: string };
    try {
      write = await this.deploymentConfig.removeGameServer(payload.name, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof GameServerEntryError && err.reason === 'not-found') {
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


  // @spec GAME-WRITE-014
  /**
   * Serializes a write so the sibling read, secret upsert, config write and commit/rollback of one write never
   * interleave with another's. The desktop app is a single process, so an in-process chain is sufficient.
   *
   * @param fn - The write to run once every earlier write has settled.
   * @returns Whatever `fn` resolves to.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // @spec GAME-WRITE-006
  /**
   * Reads the declared games used as the cross-game sibling set, failing the write instead of validating against an
   * empty list when the read fails.
   *
   * @returns The declared games, or the modeled failure result to return to the caller.
   */
  private async readSiblings(): Promise<GameServer[] | GameWriteResult> {
    try {
      return await this.deploymentConfig.getGameServersStrict();
    } catch (err) {
      if (err instanceof ConfigurationNotConfiguredError) {
        return this.setupIncompleteResult(err);
      }
      return this.errorResult(err);
    }
  }

  // @spec APP-DIAG-AUDIT-005
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

  // @spec GAME-WRITE-012
  /**
   * Builds the catch-all `GameWriteFailure` for any error that isn't a
   * conflict/validation/not-found/setup-incomplete (e.g. an unexpected S3
   * error). Logs the original error server-side but returns a stable,
   * generic message to the caller — the raw error can contain filesystem
   * paths or other infra details that shouldn't be forwarded verbatim as an
   * HTTP 500 body.
   */
  private errorResult(err: unknown): GameWriteResult {
    logger.error('Game server write failed', { error: errMessage(err) });
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

  // @spec RT-HEALTH-CRED-001, RT-HEALTH-CRED-005, RT-HEALTH-CRED-006, RT-HEALTH-NET-005
  // @spec RT-HEALTH-CRED-007, GAME-WRITE-004, GAME-WRITE-005
  /**
   * Resolves `config.healthCheck.auth` into the persisted `GameServerHealthCheckAuth` shape (`{ type?, secretArn }`),
   * performing the Secrets Manager upsert a `basic`/`bearer` credential requires and returning the deferred
   * {@link SecretChange} for the rest:
   *  - `auth` omitted → leave `before`'s credential unchanged.
   *  - `auth === null`, or `auth.type` `'raw'`/absent → the operator-supplied `secretArn` (if any) is used as-is, and
   *    `before`'s app-owned secret (`'basic'`/`'bearer'`) is deleted by `commit()` once the config write succeeded.
   *  - `auth.type` `'basic'`/`'bearer'` → builds the secret value (`JSON.stringify({ username, password })` or the raw
   *    `token`) and calls {@link upsertHealthCheckAuthSecret}, which creates the secret on first save and updates it
   *    in place afterwards. `rollback()` then undoes it: it restores the previous value read before the upsert, or
   *    deletes the secret when this save created it.
   *
   * @remarks
   * Must only be called after {@link previewResolvedHealthCheckAuth}'s structural preview has passed
   * `validateGameServer`. The caller must call `change.rollback()` on any later failure and `change.commit()` after
   * the config write succeeds, so a failed save leaves the app-owned secret as it was.
   *
   * @param gameId - The `game_servers` map key this entry is being saved under.
   * @param config - The proposed write-side config (may be `undefined` when the entry has no `healthCheck` at all).
   * @param before - The entry's prior persisted state, or `null` for a brand-new game.
   * @returns The persistable config and its {@link SecretChange}, or a modeled `error` result when Secrets Manager fails.
   */
  private async resolveHealthCheckAuthSecret(
    gameId: string,
    config: GameServerWriteConfig,
    before: GameServer | null,
  ): Promise<ResolvedHealthCheck> {
    const beforeAuth = before?.healthCheck?.auth;
    const ownedBefore = beforeAuth !== undefined && (beforeAuth.type === 'basic' || beforeAuth.type === 'bearer');
    const deleteOwnedOnCommit: SecretChange = {
      rollback: async () => undefined,
      commit: async () => {
        if (ownedBefore) {
          await this.deleteAppOwnedSecret(gameId, beforeAuth.secretArn);
        }
      },
    };

    if (!config.healthCheck) {
      return { config: { ...config, healthCheck: undefined }, change: deleteOwnedOnCommit };
    }

    const { auth, ...healthCheckRest } = config.healthCheck;

    if (auth === undefined) {
      return { config: { ...config, healthCheck: { ...healthCheckRest, auth: beforeAuth } }, change: NO_SECRET_CHANGE };
    }

    if (auth === null) {
      return { config: { ...config, healthCheck: { ...healthCheckRest, auth: undefined } }, change: deleteOwnedOnCommit };
    }

    const type = auth.type ?? 'raw';
    if (type === 'raw') {
      const rawAuth = { type: 'raw' as const, secretArn: auth.secretArn as string };
      return { config: { ...config, healthCheck: { ...healthCheckRest, auth: rawAuth } }, change: deleteOwnedOnCommit };
    }

    const secretValue = type === 'basic' ? JSON.stringify({ username: auth.username, password: auth.password }) : (auth.token as string);
    let previousValue: string | null = null;
    try {
      if (ownedBefore) {
        previousValue = await readHealthCheckAuthSecret(gameId);
      }
      const secretArn = await upsertHealthCheckAuthSecret(gameId, secretValue);
      const change: SecretChange = {
        rollback: () => this.restoreAppOwnedSecret(gameId, previousValue),
        commit: async () => undefined,
      };
      return { config: { ...config, healthCheck: { ...healthCheckRest, auth: { type, secretArn } } }, change };
    } catch (err) {
      const message = errMessage(err);
      logger.error('GamesWriteService.resolveHealthCheckAuthSecret: failed to create/update the health-check credential secret', {
        game: gameId,
        error: message,
      });
      return { failure: { ok: false, code: 'error', message: `Failed to save the health-check credential: ${message}` } };
    }
  }

  // @spec GAME-WRITE-004
  /**
   * Undoes an app-owned secret upsert after a failed config write: restores `previousValue` when a value was read
   * before the upsert, else deletes the secret this save created or revived. Logs, never throws.
   */
  private async restoreAppOwnedSecret(gameId: string, previousValue: string | null): Promise<void> {
    try {
      if (previousValue === null) {
        await deleteHealthCheckAuthSecret(gameId);
      } else {
        await upsertHealthCheckAuthSecret(gameId, previousValue);
      }
    } catch (err) {
      logger.error('GamesWriteService.resolveHealthCheckAuthSecret: failed to roll back the health-check credential secret', {
        game: gameId,
        error: errMessage(err),
      });
    }
  }

  // @spec RT-HEALTH-CRED-007
  /** Wraps {@link deleteHealthCheckAuthSecret}, logging (not throwing on) a Secrets Manager failure — a delete-cleanup failure must not block the config write it's tidying up after. */
  private async deleteAppOwnedSecret(gameId: string, secretArn: string): Promise<void> {
    try {
      await deleteHealthCheckAuthSecret(gameId);
    } catch (err) {
      const message = errMessage(err);
      logger.warn('GamesWriteService.resolveHealthCheckAuthSecret: failed to delete an orphaned health-check credential secret', {
        game: gameId,
        secretArn,
        error: message,
      });
    }
  }
}
