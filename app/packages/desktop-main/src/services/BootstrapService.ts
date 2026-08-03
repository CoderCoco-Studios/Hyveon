import { Injectable } from '@nestjs/common';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  ResourceInUseException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { CONFIGURATION_OBJECT_KEY, withDeploymentConfigDefaults } from '@hyveon/shared';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';

/**
 * How many days a noncurrent configuration-bucket object version is retained
 * before expiring — matches the baseline in
 * `terraform/bootstrap/main.tf`'s `aws_s3_bucket_lifecycle_configuration.tfvars`
 * rule (that module still names the resource for its Terraform-era `tfvars`
 * object; this service uses the same 90-day window for the renamed
 * configuration bucket).
 */
const CONFIGURATION_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/**
 * Maximum time, in seconds, {@link BootstrapService.ensureRunsTable} will
 * wait for a freshly-created table to reach `ACTIVE` status
 * (`waitUntilTableExists`) before enabling point-in-time recovery — a
 * `PAY_PER_REQUEST` table with two attributes and one GSI typically becomes
 * `ACTIVE` within a few seconds, so 60s leaves generous headroom without
 * risking the wizard step hanging indefinitely on a genuinely stuck table.
 */
const RUNS_TABLE_WAIT_TIMEOUT_SECONDS = 60;

/**
 * The credentials/region shape shared by every wizard-bootstrap SDK client
 * construction (currently `S3Client` only). `region` and `credentials` are
 * structurally identical across `@aws-sdk/client-*` config types, so a
 * single resolved value can construct any of them without a per-service cast.
 */
type WizardAwsClientConfig = Pick<S3ClientConfig, 'region' | 'credentials'>;

/** Per-resource outcome returned by a `BootstrapService` operation over IPC. */
export type BootstrapResourceStatus = 'created' | 'exists' | 'failed';

/** Result of a single bootstrap operation (e.g. {@link BootstrapService.ensureStateBucket}). */
export interface BootstrapResult {
  status: BootstrapResourceStatus;
  /** Present when `status` is `'failed'` — an actionable message for the wizard to display. */
  message?: string;
}

/**
 * Thrown when a bootstrap operation runs before the wizard's credentials
 * step has stored a region (see `WizardController.saveState`'s `aws` field).
 * Bootstrap has nothing to build an SDK client from in that case.
 */
export class BootstrapCredentialsNotConfiguredError extends Error {
  constructor() {
    super(
      'Cannot bootstrap AWS resources: no region is configured. Complete the credentials step of the wizard first.',
    );
    this.name = 'BootstrapCredentialsNotConfiguredError';
  }
}

/**
 * Performs the first-run wizard's AWS SDK-only bootstrap operations (see
 * `openspec/changes/migrate-iac-to-pulumi`, "cloud-bootstrap" spec) —
 * idempotently provisioning the self-managed infrastructure backend's state
 * bucket and the configuration bucket via `@aws-sdk/client-s3` directly,
 * never by shelling out to a CLI and never by invoking the infrastructure
 * engine, which cannot provision the backend it is configured to read from.
 * Deliberately AWS-SDK-direct rather than routed through the cloud-agnostic
 * `RunTask`/`StopTask` contracts in `@hyveon/shared/cloud.ts` — bootstrap is
 * AWS-only setup plumbing, not a steady-state operation any other cloud
 * provider needs to satisfy.
 */
@Injectable()
export class BootstrapService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Idempotently ensures the S3 bucket backing the self-managed
   * infrastructure state backend exists with versioning, default (AES256)
   * server-side encryption, and all four public-access-block settings
   * enabled.
   *
   * @remarks
   * There is no Terraform/Pulumi resource for this bucket itself, since the
   * infrastructure program can't provision the backend it also reads state
   * from — this SDK path is the only place that creates and hardens it.
   *
   * @param bucketName - Name of the state bucket to create/ensure. Naming
   *   defaults and operator editability are a concern of the bootstrap
   *   wizard step's UI (#208), not this service.
   */
  async ensureStateBucket(bucketName: string): Promise<BootstrapResult> {
    const client = this.createS3Client();
    let created: boolean;
    try {
      created = await this.createBucket(client, bucketName);
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucketName,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      await client.send(
        new PutBucketEncryptionCommand({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
          },
        }),
      );
      await this.ensurePublicAccessBlock(client, bucketName);
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    return { status: created ? 'created' : 'exists' };
  }

  /**
   * Idempotently ensures the versioned configuration S3 bucket exists with a
   * lifecycle rule expiring noncurrent object versions after 90 days and all
   * four public-access-block settings enabled.
   *
   * @remarks
   * Matches `terraform/bootstrap/main.tf`'s `aws_s3_bucket_versioning.tfvars`
   * / `aws_s3_bucket_lifecycle_configuration.tfvars` /
   * `aws_s3_bucket_public_access_block.tfvars` resources on versioning,
   * lifecycle, and public-access-block specifically — the resulting bucket is
   * the canonical `RemoteFileStore` holding the JSON game-server
   * configuration. This is *not* full parity with that HCL module: it has no
   * server-side-encryption resource for this bucket (only
   * `ensureStateBucket`'s bucket gets SSE), so "behaviourally consistent"
   * only ever means those three settings, not everything the module does.
   * `terraform/bootstrap/` still names its bucket for the Terraform-era
   * `terraform.tfvars` object it once held.
   *
   * @param bucketName - Name of the configuration bucket to create/ensure.
   */
  async ensureConfigurationBucket(bucketName: string): Promise<BootstrapResult> {
    const client = this.createS3Client();
    let created: boolean;
    try {
      created = await this.createBucket(client, bucketName);
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucketName,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucketName,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'expire-noncurrent-versions',
                Status: 'Enabled',
                Filter: {},
                NoncurrentVersionExpiration: {
                  NoncurrentDays: CONFIGURATION_NONCURRENT_VERSION_EXPIRATION_DAYS,
                },
              },
            ],
          },
        }),
      );
      await this.ensurePublicAccessBlock(client, bucketName);
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    return { status: created ? 'created' : 'exists' };
  }

  /**
   * Idempotently ensures the {@link CONFIGURATION_OBJECT_KEY} deployment-config
   * JSON object exists in the configuration bucket, seeding a minimal, valid
   * placeholder document when it's absent — NEVER overwrites a document that
   * already exists.
   *
   * @remarks
   * Fixes a Critical bootstrap gap this migration's final review round
   * uncovered: every `TfvarsService` write path — `writeConfig` (shared by
   * `addGameServer`/`updateGameServer`/`removeGameServer`) and
   * `updateTopLevelSettings` — reads the current document before writing
   * (`fetchRawConfig`), and `fetchRawConfig` throws a plain `Error` when the
   * object doesn't exist. Before this method, nothing anywhere ever created
   * that first object: a fresh install that completed the first-run wizard
   * landed on the dashboard with no way to save Settings, add a game, or run
   * a Pulumi preview — every one of those calls `fetchRawConfig` first and
   * threw immediately. Called alongside {@link ensureConfigurationBucket}
   * from the wizard's bootstrap step, against the SAME `bucketName` that call
   * just created/confirmed — see `WizardController.bootstrapDeploymentConfig`.
   *
   * Lives here (on `BootstrapService`) rather than on `TfvarsService`
   * deliberately: `TfvarsService` resolves its bucket from
   * `ConfigService.getConfigurationBucket()`, which reads
   * `ElectronStoreService`'s persisted `bootstrap.configurationBucket` — a
   * value the wizard's bootstrap step doesn't durably save until the
   * operator advances past the step (see `FirstRunWizard`'s `goNext`), i.e.
   * AFTER bootstrap has already run. `BootstrapService`'s other `ensureX`
   * methods sidestep this exact ordering problem by taking `bucketName` as a
   * parameter and building their own S3 client directly, rather than relying
   * on already-persisted config — this method follows that same convention
   * so it can run in the same wizard moment as {@link ensureConfigurationBucket},
   * before `ElectronStoreService` has any record of the bucket name at all.
   *
   * The seed content — `withDeploymentConfigDefaults({ hostedZoneName: '', gameServers: {} })`
   * (`@hyveon/shared`) — fills in every field that has a
   * Terraform-parity default and leaves `hostedZoneName` as an empty-string
   * placeholder (it has no default; every real deployment requires a real
   * value). This deliberately never runs through
   * `validateDeploymentSettingsPatch` (`@hyveon/shared`): that validator only
   * gates a Settings-form PATCH via `IacSettingsController.update`, never a
   * raw initial write like this one — so the empty placeholder here reaches
   * storage untouched, and the very first time the operator opens the
   * Settings page, that same validator's live client-side check immediately
   * flags the blank hosted zone as the normal "must not be empty" issue,
   * exactly like any other incomplete field.
   *
   * Idempotent via a `HeadObject` pre-check (mirroring {@link bucketExists}'s
   * `HeadBucket` pre-check for the bucket-level methods above) — re-running
   * the wizard's bootstrap step, or a later Reconfigure, never clobbers
   * configuration the operator has since edited.
   *
   * @param bucketName - The configuration bucket to seed — the same name
   *   just passed to {@link ensureConfigurationBucket}.
   */
  async ensureDeploymentConfig(bucketName: string): Promise<BootstrapResult> {
    const client = this.createS3Client();
    try {
      if (await this.deploymentConfigExists(client, bucketName)) {
        return { status: 'exists' };
      }
      const seed = withDeploymentConfigDefaults({ hostedZoneName: '', gameServers: {} });
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: CONFIGURATION_OBJECT_KEY,
          Body: new TextEncoder().encode(JSON.stringify(seed, null, 2) + '\n'),
          ContentType: 'application/json',
        }),
      );
      return { status: 'created' };
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }
  }

  /**
   * Resolves `true` when {@link CONFIGURATION_OBJECT_KEY} already exists in
   * `bucketName`, via `HeadObject`. Unlike {@link bucketExists}/
   * {@link runsTableExists} — whose fallback action (`CreateBucket`/
   * `CreateTable`) is a safe no-op against an existing resource — this
   * method's fallback is `PutObject`, which overwrites. So only a genuine
   * "not found" is treated as absent; any other failure (transient error, a
   * permission gap between `HeadObject` and `PutObject`) propagates rather
   * than risk seeding over an operator's real configuration.
   */
  private async deploymentConfigExists(client: S3Client, bucketName: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: CONFIGURATION_OBJECT_KEY }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || this.isAwsErrorCode(err, 'NotFound') || this.isAwsErrorCode(err, 'NoSuchKey')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Idempotently ensures the run-history DynamoDB table exists, with the
   * `status-index` GSI and point-in-time recovery enabled — the exact schema
   * `@hyveon/infra`'s `dynamodb.ts` documents (that package no longer
   * declares this table as a Pulumi resource; see its file doc for why).
   *
   * @remarks
   * Called from the first-run wizard's bootstrap step, alongside
   * {@link ensureStateBucket}/{@link ensureConfigurationBucket} — this is the
   * fix for a Critical bootstrap deadlock: `RunRecordService`'s approve/apply
   * gates require this table to exist before the very first Pulumi
   * plan/apply cycle of a fresh install can ever complete, which a
   * Pulumi-managed resource structurally cannot guarantee (a stack only
   * reports outputs, and therefore could only report this table's name,
   * after its first successful `apply` — see `PulumiService.getStackOutputs`'s
   * own doc). Creating it here, before any `DeploymentConfig`/Pulumi apply
   * exists at all, removes that circular dependency entirely.
   *
   * Idempotent via a `DescribeTable` pre-check (mirroring
   * {@link bucketExists}'s `HeadBucket` pre-check for the S3 methods above),
   * with a `ResourceInUseException` from `CreateTable` itself ALSO treated as
   * `'exists'` (not an error) as a race-safety net — two concurrent
   * `ensureRunsTable` calls (e.g. a wizard resume racing a Reconfigure) can
   * both pass the pre-check before either's `CreateTable` lands.
   *
   * Point-in-time recovery cannot be requested at `CreateTable` time (unlike
   * the S3 methods' versioning/encryption, which the `CreateBucket`-adjacent
   * `Put*` calls above apply as separate calls too) — it requires a
   * dedicated `UpdateContinuousBackups` call against a table that has
   * already reached `ACTIVE` status, so this method waits for that via
   * {@link waitUntilTableExists} before enabling it. Applied unconditionally
   * on both the fresh-create and already-exists paths, mirroring
   * {@link ensurePublicAccessBlock}'s "bring an older table up to the
   * current standard" precedent.
   *
   * @param tableName - The resolved (not raw-override) table name to
   *   create/ensure — callers must already have applied
   *   `@hyveon/shared`'s `resolveRunsTableName` themselves; this method
   *   creates exactly the name it's given.
   */
  async ensureRunsTable(tableName: string): Promise<BootstrapResult> {
    const client = this.createDynamoDbClient();
    let created: boolean;
    try {
      created = await this.createRunsTable(client, tableName);
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    try {
      await waitUntilTableExists({ client, maxWaitTime: RUNS_TABLE_WAIT_TIMEOUT_SECONDS }, { TableName: tableName });
      await client.send(
        new UpdateContinuousBackupsCommand({
          TableName: tableName,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      );
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    return { status: created ? 'created' : 'exists' };
  }

  /**
   * Creates the run-history table, returning `true` if this call created it
   * and `false` if it already existed (confirmed via a `DescribeTable`
   * pre-check, or a `ResourceInUseException` race on `CreateTable` itself —
   * both are success paths, mirroring {@link createBucket}'s
   * `BucketAlreadyOwnedByYou` handling). Re-throws any other `CreateTable`
   * failure.
   */
  private async createRunsTable(client: DynamoDBClient, tableName: string): Promise<boolean> {
    if (await this.runsTableExists(client, tableName)) {
      return false;
    }
    try {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: 'status', AttributeType: 'S' },
            { AttributeName: 'startedAt', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'status-index',
              KeySchema: [
                { AttributeName: 'status', KeyType: 'HASH' },
                { AttributeName: 'startedAt', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
          Tags: [
            { Key: 'Name', Value: tableName },
            { Key: 'Project', Value: 'hyveon' },
          ],
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ResourceInUseException) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Resolves `true` when `tableName` already exists and is reachable by the
   * caller's credentials, via `DescribeTable`. Any failure (a genuine
   * `ResourceNotFoundException` — the table is free to create — or anything
   * else, e.g. a transient access denial) is treated as "not confirmed to
   * exist" so {@link createRunsTable}'s own `CreateTable` error handling
   * still runs — mirrors {@link bucketExists}.
   */
  private async runsTableExists(client: DynamoDBClient, tableName: string): Promise<boolean> {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a `DynamoDBClient` from the credentials/region chosen in the
   * wizard's credentials step, mirroring {@link createS3Client} exactly
   * (same {@link resolveClientConfig} seam). Extracted as a protected seam
   * so tests can stub it without touching real credentials.
   */
  protected createDynamoDbClient(): DynamoDBClient {
    return new DynamoDBClient(this.resolveClientConfig());
  }

  /**
   * Creates the bucket, returning `true` if this call created it and
   * `false` if it already existed under the caller's own account
   * (`BucketAlreadyOwnedByYou`) — both are success paths. Re-throws for
   * `BucketAlreadyExists` (owned by another account) and any other error.
   *
   * @remarks
   * In `us-east-1`, `CreateBucket` uses legacy compatibility behaviour: a
   * bucket already owned by the caller returns `200 OK` instead of throwing
   * `BucketAlreadyOwnedByYou`, and — as a side effect — resets the bucket's
   * ACLs. A `HeadBucket` pre-check sidesteps both the mis-reported `created`
   * status and the ACL reset for that region.
   */
  private async createBucket(client: S3Client, bucketName: string): Promise<boolean> {
    const region = this.store.get('aws')?.region;
    if ((!region || region === 'us-east-1') && (await this.bucketExists(client, bucketName))) {
      return false;
    }
    try {
      await client.send(
        new CreateBucketCommand({
          Bucket: bucketName,
          // us-east-1 is S3's default region and must NOT be passed as an
          // explicit LocationConstraint — every other region must.
          ...(region && region !== 'us-east-1'
            ? { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }
            : {}),
        }),
      );
      return true;
    } catch (err) {
      if (this.isAwsErrorCode(err, 'BucketAlreadyOwnedByYou')) {
        return false;
      }
      if (this.isAwsErrorCode(err, 'BucketAlreadyExists')) {
        throw new Error(
          `The bucket name "${bucketName}" is already taken by another AWS account. Choose a different name.`,
        );
      }
      throw err;
    }
  }

  /**
   * Resolves `true` when `bucketName` already exists and is reachable by the
   * caller's credentials. A `NotFound` response means the bucket is free to
   * create; any other error (e.g. `Forbidden` for a bucket owned by another
   * account) is treated as "not confirmed to exist" so `createBucket`'s own
   * `CreateBucket` error handling still runs.
   */
  private async bucketExists(client: S3Client, bucketName: string): Promise<boolean> {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Applies all four S3 public-access-block settings (`BlockPublicAcls`,
   * `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`) to
   * `bucketName`, mirroring `terraform/bootstrap/main.tf`'s
   * `aws_s3_bucket_public_access_block.tfvars` resource — a historical HCL
   * baseline only, since `terraform/bootstrap/` is deleted as part of Phase
   * 12 of this change.
   *
   * @remarks
   * Called unconditionally after {@link createBucket} resolves — on both the
   * fresh-create and already-exists paths — so a bucket created by an
   * earlier version of this service (before this hardening existed) is
   * brought up to the current standard the next time the wizard runs, not
   * only a brand-new bucket. Any failure propagates to the caller's own
   * try/catch, which already reports it as `{ status: 'failed', message }`
   * — this has no dedicated error type, consistent with every other
   * bucket-configuration call in {@link ensureStateBucket} /
   * {@link ensureConfigurationBucket}.
   */
  private async ensurePublicAccessBlock(client: S3Client, bucketName: string): Promise<void> {
    await client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
  }

  private isAwsErrorCode(err: unknown, code: string): boolean {
    return err instanceof Error && err.name === code;
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Builds an S3 client from the credentials/region chosen in the wizard's
   * credentials step (`ElectronStoreService.aws`), via
   * {@link resolveAwsCredentialSource} (a pasted-credentials entry wins over
   * a real `~/.aws` CLI profile of the same name — see that function's doc
   * comment for why there is no separate discriminator). Extracted as a
   * protected seam so tests can stub it without touching real credentials.
   */
  protected createS3Client(): S3Client {
    return new S3Client(this.resolveClientConfig());
  }

  private resolveClientConfig(): WizardAwsClientConfig {
    const aws = this.store.get('aws');
    if (!aws?.region) {
      throw new BootstrapCredentialsNotConfiguredError();
    }
    const { region } = aws;
    const source = resolveAwsCredentialSource(this.store);
    switch (source.kind) {
      case 'none':
        return { region };
      case 'pasted':
        return {
          region,
          credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey },
        };
      case 'profile':
        return { region, credentials: fromIni({ profile: source.profile }) };
    }
  }
}
