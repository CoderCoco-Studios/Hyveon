import { Module } from '@nestjs/common';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
  AwsAuditLogStore,
  AwsRunRecordStore,
} from '@hyveon/cloud-aws';
import { resolvePreApplyRunsTableName } from '@hyveon/shared';
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  RunRecordStore,
} from '@hyveon/shared';
import { ConfigModule } from './config.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { createAwsCloudProvider } from '../services/EcsService.js';
import {
  CLOUD_PROVIDER,
  SECRETS_STORE,
  REMOTE_FILE_STORE,
  DISCORD_RECEIVER,
  AUDIT_LOG_STORE,
  RUN_RECORD_STORE,
} from './cloud-provider.tokens.js';

/**
 * Per-cloud factories for the six cloud-agnostic contracts (`CloudProvider`,
 * `SecretsStore`, `RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`,
 * `RunRecordStore` — all from `@hyveon/shared/cloud.js`). Keyed by the
 * `ActiveCloud` value `ConfigService` reports; each `CloudBindings` entry
 * supplies one factory per token so {@link resolveCloudBindings} (and, in
 * turn, `CloudProviderModule`'s `useFactory` providers) can look up the right
 * implementation without duplicating the cloud switch six times.
 */
export interface CloudBindings {
  cloudProvider: (config: ConfigService) => CloudProvider;
  secretsStore: (config: ConfigService) => SecretsStore;
  remoteFileStore: (config: ConfigService) => RemoteFileStore;
  discordReceiver: (config: ConfigService) => DiscordEventReceiver;
  auditLogStore: (config: ConfigService) => AuditLogStore;
  /**
   * Takes `remoteFileStore` as a second argument (unlike every other
   * `CloudBindings` factory) because {@link resolveRunRecordStoreConfig}'s
   * pre-apply fallback needs it to read the persisted `DeploymentConfig`
   * directly — see that function's own doc comment.
   */
  runRecordStore: (config: ConfigService, remoteFileStore: RemoteFileStore) => RunRecordStore;
}

/**
 * Resolves the `{ bucket, region }` config the AWS `RemoteFileStore`'s
 * `getConfig` callback needs to target the configuration bucket: the bucket
 * comes from `ConfigService.getConfigurationBucket()` (falling back to `''`
 * — an empty bucket name — when no bucket is configured, so
 * `AwsRemoteFileStore` surfaces its own "bucket not configured" error rather
 * than this factory silently defaulting somewhere), and the region from
 * `getRegion()`. Exported as a standalone function (rather than inlined in
 * {@link CLOUD_BINDINGS}) so a unit test can exercise the resolution logic
 * directly without constructing an `@aws-sdk/client-s3`-backed store, which
 * `@hyveon/desktop-main` tests aren't permitted to import.
 */
export function resolveTfvarsFileStoreConfig(config: ConfigService): { bucket: string; region: string } {
  return { bucket: config.getConfigurationBucket() ?? '', region: config.getRegion() };
}

/**
 * Resolves the `{ tableName, region }` config the AWS `AuditLogStore`'s
 * `getConfig` callback needs to target the audit DynamoDB table: the table
 * name comes from `ConfigService.getStackOutputs()`'s `auditTableName`
 * (falling back to `''` when nothing has been deployed yet, so
 * `AwsAuditLogStore` surfaces its own "table not configured" error rather
 * than this factory silently defaulting somewhere), and the region from the
 * SAME resolved `outputs.awsRegion` when a stack is deployed (falling back
 * to `getRegion()`'s wizard-configured value only when nothing is deployed
 * yet). Exported as a standalone function — see
 * {@link resolveTfvarsFileStoreConfig} for why.
 *
 * Region source, revisited: `ConfigService.getRegion()` reads the
 * wizard-configured `aws.region` rather than the deployed stack's own
 * `awsRegion` output (see that method's doc comment for why it can't
 * synchronously read stack outputs). But this function is already async and
 * already resolves `outputs` — so once a stack IS deployed, preferring
 * `outputs.awsRegion` here restores the old self-correcting behavior
 * (`DeploymentConfig.awsRegion`, operator-edited, is the value actually
 * provisioned into; nothing enforces it staying in sync with the wizard's
 * credentials-step region) for these DynamoDB clients specifically, at zero
 * extra cost.
 *
 * Async since task 7.4 (`migrate-iac-to-pulumi`): `getStackOutputs()`
 * replaced the synchronous `getTfOutputs()` this used to read. This is NOT
 * the "DI-factory async hazard" the task brief flagged — `CLOUD_BINDINGS.aws.auditLogStore`
 * below passes `() => resolveAuditLogStoreConfig(config)` as `AwsAuditLogStore`'s
 * lazy `getConfig` closure, not as something the (synchronous) `useFactory`
 * provider below awaits itself; the closure is only ever invoked later, from
 * inside `AwsAuditLogStore`'s own already-`async` methods, where awaiting a
 * `Promise`-returning closure costs nothing extra. See `AwsAuditLogStore`'s
 * constructor doc comment for the same reasoning spelled out at the
 * consumer end.
 */
export async function resolveAuditLogStoreConfig(config: ConfigService): Promise<{ tableName: string; region: string }> {
  const outputs = await config.getStackOutputs();
  return { tableName: outputs?.auditTableName ?? '', region: outputs?.awsRegion ?? config.getRegion() };
}

/**
 * Resolves the `{ tableName, bucket, region }` config the AWS `RunRecordStore`'s
 * `getConfig` callback needs to target the runs DynamoDB table and the
 * configuration S3 bucket used for offloaded run logs: the bucket from
 * `ConfigService.getConfigurationBucket()` (falling back to `''` when no
 * bucket is configured), the region from the same resolved
 * `outputs.awsRegion` when a stack is deployed (falling back to
 * `getRegion()`'s wizard-configured value otherwise), and the table name from
 * `ConfigService.getStackOutputs()`'s `runsTableName` — falling back, when
 * that's empty, to `resolvePreApplyRunsTableName(remoteFileStore)`
 * (`@hyveon/shared`), which reads the persisted `DeploymentConfig` directly
 * to compute the table's deterministic name without ever touching Pulumi.
 *
 * This fallback is the fix for a Critical bootstrap deadlock (see
 * `BootstrapService.ensureRunsTable`'s own doc for the full story):
 * `getStackOutputs()` only reports a value after a stack's first successful
 * `apply`, but the runs table is now created via the AWS SDK at
 * wizard-bootstrap time, before any apply has ever run — without this
 * fallback, `AwsRunRecordStore` would resolve an empty table name and throw
 * "not configured" on every plan/apply of a fresh install, even though the
 * table itself already exists. Only reached when `outputs?.runsTableName` is
 * falsy (short-circuited by `||` otherwise), so a deployed stack's report is
 * always preferred and this never costs an extra read once one exists.
 *
 * `remoteFileStore` is a second parameter (not resolved via `config`, unlike
 * every other field here) because it must be the SAME `RemoteFileStore`
 * singleton the caller already has bound to the configuration bucket — see
 * `CloudProviderModule`'s `RUN_RECORD_STORE` provider, which injects
 * `REMOTE_FILE_STORE` alongside `ConfigService` for exactly this purpose (an
 * intra-module provider dependency, not a new module `imports:` edge — both
 * tokens are already provided by this same module).
 *
 * Exported as a standalone function — see {@link resolveTfvarsFileStoreConfig}
 * for why. Async for the same reason, and with the same "not a DI-factory
 * hazard" and "prefer `outputs.awsRegion` once deployed" reasoning, as
 * {@link resolveAuditLogStoreConfig} — see its doc comment.
 */
export async function resolveRunRecordStoreConfig(
  config: ConfigService,
  remoteFileStore: RemoteFileStore,
): Promise<{ tableName: string; bucket: string; region: string }> {
  const outputs = await config.getStackOutputs();
  const tableName = outputs?.runsTableName || (await resolvePreApplyRunsTableName(remoteFileStore));
  return {
    tableName: tableName ?? '',
    bucket: config.getConfigurationBucket() ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
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
    cloudProvider: (config) => createAwsCloudProvider(config),
    secretsStore: (config) => new AwsSecretsStore(() => config.getRegion()),
    remoteFileStore: (config) => new AwsRemoteFileStore(() => resolveTfvarsFileStoreConfig(config)),
    discordReceiver: () => new AwsDiscordEventReceiver(),
    auditLogStore: (config) => new AwsAuditLogStore(() => resolveAuditLogStoreConfig(config)),
    runRecordStore: (config, remoteFileStore) => new AwsRunRecordStore(() => resolveRunRecordStoreConfig(config, remoteFileStore)),
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
 * Binds the six cloud-agnostic contracts to concrete implementations for
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
 * `PulumiService.preview` (task 7.1, `migrate-iac-to-pulumi`) resolves
 * `REMOTE_FILE_STORE` from this module lazily via a `ModuleRef.get()`
 * strict-false lookup rather than a constructor dependency — see
 * `run-record.module.ts`'s doc comment for why a static `imports:` edge from
 * `PulumiServiceModule` back to this module (reachable from `ConfigModule`,
 * which imports `PulumiServiceModule`) was tried, found to deadlock the real
 * module graph even with every cycle edge `forwardRef()`-wrapped, and
 * abandoned in favor of the `ModuleRef` lookup. This module's own
 * `ConfigModule` import therefore stays the plain, non-circular import it
 * always was.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: CLOUD_PROVIDER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).cloudProvider(config),
      inject: [ConfigService],
    },
    {
      provide: SECRETS_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).secretsStore(config),
      inject: [ConfigService],
    },
    {
      provide: REMOTE_FILE_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).remoteFileStore(config),
      inject: [ConfigService],
    },
    {
      provide: DISCORD_RECEIVER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).discordReceiver(config),
      inject: [ConfigService],
    },
    {
      provide: AUDIT_LOG_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).auditLogStore(config),
      inject: [ConfigService],
    },
    {
      provide: RUN_RECORD_STORE,
      // Injects `REMOTE_FILE_STORE` too (an intra-module provider dependency
      // — both tokens are declared in THIS module's own `providers:`, so
      // this needs no `imports:` edge) for `resolveRunRecordStoreConfig`'s
      // pre-apply table-name fallback — see that function's own doc comment.
      useFactory: (config: ConfigService, remoteFileStore: RemoteFileStore) =>
        resolveCloudBindings(config).runRecordStore(config, remoteFileStore),
      inject: [ConfigService, REMOTE_FILE_STORE],
    },
  ],
  exports: [
    CLOUD_PROVIDER,
    SECRETS_STORE,
    REMOTE_FILE_STORE,
    DISCORD_RECEIVER,
    AUDIT_LOG_STORE,
    RUN_RECORD_STORE,
  ],
})
export class CloudProviderModule {}
