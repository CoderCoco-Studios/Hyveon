import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PendingInteraction } from '../types.js';
import { getDocClient } from './client.js';
// @spec DISCORD-SVC-004

/** TTL for pending interactions. Discord interaction tokens expire after 15 minutes. */
const PENDING_TTL_SECONDS = 15 * 60;

function pendingPk(taskArn: string): string {
  return `PENDING#${taskArn}`;
}

// @spec DISCORD-PEND-001, DISCORD-PEND-002
/** Write a pending-interaction row. `expiresAt` is set to now + 15m (epoch seconds for DDB TTL). */
export async function putPending(
  tableName: string,
  item: Omit<PendingInteraction, 'expiresAt'>,
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS;
  await getDocClient().send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: pendingPk(item.taskArn),
        sk: 'PENDING',
        data: { ...item, expiresAt },
        expiresAt,
        updatedAt: Date.now(),
      },
    }),
  );
}

// @spec DISCORD-PEND-003, DISCORD-PEND-004
/**
 * Point-lookup by task ARN; returns `null` if the row is absent or expired.
 *
 * The `expiresAt` check matters because DynamoDB's TTL sweeper can take up
 * to 48 hours to physically delete an expired row. The caller (update-dns)
 * would otherwise PATCH Discord with an interaction token that Discord has
 * already rejected as expired (15 minute cap), producing noisy errors for
 * no user benefit. Expired rows are best-effort deleted here so the next
 * read short-circuits even if TTL hasn't fired yet.
 */
export async function getPending(tableName: string, taskArn: string): Promise<PendingInteraction | null> {
  const resp = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: pendingPk(taskArn), sk: 'PENDING' },
      ConsistentRead: true,
    }),
  );
  const data = resp.Item?.['data'] as PendingInteraction | undefined;
  if (!data) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof data.expiresAt === 'number' && data.expiresAt <= nowSeconds) {
    // Fire-and-forget the cleanup; its failure mode is "row stays until TTL
    // sweeps it", which is already the fallback for any row we never read.
    void deletePending(tableName, taskArn).catch(() => undefined);
    return null;
  }
  return data;
}

/** Remove a pending-interaction row. Idempotent. */
export async function deletePending(tableName: string, taskArn: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: tableName,
      Key: { pk: pendingPk(taskArn), sk: 'PENDING' },
    }),
  );
}
