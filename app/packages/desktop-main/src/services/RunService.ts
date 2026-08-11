/**
 * Owns the single apply lock that guards Pulumi plan/apply/destroy
 * submissions (issue #106): only one non-terminal run may be in flight at a
 * time. Two layers cooperate:
 *
 * - An in-memory `RunLock` field, checked and optimistically set
 *   synchronously (before any `await`) at the top of {@link createRun} — this
 *   is what actually makes two "simultaneous" calls within this Node process
 *   race-free despite there being no real mutex primitive: JS runs a
 *   function's synchronous prologue to completion before yielding to any
 *   other queued call, so the second of two back-to-back `createRun()` calls
 *   always observes the first call's lock.
 * - The DynamoDB-backed apply lock item exposed via
 *   `RunRecordStore.acquireRunLock`/`getRunLock`/`releaseRunLock` (see
 *   `@hyveon/shared/cloud.js`), which makes the lock durable across app
 *   restarts and consistent if more than one desktop-main process is ever
 *   run against the same deploy. When `runsTableName` isn't in the
 *   Pulumi stack outputs yet (table not deployed — the same chicken-and-egg
 *   case `RunRecordService.persist`/`AuditService.record` guard against),
 *   the DynamoDB call is skipped entirely and the in-memory lock alone
 *   enforces exclusivity.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { isRunLockExpired, RunLockHeldError } from '@hyveon/shared';
import type { RunKind, RunLock, RunRecordStore } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { RUN_RECORD_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * How long an acquired {@link RunLock} remains valid, in milliseconds, before
 * {@link isRunLockExpired} treats it as stale even if the run that acquired
 * it never released it (e.g. the process crashed mid-run). One hour comfortably
 * covers the longest Pulumi apply this project's game-server stack is
 * expected to take, while still bounding how long a crashed run can wedge
 * the lock.
 */
export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000;

/**
 * How long a minted lock-clear confirmation token remains valid, in
 * milliseconds, before {@link RunService.assertFreshLockClearConfirmation}
 * treats it as expired — mirrors `PulumiService.LOCK_CLEAR_CONFIRMATION_TTL_MS`'s
 * value, defined independently since the two guard conceptually distinct
 * locks that only coincidentally share a window today.
 */
export const RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * Thrown by `RunService.clearLock` when it's called without a fresh, valid
 * confirmation token — mirrors `PulumiService`'s `LockClearNotConfirmedError`
 * exactly, for this lock's own clear-confirmation gate.
 */
export class RunLockClearNotConfirmedError extends Error {
  constructor() {
    super(
      'run lock clear refused: no fresh confirmation token was supplied, it has expired, or it no longer ' +
        'matches the currently held lock. Call RunService.mintLockClearConfirmationToken() and pass the ' +
        'returned token to clearLock() before it expires.',
    );
    this.name = 'RunLockClearNotConfirmedError';
  }
}

/**
 * Owns the apply lock guarding Pulumi plan/apply/destroy submissions.
 * See the file-level doc comment above for the in-memory + DynamoDB
 * two-layer contract.
 */
@Injectable()
export class RunService {
  /**
   * The lock currently held in this process, or `null` when no run is
   * in flight. Read/written synchronously outside of any `await` boundary
   * in {@link createRun}/{@link releaseRun} so it behaves as a mutex despite
   * being a plain field — see the file-level doc comment.
   */
  private currentLock: RunLock | null = null;

  /**
   * The most recently minted, not-yet-consumed lock-clear confirmation
   * token, or `null`. Bound to the `runId` that was current at mint time —
   * see {@link mintLockClearConfirmationToken}.
   */
  private pendingLockClearConfirmation: { token: string; runId: string; expiresAt: number } | null = null;

  /**
   * `store` is typed against the cloud-agnostic `RunRecordStore` contract
   * (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(RUN_RECORD_STORE)` tells Nest which concrete
   * provider (bound by `CloudProviderModule` for whichever cloud is active)
   * to resolve for that parameter, since interfaces don't survive to
   * runtime for Nest's reflection-based DI to key off of.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(RUN_RECORD_STORE) private readonly store: RunRecordStore,
  ) {}

  /**
   * Attempts to acquire the apply lock on behalf of a new Pulumi
   * plan/apply/destroy run and returns the acquired {@link RunLock}
   * (`runId` freshly minted via `randomUUID()`).
   *
   * Checks (and, if free, optimistically sets) the in-memory lock
   * synchronously before touching DynamoDB, so a second call issued before
   * this one's first `await` is rejected immediately rather than racing the
   * network call. If `runs_table_name` is configured, the lock is then
   * mirrored to the DynamoDB-backed apply lock item via
   * `RunRecordStore.acquireRunLock` — if that call rejects with a
   * `RunLockHeldError` (another process holds the durable lock), the
   * in-memory lock this call had provisionally set is rolled back and the
   * error is re-thrown. When `runs_table_name` isn't configured yet (table
   * not deployed), the DynamoDB call is skipped and the in-memory lock
   * alone enforces exclusivity.
   *
   * @param kind - Which Pulumi subcommand the caller is about to run.
   * @param initiator - Opaque identifier (e.g. username or API caller) of
   *   who is starting the run, surfaced to the UI as the current lock holder.
   * @param runId - Optional pre-minted run identifier to use instead of a
   *   freshly generated `randomUUID()`. Callers that already know the run's
   *   id (e.g. because they created the `RunRecord` row before acquiring the
   *   lock) can pass it here so the lock and the record share one id.
   * @returns The newly acquired {@link RunLock}.
   * @throws {@link RunLockHeldError} carrying the currently held lock when
   *   another non-terminal run already holds it, whether that lock was
   *   observed in-memory or in DynamoDB.
   */
  async createRun(kind: RunKind, initiator: string, runId?: string): Promise<RunLock> {
    logger.debug('RunService.createRun: acquiring apply lock', { kind, initiator });
    const now = new Date();
    if (this.currentLock !== null && !isRunLockExpired(this.currentLock, now)) {
      throw new RunLockHeldError(this.currentLock);
    }

    const lock: RunLock = {
      runId: runId ?? randomUUID(),
      kind,
      initiator,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEFAULT_LOCK_TTL_MS).toISOString(),
    };

    // Optimistically hold the in-memory lock synchronously (no `await` has
    // happened yet), so a concurrent caller sees it immediately.
    this.currentLock = lock;

    const tableName = (await this.config.getStackOutputs())?.runsTableName;
    if (tableName) {
      try {
        await this.store.acquireRunLock(lock);
      } catch (err) {
        if (this.currentLock?.runId === lock.runId) {
          this.currentLock = null;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('RunService.createRun: failed to acquire DynamoDB apply lock, rolling back in-memory lock', {
          runId: lock.runId,
          error: message,
        });
        throw err;
      }
    }

    return lock;
  }

  /**
   * Returns the lock currently held in this process, or `undefined` when no
   * run is in flight or the held lock has expired (see
   * `isRunLockExpired`) — an expired lock is treated as already released
   * even if {@link releaseRun} was never called for it.
   *
   * @returns The in-flight {@link RunLock}, or `undefined`.
   */
  getCurrentLock(): RunLock | undefined {
    if (this.currentLock !== null && !isRunLockExpired(this.currentLock)) {
      return this.currentLock;
    }
    return undefined;
  }

  /**
   * Releases the apply lock, scoped to `runId` so a caller can never release
   * a lock it doesn't itself hold. Clears the in-memory lock first (only if
   * it's still held by `runId`), then, when `runs_table_name` is configured,
   * releases the DynamoDB-backed lock item via `RunRecordStore.releaseRunLock`
   * — both layers no-op rather than throw when `runId` doesn't match the
   * currently held lock.
   *
   * @param runId - The `runId` of the run releasing the lock (matches
   *   {@link RunLock.runId}).
   */
  async releaseRun(runId: string): Promise<void> {
    logger.debug('RunService.releaseRun: releasing apply lock', { runId });
    if (this.currentLock?.runId === runId) {
      this.currentLock = null;
    }

    const tableName = (await this.config.getStackOutputs())?.runsTableName;
    if (tableName) {
      try {
        await this.store.releaseRunLock(runId);
      } catch (err) {
        // Never rethrow: RunRecordService.persist() releases the lock from a
        // `finally` block and must never throw itself. A transient DynamoDB
        // error here is safe to swallow — the lock self-heals once
        // `expiresAt` passes (see `isRunLockExpired`).
        logger.warn('RunService.releaseRun: failed to release DynamoDB apply lock, relying on TTL self-heal', {
          err,
          runId,
        });
      }
    }
  }

  /**
   * Mints a fresh, single-use confirmation token for a subsequent
   * {@link clearLock} call, bound to the `runId` of the lock currently held
   * — mirrors `PulumiService.mintLockClearConfirmationToken`'s mint/confirm
   * pattern, extended with a durable fallback this lock's cross-process
   * nature requires. Minting a new token immediately supersedes any
   * previously minted, unconsumed one.
   *
   * Prefers {@link getCurrentLock} (in-memory, no I/O). Falls back to
   * `RunRecordStore.getRunLock()` (the durable DynamoDB read, skipped when
   * `runs_table_name` isn't configured) when the in-memory field is empty —
   * covering the case where this process lost the lock race to another
   * process (its own provisional in-memory lock was already rolled back by
   * {@link createRun}) or was restarted since the lock was acquired
   * elsewhere. Either way the operator is reacting to a `RunLockHeldError`
   * ack that already told them a lock is held; minting must be able to
   * confirm and bind to it.
   *
   * @returns The minted token.
   * @throws A plain `Error` if no run lock is currently held — in-memory or
   *   durable — nothing to mint a clear-confirmation for.
   */
  async mintLockClearConfirmationToken(): Promise<string> {
    let lock = this.getCurrentLock();
    if (!lock) {
      try {
        const tableName = (await this.config.getStackOutputs())?.runsTableName;
        if (tableName) {
          lock = await this.store.getRunLock();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('RunService.mintLockClearConfirmationToken: failed to read DynamoDB apply lock', {
          error: message,
        });
      }
    }
    if (!lock) {
      throw new Error('Cannot mint a lock-clear confirmation token: no run lock is currently held.');
    }
    const token = randomUUID();
    this.pendingLockClearConfirmation = {
      token,
      runId: lock.runId,
      expiresAt: Date.now() + RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS,
    };
    return token;
  }

  /**
   * Throws {@link RunLockClearNotConfirmedError} unless `token` matches the
   * most recently minted, not-yet-expired, not-yet-consumed confirmation
   * token AND the lock it was bound to (by `runId`) is still the one
   * currently held — i.e. no different run has acquired the lock since the
   * token was minted. On success, consumes the token (clears
   * {@link pendingLockClearConfirmation}) and returns the bound `runId`.
   *
   * Unlike `PulumiService.assertFreshLockClearConfirmation` this is `async`:
   * the "still current" check must consult the same durable fallback
   * {@link mintLockClearConfirmationToken} used to bind the token in the
   * first place (see Task 2), or a token minted from a durable-only lock
   * (this process has no matching in-memory field) would always fail here.
   * The two awaits this adds (`getStackOutputs()`, `store.getRunLock()`) are
   * both read-only and idempotent, so no double-release risk is introduced.
   * Mirrors {@link mintLockClearConfirmationToken}'s handling of a rejected
   * durable read: caught, logged via `logger.warn`, and treated as no lock
   * found rather than letting the raw error escape.
   *
   * @param token - The token to validate, as returned by
   *   {@link mintLockClearConfirmationToken}.
   * @returns The `runId` the (now-consumed) token was bound to.
   * @throws {@link RunLockClearNotConfirmedError} if `token` is missing,
   *   wrong, expired, or bound to a `runId` the currently held lock (checked
   *   in-memory, then durably) no longer matches.
   */
  private async assertFreshLockClearConfirmation(token: string): Promise<string> {
    const pending = this.pendingLockClearConfirmation;
    let current = this.getCurrentLock();
    if (!current) {
      try {
        const tableName = (await this.config.getStackOutputs())?.runsTableName;
        if (tableName) {
          current = await this.store.getRunLock();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('RunService.assertFreshLockClearConfirmation: failed to read DynamoDB apply lock', {
          error: message,
        });
      }
    }
    if (
      !pending ||
      pending.token !== token ||
      Date.now() > pending.expiresAt ||
      !current ||
      current.runId !== pending.runId
    ) {
      throw new RunLockClearNotConfirmedError();
    }
    this.pendingLockClearConfirmation = null;
    return pending.runId;
  }

  /**
   * Clears the run lock currently held, gated behind a fresh confirmation
   * token minted via {@link mintLockClearConfirmationToken} — an operator
   * recovery path for a lock a crashed/abandoned run left standing past what
   * its holder intended, without waiting for {@link DEFAULT_LOCK_TTL_MS} to
   * elapse. Delegates to the existing {@link releaseRun} once the token is
   * validated; introduces no new release semantics.
   *
   * @param token - The confirmation token to validate.
   * @throws {@link RunLockClearNotConfirmedError} if `token` is missing,
   *   wrong, expired, or no longer bound to the currently held lock (a
   *   different run has since acquired it).
   */
  async clearLock(token: string): Promise<void> {
    logger.debug('RunService.clearLock: clearing confirmed-stale run lock');
    const runId = await this.assertFreshLockClearConfirmation(token);
    await this.releaseRun(runId);
    logger.warn('run lock cleared by explicit operator confirmation (unrecognized-lock recovery)', { runId });
  }
}
