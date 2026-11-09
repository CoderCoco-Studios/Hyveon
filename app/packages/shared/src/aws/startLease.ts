/** How long a start lease blocks a second start for the same game, in seconds. */
export const START_LEASE_TTL_SECONDS = 120;

/** Structural subset of a DynamoDB `PutItem` request; satisfied by lib-dynamodb's `PutCommandInput`. */
export interface StartLeasePutInput {
  TableName: string;
  Item: Record<string, unknown>;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  /** Asks DynamoDB to attach the existing row to a condition failure, so a refused caller can read who holds the lease. */
  ReturnValuesOnConditionCheckFailure?: 'ALL_OLD' | 'NONE';
}

/**
 * Performs one `PutItem`, rejecting with the SDK error (`name === 'ConditionalCheckFailedException'` on a failed
 * condition). Callers adapt their own credentialed document client, e.g. `(i) => doc.send(new PutCommand(i))`, which
 * keeps this module free of any AWS SDK import (see `ecsTask.ts`).
 */
export type StartLeasePut = (input: StartLeasePutInput) => Promise<unknown>;

/** Who owns a lease row: a game start (also the reading of a row written before holders existed) or a file upload. */
export type LeaseHolder = 'start' | 'upload';

/** Operator-facing refusal when another start holds the lease; shared so the desktop and Discord copy cannot drift. */
export function startInProgressMessage(game: string): string {
  return `A start for ${game} is already in progress.`;
}

/** Operator-facing refusal when an upload holds the lease; shared so the desktop and Discord copy cannot drift. */
export function uploadInProgressMessage(game: string): string {
  return `An upload into ${game} is in progress. Wait for it to finish or cancel it, then start the server.`;
}

/**
 * Picks the refusal copy for a lease held by `holder`.
 *
 * @param game - Game whose start was refused.
 * @param holder - Who holds the lease.
 * @returns The operator-facing message.
 */
export function leaseBusyMessage(game: string, holder: LeaseHolder): string {
  return holder === 'upload' ? uploadInProgressMessage(game) : startInProgressMessage(game);
}

/** Outcome of {@link startWithLease}. */
export type StartWithLeaseOutcome<T> =
  | { status: 'started'; value: T }
  | { status: 'in-progress'; holder: LeaseHolder }
  | { status: 'already-running' };

/** Inputs to {@link startWithLease}. */
export interface StartWithLeaseOptions<T> {
  /** Performs the lease writes. */
  put: StartLeasePut;
  /** Discord single-table name (`TABLE_NAME` in Lambdas, `outputs.discordTableName` on the desktop). */
  tableName: string;
  /** Game being started. */
  game: string;
  /** Clock override for tests; epoch milliseconds. */
  now?: () => number;
  /** Strict pre-check: resolves whether a non-stopped task exists. Must throw on error so the start fails closed. */
  findRunning: () => Promise<boolean>;
  /** Runs `RunTask` with the given idempotency `clientToken`; `launched: false` means ECS refused and the lease is released. */
  launch: (clientToken: string) => Promise<{ launched: boolean; value: T }>;
}

/** Key of `game`'s lease row, shared by start leases and upload leases. */
export function leaseKey(game: string): { pk: string; sk: string } {
  return { pk: `LAUNCH#${game}`, sk: 'LOCK' };
}

/** Whether `err` is the SDK's failed-condition error. */
export function isConditionFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/** Condition shared by every lease acquisition: no row, or one whose `expiresAt` has passed. */
export const LEASE_FREE_CONDITION = 'attribute_not_exists(pk) OR expiresAt < :now';

/**
 * Reads the holder off a condition failure's returned row, accepting both the plain and the DynamoDB-JSON
 * (`{ S: 'upload' }`) shapes; a row without a holder, or no row at all, reads as `start`.
 *
 * @param err - The condition failure.
 * @returns Who held the lease.
 */
export function holderFromConditionFailure(err: unknown): LeaseHolder {
  const holder = (err as { Item?: { holder?: unknown } } | null)?.Item?.holder;
  const value = typeof holder === 'object' && holder !== null ? (holder as { S?: unknown }).S : holder;
  return value === 'upload' ? 'upload' : 'start';
}

/** Best-effort release: an unconditional put of an already-expired lease, so no `DeleteItem` permission is needed. */
async function releaseLease(put: StartLeasePut, tableName: string, game: string): Promise<void> {
  try {
    await put({ TableName: tableName, Item: { ...leaseKey(game), expiresAt: 0 } });
  } catch {
    // The lease expires on its own within START_LEASE_TTL_SECONDS.
  }
}

// @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
/**
 * Runs a game start under a cross-process DynamoDB lease so a desktop Start and a Discord `/server-start` launch at most
 * one task.
 *
 * @remarks
 * Acquires `LAUNCH#{game}/LOCK` with a conditional put (absent or expired) as holder `start`, then re-checks for a running task, then
 * launches with the lease id as the ECS `clientToken`. The lease is left to expire after a successful launch and
 * released only when the pre-check refuses or the launch fails. Any DynamoDB or pre-check error propagates, so the
 * start fails closed. Expiry is judged against each caller's own clock, so cross-machine skew of a few seconds is
 * tolerated by the 120 s TTL. Not watchdog state: it lives in DynamoDB, not in ECS task tags.
 *
 * @typeParam T - Value the launch callback produces (e.g. a task ARN).
 * @param opts - Lease table, game, strict pre-check and launch callbacks.
 * @returns `started` with the launch value, `in-progress` (with the holder: another start, or an upload) when the lease is held, or `already-running`.
 * @throws Whatever the lease write, pre-check or launch throws.
 */
export async function startWithLease<T>(opts: StartWithLeaseOptions<T>): Promise<StartWithLeaseOutcome<T>> {
  const { put, tableName, game } = opts;
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const leaseId = globalThis.crypto.randomUUID();

  try {
    await put({
      TableName: tableName,
      Item: { ...leaseKey(game), leaseId, holder: 'start', expiresAt: nowSeconds + START_LEASE_TTL_SECONDS },
      ConditionExpression: LEASE_FREE_CONDITION,
      ExpressionAttributeValues: { ':now': nowSeconds },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  } catch (err) {
    if (isConditionFailure(err)) return { status: 'in-progress', holder: holderFromConditionFailure(err) };
    throw err;
  }

  try {
    if (await opts.findRunning()) {
      await releaseLease(put, tableName, game);
      return { status: 'already-running' };
    }
    const { launched, value } = await opts.launch(leaseId);
    if (!launched) await releaseLease(put, tableName, game);
    return { status: 'started', value };
  } catch (err) {
    await releaseLease(put, tableName, game);
    throw err;
  }
}

/** How often a held upload lease is renewed, in milliseconds; four renewals fit in {@link START_LEASE_TTL_SECONDS}. */
export const UPLOAD_LEASE_HEARTBEAT_MS = 30_000;

/** Inputs shared by the upload-lease operations. */
export interface UploadLeaseOptions {
  /** Performs the lease writes. */
  put: StartLeasePut;
  /** Discord single-table name. */
  tableName: string;
  /** Game whose volume is being written. */
  game: string;
  /** Clock override for tests; epoch milliseconds. */
  now?: () => number;
}

/** Outcome of {@link acquireUploadLease}. */
export type UploadLeaseAcquireOutcome = { status: 'acquired'; leaseId: string } | { status: 'busy'; holder: LeaseHolder };

const secondsOf = (now?: () => number): number => Math.floor((now ?? Date.now)() / 1000);

// @spec HELPER-FB-042, HELPER-FB-045
/**
 * Takes `game`'s lease as holder `upload` so a start from any process is refused while files are being written.
 *
 * @remarks
 * Same row and free-condition as {@link startWithLease}, so a start and an upload can never both hold it. Renew it
 * with {@link renewUploadLease} inside {@link START_LEASE_TTL_SECONDS}; a holder that crashes frees it when the TTL
 * lapses. Any error other than a failed condition propagates, so callers fail closed.
 *
 * @param opts - Lease table, game and writer.
 * @returns `acquired` with the lease id, or `busy` with who holds the lease.
 * @throws Whatever the lease write throws.
 */
export async function acquireUploadLease(opts: UploadLeaseOptions): Promise<UploadLeaseAcquireOutcome> {
  const nowSeconds = secondsOf(opts.now);
  const leaseId = globalThis.crypto.randomUUID();
  try {
    await opts.put({
      TableName: opts.tableName,
      Item: { ...leaseKey(opts.game), leaseId, holder: 'upload', expiresAt: nowSeconds + START_LEASE_TTL_SECONDS },
      ConditionExpression: LEASE_FREE_CONDITION,
      ExpressionAttributeValues: { ':now': nowSeconds },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  } catch (err) {
    if (isConditionFailure(err)) return { status: 'busy', holder: holderFromConditionFailure(err) };
    throw err;
  }
  return { status: 'acquired', leaseId };
}

// @spec HELPER-FB-044, HELPER-FB-046
/**
 * Extends an upload lease this process holds by another {@link START_LEASE_TTL_SECONDS}.
 *
 * @param opts - Lease table, game and writer.
 * @param leaseId - The id {@link acquireUploadLease} returned.
 * @returns `renewed`, or `lost` when the row no longer carries `leaseId` (another holder took it after a lapse).
 * @throws Whatever the lease write throws other than a failed condition, so callers can tell a lost lease from an outage.
 */
export async function renewUploadLease(opts: UploadLeaseOptions, leaseId: string): Promise<'renewed' | 'lost'> {
  const nowSeconds = secondsOf(opts.now);
  try {
    await opts.put({
      TableName: opts.tableName,
      Item: { ...leaseKey(opts.game), leaseId, holder: 'upload', expiresAt: nowSeconds + START_LEASE_TTL_SECONDS },
      ConditionExpression: 'leaseId = :id',
      ExpressionAttributeValues: { ':id': leaseId },
    });
  } catch (err) {
    if (isConditionFailure(err)) return 'lost';
    throw err;
  }
  return 'renewed';
}

// @spec HELPER-FB-043
/**
 * Best-effort release of an upload lease: writes it already expired, only while it still carries `leaseId`, so a lease
 * another holder took after a lapse is never cleared. Never throws; an unreleased lease lapses within the TTL.
 *
 * @param opts - Lease table, game and writer.
 * @param leaseId - The id {@link acquireUploadLease} returned.
 */
export async function releaseUploadLease(opts: UploadLeaseOptions, leaseId: string): Promise<void> {
  try {
    await opts.put({
      TableName: opts.tableName,
      Item: { ...leaseKey(opts.game), leaseId, holder: 'upload', expiresAt: 0 },
      ConditionExpression: 'leaseId = :id',
      ExpressionAttributeValues: { ':id': leaseId },
    });
  } catch {
    // Lost or unreachable: the lease expires on its own within START_LEASE_TTL_SECONDS.
  }
}
