import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  getBaseDiscordConfig,
  getDiscordConfig,
  putDiscordConfig,
  type BaseDiscordConfig,
  type DiscordConfig,
  type DiscordConfigStore,
} from '@hyveon/shared';
import { resolveDefaultAwsRegion } from './awsRegionEnv.js';
import { createCachedAwsClient } from './cachedClient.js';

/** {@link AwsDiscordConfigStore}'s `resolveConfig` callback return shape. */
export interface AwsDiscordConfigStoreConfig {
  tableName: string;
  region?: string;
  credentials?: DynamoDBClientConfig['credentials'];
  credentialsSignature?: string;
}

/**
 * AWS implementation of the cloud-agnostic {@link DiscordConfigStore}
 * contract, backed by the DynamoDB table declared in
 * `app/packages/infra/src/dynamodb.ts` and the read/write logic already in
 * `@hyveon/shared/ddb/configStore.js`. This class's only job is to supply
 * those functions with a `DynamoDBDocumentClient` built from the caller's
 * resolved credentials — see {@link getClient}'s doc comment for why that
 * can't be left to `@hyveon/shared`'s default `getDocClient()`. No
 * `@aws-sdk/*` shapes appear outside this class's private fields/method
 * bodies, so callers depend only on {@link DiscordConfigStore}.
 */
export class AwsDiscordConfigStore implements DiscordConfigStore {
  private readonly getCachedClient = createCachedAwsClient(
    (config: { region: string; credentials?: DynamoDBClientConfig['credentials']; credentialsSignature?: string }) =>
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region, credentials: config.credentials })),
  );

  /**
   * @param resolveConfig - Resolves the DynamoDB table (and optional region /
   *   credentials) this store reads/writes, on every call — mirrors
   *   `AwsAuditLogStore`'s `getConfig` callback, including the "may return a
   *   `Promise`" and "omitted `region` falls back to
   *   {@link resolveDefaultAwsRegion}" behavior. Optional so the class
   *   remains constructible with no arguments. When omitted (or when it
   *   returns no `tableName`), every method throws a clear "table not
   *   configured" error.
   */
  constructor(
    private readonly resolveConfig?: () => AwsDiscordConfigStoreConfig | Promise<AwsDiscordConfigStoreConfig>,
  ) {}

  /**
   * Resolves the configured table name, throwing a clear error instead of
   * letting an unconfigured table fall through to a malformed DynamoDB
   * request.
   */
  private async getTableName(): Promise<string> {
    const tableName = (await this.resolveConfig?.())?.tableName;
    if (!tableName) {
      throw new Error(
        'AwsDiscordConfigStore: table not configured. Supply a resolveConfig callback that resolves { tableName }.',
      );
    }
    return tableName;
  }

  /**
   * Lazily constructs the DynamoDB document client, recreating it whenever
   * the freshly-resolved region or credentials signature differs from what
   * the cached client was built with — mirrors `AwsAuditLogStore.getClient`'s
   * rebuild-on-region-or-credentials-change pattern. Supplying `credentials`
   * here (via the caller's `resolveConfig`) is the fix for a real bug:
   * omitting it left every Discord config read/write falling back to the AWS
   * SDK's default provider chain, which resolves nothing in a GUI-launched
   * Electron process (the desktop app's credentials live encrypted in its
   * own store, never in env vars or `~/.aws`) and threw a spurious
   * `CredentialsProviderError` ("Your session has expired") whenever an
   * unrelated ambient `aws login` session on the host expired.
   */
  private async getClient(): Promise<DynamoDBDocumentClient> {
    const config = await this.resolveConfig?.();
    const region = config?.region ?? resolveDefaultAwsRegion();
    return this.getCachedClient({ region, credentials: config?.credentials, credentialsSignature: config?.credentialsSignature });
  }

  /** Read the app-managed dynamic config row. */
  async getConfig(): Promise<DiscordConfig> {
    return getDiscordConfig(await this.getTableName(), await this.getClient());
  }

  /** Read the Pulumi-managed base allowlist/admins row. */
  async getBaseConfig(): Promise<BaseDiscordConfig> {
    return getBaseDiscordConfig(await this.getTableName(), await this.getClient());
  }

  /** Overwrite the app-managed dynamic config row. */
  async putConfig(cfg: DiscordConfig): Promise<void> {
    await putDiscordConfig(await this.getTableName(), cfg, await this.getClient());
  }
}
