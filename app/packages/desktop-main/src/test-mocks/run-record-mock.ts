import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** Partition/sort key of the single apply-lock item — mirrors `AwsRunRecordStore`'s `LOCK_PK`/`LOCK_SK`. */
const LOCK_PK = 'LOCK';
const LOCK_SK = 'CURRENT';

/**
 * In-memory backing store for the run-record DynamoDB mock installed by
 * {@link installRunRecordDynamoMock} — holds every `pk = RUN` item
 * `AwsRunRecordStore.putRecord` has written, plus the single `pk = LOCK`
 * apply-lock item `RunService`/`AwsRunRecordStore` read/write, closely
 * enough mirroring `AwsRunRecordStore`'s two DynamoDB item shapes that
 * `RunRecordService`/`RunService` operate against it unmodified.
 *
 * Exposed separately from the SDK interceptor (mirrors `mock-store.ts`'s
 * split from `ecs-mock.ts`) so integration specs can directly patch a stored
 * record's `approvedAt` to simulate an expired approval without fake timers.
 */
class RunRecordMockStore {
  private items: Record<string, unknown>[] = [];
  private lockItem: Record<string, unknown> | null = null;

  /** Upserts a `pk = RUN` item by its `sk`, mirroring DynamoDB `PutItem`'s overwrite semantics. */
  putItem(item: Record<string, unknown>): void {
    const sk = item['sk'] as string;
    const idx = this.items.findIndex((i) => i['sk'] === sk);
    if (idx >= 0) {
      this.items[idx] = item;
    } else {
      this.items.push(item);
    }
  }

  /** Returns every stored `pk = RUN` item, newest-`sk`-first (mirrors `ScanIndexForward: false`). */
  query(): Record<string, unknown>[] {
    return [...this.items].sort((a, b) => (b['sk'] as string).localeCompare(a['sk'] as string));
  }

  /** Finds the newest stored item for `runId`, or `undefined` if none exists — used by {@link patchApprovedAt}. */
  findByRunId(runId: string): Record<string, unknown> | undefined {
    return this.query().find((i) => i['runId'] === runId);
  }

  /**
   * Directly overwrites the `approvedAt` field of the stored item for
   * `runId` — lets a spec simulate an approval minted outside the 15-minute
   * apply window without relying on fake timers.
   */
  patchApprovedAt(runId: string, approvedAt: string): void {
    const item = this.findByRunId(runId);
    if (item) {
      item['approvedAt'] = approvedAt;
    }
  }

  getLock(): Record<string, unknown> | null {
    return this.lockItem;
  }

  /**
   * Applies `AwsRunRecordStore.acquireRunLock`'s conditional-put semantics:
   * succeeds (replacing the lock) when no lock is held or the held lock's
   * `expiresAt` is before `now`; otherwise throws
   * {@link ConditionalCheckFailedException}, mirroring the real condition
   * expression `attribute_not_exists(pk) OR expiresAt < :now`.
   */
  putLockIfFree(item: Record<string, unknown>, now: string): void {
    const expiresAt = this.lockItem?.['expiresAt'] as string | undefined;
    const isFree = this.lockItem === null || (expiresAt !== undefined && expiresAt < now);
    if (!isFree) {
      throw new ConditionalCheckFailedException({ message: 'ConditionalCheckFailed', $metadata: {} });
    }
    this.lockItem = item;
  }

  /** Applies `AwsRunRecordStore.releaseRunLock`'s scoped-delete semantics: no-ops unless `runId` owns the held lock. */
  deleteLockIfOwned(runId: string): void {
    if (this.lockItem?.['runId'] === runId) {
      this.lockItem = null;
    }
  }

  /** Clears every stored item and the lock — called between specs so state never leaks across the `ipc` harness's fresh app contexts. */
  reset(): void {
    this.items = [];
    this.lockItem = null;
  }
}

/**
 * Shared backing store for {@link installRunRecordDynamoMock}'s interceptors.
 * Integration specs reach for this directly (e.g. `runRecordMockStore.patchApprovedAt(...)`)
 * to seed state the real `TerraformController.approve` flow can't produce on
 * its own — see {@link RunRecordMockStore.patchApprovedAt}.
 */
export const runRecordMockStore = new RunRecordMockStore();

/**
 * Installs `aws-sdk-client-mock` interceptors on the `DynamoDBDocumentClient`
 * prototype, wired to the shared {@link runRecordMockStore} — the run-record
 * counterpart of `ecs-mock.ts`'s `installEcsMock`. Unlike the ECS mock's FIFO
 * queues, this backs a stateful table: `AwsRunRecordStore.putRecord`/
 * `getRecordByRunId` and `RunService`'s `acquireRunLock`/`releaseRunLock`
 * calls all operate against the same in-memory item set, so a plan run
 * persisted via `TerraformService.plan` is genuinely retrievable by a
 * subsequent `TerraformController.approve`/`apply` call in the same spec.
 *
 * `AwsRunRecordStore` builds its `DynamoDBDocumentClient` lazily (on first
 * `send()` call), so patching the *prototype* is sufficient — this only
 * needs to run once, before the first call anywhere in the process.
 *
 * @returns the `aws-sdk-client-mock` stub. Specs rarely need it directly
 * since all queued state routes through {@link runRecordMockStore}, but it's
 * returned so callers can `.reset()` the interceptor itself if ever needed.
 */
export function installRunRecordDynamoMock(): AwsClientStub<DynamoDBDocumentClient> {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  ddbMock.on(PutCommand).callsFake(async (input) => {
    const item = (input.Item ?? {}) as Record<string, unknown>;
    if (item['pk'] === LOCK_PK) {
      const now = (input.ExpressionAttributeValues?.[':now'] as string | undefined) ?? new Date().toISOString();
      runRecordMockStore.putLockIfFree(item, now);
      return {};
    }
    runRecordMockStore.putItem(item);
    return {};
  });

  ddbMock.on(GetCommand).callsFake(async (input) => {
    const key = input.Key as Record<string, unknown> | undefined;
    if (key?.['pk'] === LOCK_PK && key?.['sk'] === LOCK_SK) {
      return { Item: runRecordMockStore.getLock() ?? undefined };
    }
    return { Item: undefined };
  });

  ddbMock.on(DeleteCommand).callsFake(async (input) => {
    const runId = input.ExpressionAttributeValues?.[':runId'] as string | undefined;
    if (runId) {
      runRecordMockStore.deleteLockIfOwned(runId);
    }
    return {};
  });

  ddbMock.on(QueryCommand).callsFake(async (input) => {
    let items = runRecordMockStore.query();

    const runId = input.ExpressionAttributeValues?.[':runId'] as string | undefined;
    if (runId) {
      items = items.filter((i) => i['runId'] === runId);
    }
    const before = input.ExpressionAttributeValues?.[':before'] as string | undefined;
    if (before) {
      items = items.filter((i) => (i['sk'] as string) < before);
    }
    const status = input.ExpressionAttributeValues?.[':status'] as string | undefined;
    if (status) {
      items = items.filter((i) => i['status'] === status);
    }
    if (typeof input.Limit === 'number') {
      items = items.slice(0, input.Limit);
    }

    return { Items: items };
  });

  return ddbMock;
}
