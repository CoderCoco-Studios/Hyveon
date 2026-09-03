import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditAction, AuditEntry, AuditLogStore, AuditPageResult, RedactedGameServer } from '@hyveon/shared';
import { resolveDefaultAwsRegion } from './awsRegionEnv.js';

/**
 * The single DynamoDB partition every audit entry lives under (`pk = AUDIT`).
 * The table's sort key (`sk`, see `buildAuditSk` in `@hyveon/shared/audit.js`)
 * is `<ISO timestamp>#<ULID>`, so a query scoped to this partition with
 * `ScanIndexForward: false` naturally returns entries newest-first.
 */
const PARTITION_KEY = 'AUDIT';

/**
 * AWS implementation of the cloud-agnostic {@link AuditLogStore} contract,
 * backed by the DynamoDB audit table declared in
 * `app/packages/infra/src/dynamodb.ts`'s `defineDynamoDb` (`pk = AUDIT`,
 * `sk` = `buildAuditSk()`). No `@aws-sdk/*` shapes appear outside this
 * class's private fields/method bodies, so callers depend only on
 * {@link AuditLogStore}.
 */
export class AwsAuditLogStore implements AuditLogStore {
  private client: DynamoDBDocumentClient | null = null;
  private clientCacheKey: string | null = null;

  /**
   * Resolves table/region/credentials for this store on every call, not once at construction —
   * the canonical statement of this pattern; `AwsRunRecordStore`, `AwsRemoteFileStore`,
   * `AwsSecretsStore`, and `AwsCloudProvider` cross-reference it rather than repeating it.
   *
   * @param getConfig - Resolved per call so a table rename (e.g. after a Pulumi apply) is picked
   *   up instead of sticking to a stale table. Optional so the class stays zero-arg constructible;
   *   omitted (or missing `tableName`) makes every method throw "table not configured" instead of
   *   sending a malformed request. May return a `Promise` — every real call site is already async,
   *   so awaiting it is free, and existing sync closures keep working unchanged. `credentialsSignature`
   *   is a cheap fingerprint of `credentials`; {@link getClient} keys its cache on it so a
   *   credentials rotation rebuilds the client rather than reusing a stale one.
   */
  constructor(
    private readonly getConfig?: () => (
      | {
          tableName: string;
          region?: string;
          credentials?: DynamoDBClientConfig['credentials'];
          credentialsSignature?: string;
        }
      | Promise<{
          tableName: string;
          region?: string;
          credentials?: DynamoDBClientConfig['credentials'];
          credentialsSignature?: string;
        }>
    ),
  ) {}

  /**
   * Resolves the configured table name, throwing a clear error instead of
   * letting an unconfigured table fall through to a malformed DynamoDB
   * request.
   */
  private async getTableName(): Promise<string> {
    const tableName = (await this.getConfig?.())?.tableName;
    if (!tableName) {
      throw new Error(
        'AwsAuditLogStore: table not configured. Supply a getConfig callback that resolves { tableName }.',
      );
    }
    return tableName;
  }

  /**
   * Lazily constructs the DynamoDB document client, recreating it whenever
   * the freshly-resolved region or credentials signature differs from what
   * the cached client was built with — mirrors `AwsSecretsStore.getClient`'s
   * rebuild-on-region-or-credentials-change pattern. Region defaults come
   * from the dedicated {@link resolveDefaultAwsRegion} environment accessor
   * rather than reading `process.env` inline.
   */
  private async getClient(): Promise<DynamoDBDocumentClient> {
    const config = await this.getConfig?.();
    const region = config?.region ?? resolveDefaultAwsRegion();
    const cacheKey = `${region}::${config?.credentialsSignature ?? ''}`;

    if (!this.client || this.clientCacheKey !== cacheKey) {
      this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials: config?.credentials }));
      this.clientCacheKey = cacheKey;
    }
    return this.client;
  }

  /**
   * Appends a single audit entry to the log.
   *
   * `before`/`after` are serialized to JSON strings before being written —
   * DynamoDB's native map type would work too, but a JSON string keeps the
   * item shape stable across `GameServer` schema changes and avoids
   * DynamoDB's empty-string/empty-set quirks on optional `GameServer`
   * fields.
   *
   * @param entry - The entry to persist, including its `sk` (see `buildAuditSk`).
   */
  async putEntry(entry: AuditEntry): Promise<void> {
    await (await this.getClient()).send(
      new PutCommand({
        TableName: await this.getTableName(),
        Item: {
          pk: PARTITION_KEY,
          sk: entry.sk,
          timestamp: entry.timestamp,
          actor: entry.actor,
          action: entry.action,
          game: entry.game,
          before: entry.before !== null ? JSON.stringify(entry.before) : null,
          after: entry.after !== null ? JSON.stringify(entry.after) : null,
          ...(entry.versionId !== undefined ? { versionId: entry.versionId } : {}),
        },
      }),
    );
  }

  /**
   * Lists audit entries newest-first, optionally paginated.
   *
   * Queries the `AUDIT` partition with `ScanIndexForward: false` so results
   * come back newest-first without an in-memory sort. When `before` is
   * supplied, the query is additionally constrained to `sk < :before` so
   * only entries older than the cursor are returned. `nextBefore` is only
   * populated when DynamoDB reports a `LastEvaluatedKey` — i.e. there are
   * more rows beyond this page — and is set to the oldest (last) entry's
   * `sk` in the page, matching what `LastEvaluatedKey.sk` would resolve to
   * for this single-partition query.
   *
   * @param limit  - The maximum number of entries to return.
   * @param before - When provided, only entries older than this cursor
   *   (an {@link AuditEntry.sk} value, typically taken from a prior page's
   *   `nextBefore`) are returned.
   * @returns The requested page of entries plus a cursor for the next page.
   */
  async listEntries(limit: number, before?: string): Promise<AuditPageResult> {
    const resp = await (await this.getClient()).send(
      new QueryCommand({
        TableName: await this.getTableName(),
        KeyConditionExpression: before ? 'pk = :pk AND sk < :before' : 'pk = :pk',
        ExpressionAttributeValues: before
          ? { ':pk': PARTITION_KEY, ':before': before }
          : { ':pk': PARTITION_KEY },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );

    const entries: AuditEntry[] = (resp.Items ?? []).map((item) => ({
      sk: item['sk'] as string,
      timestamp: item['timestamp'] as string,
      actor: item['actor'] as string,
      action: item['action'] as AuditAction,
      game: item['game'] as string,
      before: item['before'] ? (JSON.parse(item['before'] as string) as RedactedGameServer) : null,
      after: item['after'] ? (JSON.parse(item['after'] as string) as RedactedGameServer) : null,
      ...(item['versionId'] !== undefined ? { versionId: item['versionId'] as string } : {}),
    }));

    const nextBefore = resp.LastEvaluatedKey ? entries[entries.length - 1]?.sk : undefined;

    return nextBefore ? { entries, nextBefore } : { entries };
  }
}
