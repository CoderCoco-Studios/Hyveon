import { Module } from '@nestjs/common';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
  AwsAuditLogStore,
  AwsDiscordConfigStore,
  AwsRunRecordStore,
} from '@hyveon/cloud-aws';
import { resolvePreApplyRunsTableName } from '@hyveon/shared';
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  DiscordConfigStore,
  RunRecordStore,
} from '@hyveon/shared';
import { ConfigModule } from './config.module.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { ElectronStoreService } from '../services/ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from '../services/awsCredentialSource.js';
import type { AwsClientCredentials } from '../services/awsCredentialSource.js';
import { createAwsCloudProvider } from '../services/EcsService.js';
import {
  CLOUD_PROVIDER,
  SECRETS_STORE,
  REMOTE_FILE_STORE,
  DISCORD_RECEIVER,
  AUDIT_LOG_STORE,
  DISCORD_CONFIG_STORE,
  RUN_RECORD_STORE,
} from './cloud-provider.tokens.js';

/**
 * Per-cloud factories for the seven cloud-agnostic contracts (`CloudProvider`,
 * `SecretsStore`, `RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`,
 * `DiscordConfigStore`, `RunRecordStore` — all from `@hyveon/shared/cloud.js`).
 * Keyed by the `ActiveCloud` value `ConfigService` reports; each
 * `CloudBindings` entry supplies one factory per token so
 * {@link resolveCloudBindings} (and, in turn, `CloudProviderModule`'s
 * `useFactory` providers) can look up the right implementation without
 * duplicating the cloud switch seven times.
 */
export interface CloudBindings {
  cloudProvider: (config: ConfigService, store: ElectronStoreService) => CloudProvider;
  secretsStore: (config: ConfigService, store: ElectronStoreService) => SecretsStore;
  remoteFileStore: (config: ConfigService, store: ElectronStoreService) => RemoteFileStore;
  discordReceiver: (config: ConfigService) => DiscordEventReceiver;
  auditLogStore: (config: ConfigService, store: ElectronStoreService) => AuditLogStore;
  discordConfigStore: (config: ConfigService, store: ElectronStoreService) => DiscordConfigStore;
  /**
   * Takes `remoteFileStore` as a second argument (unlike every other
   * `CloudBindings` factory) because {@link resolveRunRecordStoreConfig}'s
   * pre-apply fallback needs it to read the persisted `DeploymentConfig`
   * directly — see that function's own doc comment.
   */
  runRecordStore: (config: ConfigService, remoteFileStore: RemoteFileStore, store: ElectronStoreService) => RunRecordStore;
}

/**
 * Resolves the `{ bucket, region }` config the AWS `RemoteFileStore`'s
 * `getConfig` callback needs: bucket from `ConfigService.getConfigurationBucket()`
 * (falls back to `''` so `AwsRemoteFileStore` surfaces its own "not configured"
 * error rather than this factory defaulting silently), region from `getRegion()`.
 * `credentials` comes from `resolveAwsClientCredentials(store)` — omitting it
 * left `S3Client` falling back to the SDK's default provider chain, which
 * resolves nothing in a GUI-launched Electron process. Exported standalone so
 * a unit test can exercise it without an `@aws-sdk/client-s3`-backed store.
 */
export function resolveDeploymentConfigFileStoreConfig(
  config: ConfigService,
  store: ElectronStoreService,
): { bucket: string; region: string; credentials: AwsClientCredentials; credentialsSignature: string } {
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    bucket: config.getConfigurationBucket() ?? '',
    region: config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Resolves the `{ tableName, region }` config the AWS `AuditLogStore`'s
 * `getConfig` callback needs: table name from `ConfigService.getStackOutputs()`'s
 * `auditTableName` (falls back to `''` when nothing is deployed yet, so
 * `AwsAuditLogStore` surfaces its own "not configured" error), region from
 * `outputs.awsRegion` once a stack is deployed — preferred over
 * `getRegion()`'s wizard-configured value because `DeploymentConfig.awsRegion`
 * is operator-edited and is the value actually provisioned into; nothing
 * keeps it in sync with the wizard's credentials-step region.
 *
 * Passed to `AwsAuditLogStore` as a lazy `getConfig` closure (not awaited by
 * the synchronous `useFactory` provider itself), so being `async` here costs
 * nothing extra. `credentials` comes from `resolveAwsClientCredentials(store)`
 * — see {@link resolveDeploymentConfigFileStoreConfig} for why it's required.
 */
export async function resolveAuditLogStoreConfig(
  config: ConfigService,
  store: ElectronStoreService,
): Promise<{ tableName: string; region: string; credentials: AwsClientCredentials; credentialsSignature: string }> {
  const outputs = await config.getStackOutputs();
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    tableName: outputs?.auditTableName ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Resolves the `{ tableName, region }` config the AWS `DiscordConfigStore`'s
 * `resolveConfig` callback needs to target the Discord DynamoDB table — same
 * `auditTableName`-style fallback and region-source reasoning as
 * {@link resolveAuditLogStoreConfig}. `credentials` comes from
 * `resolveAwsClientCredentials(store)`, per
 * {@link resolveDeploymentConfigFileStoreConfig}.
 */
export async function resolveDiscordConfigStoreConfig(
  config: ConfigService,
  store: ElectronStoreService,
): Promise<{ tableName: string; region: string; credentials: AwsClientCredentials; credentialsSignature: string }> {
  const outputs = await config.getStackOutputs();
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    tableName: outputs?.discordTableName ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Resolves the `{ tableName, bucket, region }` config the AWS `RunRecordStore`'s
 * `getConfig` callback needs. `tableName` comes from
 * `ConfigService.getStackOutputs()`'s `runsTableName`, falling back — only
 * when that's empty — to `resolvePreApplyRunsTableName(remoteFileStore)`
 * (`@hyveon/shared`), which reads the persisted `DeploymentConfig` directly
 * to compute the table's deterministic name without touching Pulumi.
 *
 * That fallback fixes a Critical bootstrap deadlock (see
 * `BootstrapService.ensureRunsTable`): `getStackOutputs()` only reports a
 * value after a stack's first successful `apply`, but the runs table is now
 * created via the AWS SDK at wizard-bootstrap time, before any apply has
 * run — without this fallback, `AwsRunRecordStore` would throw "not
 * configured" on every plan/apply of a fresh install even though the table
 * already exists.
 *
 * `remoteFileStore` is a second parameter (unlike every other field here,
 * not resolved via `config`) because it must be the SAME `RemoteFileStore`
 * singleton already bound to the configuration bucket — see
 * `CloudProviderModule`'s `RUN_RECORD_STORE` provider, which injects
 * `REMOTE_FILE_STORE` alongside `ConfigService` for exactly this purpose.
 *
 * Bucket/region/credentials resolution and the async/lazy-closure shape
 * follow {@link resolveAuditLogStoreConfig} and
 * {@link resolveDeploymentConfigFileStoreConfig}.
 */
export async function resolveRunRecordStoreConfig(
  config: ConfigService,
  remoteFileStore: RemoteFileStore,
  store: ElectronStoreService,
): Promise<{
  tableName: string;
  bucket: string;
  region: string;
  credentials: AwsClientCredentials;
  credentialsSignature: string;
}> {
  const outputs = await config.getStackOutputs();
  const tableName = outputs?.runsTableName || (await resolvePreApplyRunsTableName(remoteFileStore));
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    tableName: tableName ?? '',
    bucket: config.getConfigurationBucket() ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Registry of per-cloud bindings, keyed by `ActiveCloud` (or any future cloud
 * string). Today only `'aws'` is populated; adding a new cloud provider
 * package means adding an entry here rather than touching the module's
 * provider definitions. This is the seam a unit test can exercise directly
 * (via {@link resolveCloudBindings}) without bootstrapping Nest.
 */
export const CLOUD_BINDINGS: Record<string, CloudBindings> = {
  aws: {
    cloudProvider: (config, store) => createAwsCloudProvider(config, store),
    secretsStore: (config, store) =>
      new AwsSecretsStore(
        () => config.getRegion(),
        () => resolveAwsClientCredentialsWithSignature(store).credentials,
        () => resolveAwsClientCredentialsWithSignature(store).signature,
      ),
    remoteFileStore: (config, store) =>
      new AwsRemoteFileStore(() => resolveDeploymentConfigFileStoreConfig(config, store)),
    discordReceiver: () => new AwsDiscordEventReceiver(),
    auditLogStore: (config, store) => new AwsAuditLogStore(() => resolveAuditLogStoreConfig(config, store)),
    discordConfigStore: (config, store) =>
      new AwsDiscordConfigStore(() => resolveDiscordConfigStoreConfig(config, store)),
    runRecordStore: (config, remoteFileStore, store) =>
      new AwsRunRecordStore(() => resolveRunRecordStoreConfig(config, remoteFileStore, store)),
  },
};

/**
 * Pure resolver mapping `config.getActiveCloud()` to its {@link CloudBindings}
 * entry in {@link CLOUD_BINDINGS}, throwing for any cloud with no registered
 * bindings. Exported (rather than inlined per-factory) so it can be called
 * directly from tests without going through Nest's DI container.
 */
export function resolveCloudBindings(config: ConfigService): CloudBindings {
  const activeCloud = config.getActiveCloud();
  const bindings = CLOUD_BINDINGS[activeCloud];
  if (!bindings) {
    throw new Error(`Unsupported cloud provider: ${String(activeCloud)}`);
  }
  return bindings;
}

/**
 * Binds the seven cloud-agnostic contracts to concrete implementations for
 * whichever cloud `ConfigService.getActiveCloud()` reports as active, via
 * {@link resolveCloudBindings} and the {@link CLOUD_BINDINGS} registry. Today
 * that's always `'aws'`, so every token resolves to a `@hyveon/cloud-aws`
 * class; adding a non-AWS provider means adding an entry to `CLOUD_BINDINGS`,
 * not editing this module.
 *
 * Consuming services should inject via the token (e.g. `@Inject(CLOUD_PROVIDER)`)
 * and depend only on the corresponding `@hyveon/shared` interface, never on the
 * concrete AWS class — that's what keeps swapping the active cloud a one-module
 * change instead of a call-site hunt.
 *
 * `PulumiService.preview` resolves `REMOTE_FILE_STORE` from this module
 * lazily via a `ModuleRef.get()` strict-false lookup rather than a
 * constructor dependency — module-cycle rationale: see the canonical
 * explanation in {@link RunRecordModule}.
 */
@Module({
  imports: [ConfigModule, ElectronStoreModule],
  providers: [
    {
      provide: CLOUD_PROVIDER,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).cloudProvider(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: SECRETS_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).secretsStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: REMOTE_FILE_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).remoteFileStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: DISCORD_RECEIVER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).discordReceiver(config),
      inject: [ConfigService],
    },
    {
      provide: AUDIT_LOG_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).auditLogStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: DISCORD_CONFIG_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).discordConfigStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: RUN_RECORD_STORE,
      // Injects `REMOTE_FILE_STORE` too (an intra-module provider dependency
      // — both tokens are declared in THIS module's own `providers:`, so
      // this needs no `imports:` edge) for `resolveRunRecordStoreConfig`'s
      // pre-apply table-name fallback — see that function's own doc comment.
      useFactory: (config: ConfigService, remoteFileStore: RemoteFileStore, store: ElectronStoreService) =>
        resolveCloudBindings(config).runRecordStore(config, remoteFileStore, store),
      inject: [ConfigService, REMOTE_FILE_STORE, ElectronStoreService],
    },
  ],
  exports: [
    CLOUD_PROVIDER,
    SECRETS_STORE,
    REMOTE_FILE_STORE,
    DISCORD_RECEIVER,
    AUDIT_LOG_STORE,
    DISCORD_CONFIG_STORE,
    RUN_RECORD_STORE,
  ],
})
export class CloudProviderModule {}
