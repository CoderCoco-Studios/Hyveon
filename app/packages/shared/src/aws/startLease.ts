/** How long a start lease blocks a second start for the same game, in seconds. */
export const START_LEASE_TTL_SECONDS = 120;

/** Structural subset of a DynamoDB `PutItem` request; satisfied by lib-dynamodb's `PutCommandInput`. */
export interface StartLeasePutInput {
  TableName: string;
  Item: Record<string, unknown>;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/**
 * Performs one `PutItem`, rejecting with the SDK error (`name === 'ConditionalCheckFailedException'` on a failed
 * condition). Callers adapt their own credentialed document client, e.g. `(i) => doc.send(new PutCommand(i))`, which
 * keeps this module free of any AWS SDK import (see `ecsTask.ts`).
 */
export type StartLeasePut = (input: StartLeasePutInput) => Promise<unknown>;

/** Operator-facing refusal when another start holds the lease; shared so the desktop and Discord copy cannot drift. */
export function startInProgressMessage(game: string): string {
  return `A start for ${game} is already in progress.`;
}

/** Outcome of {@link startWithLease}. */
export type StartWithLeaseOutcome<T> =
  | { status: 'started'; value: T }
  | { status: 'in-progress' }
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

function leaseKey(game: string): { pk: string; sk: string } {
  return { pk: `LAUNCH#${game}`, sk: 'LOCK' };
}

function isConditionFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
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
 * Acquires `LAUNCH#{game}/LOCK` with a conditional put (absent or expired), then re-checks for a running task, then
 * launches with the lease id as the ECS `clientToken`. The lease is left to expire after a successful launch and
 * released only when the pre-check refuses or the launch fails. Any DynamoDB or pre-check error propagates, so the
 * start fails closed. Expiry is judged against each caller's own clock, so cross-machine skew of a few seconds is
 * tolerated by the 120 s TTL. Not watchdog state: it lives in DynamoDB, not in ECS task tags.
 *
 * @typeParam T - Value the launch callback produces (e.g. a task ARN).
 * @param opts - Lease table, game, strict pre-check and launch callbacks.
 * @returns `started` with the launch value, `in-progress` when another start holds the lease, or `already-running`.
 * @throws Whatever the lease write, pre-check or launch throws.
 */
export async function startWithLease<T>(opts: StartWithLeaseOptions<T>): Promise<StartWithLeaseOutcome<T>> {
  const { put, tableName, game } = opts;
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const leaseId = globalThis.crypto.randomUUID();

  try {
    await put({
      TableName: tableName,
      Item: { ...leaseKey(game), leaseId, expiresAt: nowSeconds + START_LEASE_TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowSeconds },
    });
  } catch (err) {
    if (isConditionFailure(err)) return { status: 'in-progress' };
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
