import { Injectable } from '@nestjs/common';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';

/**
 * How many days a noncurrent configuration-bucket object version is retained
 * before expiring — matches the parity baseline that historically lived in
 * the old Terraform-era bootstrap HCL's `aws_s3_bucket_lifecycle_configuration`
 * rule for the (then differently named) `tfvars` bucket; this service uses
 * the same 90-day window for the renamed configuration bucket. That HCL has
 * since been removed (Phase 12 of `migrate-iac-to-pulumi`) — this is now
 * simply what the bucket used to be provisioned by, not a live parity
 * target.
 */
const CONFIGURATION_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

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
 * provider needs to satisfy (see design.md decision 6).
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
   * Matches the versioning / lifecycle-configuration / public-access-block
   * settings the old Terraform-era bootstrap HCL applied to its `tfvars`
   * bucket (design.md decision 6) — the resulting bucket is the canonical
   * `RemoteFileStore` holding the JSON game-server configuration. This is
   * *not* full parity with that HCL module: it has no server-side-encryption
   * resource for this bucket (only `ensureStateBucket`'s bucket gets SSE, and
   * the delta spec doesn't ask for it here either), so "behaviourally
   * consistent" only ever meant those three settings, not everything the
   * module did. That HCL — which named its bucket for the Terraform-era
   * `terraform.tfvars` object it once held — has since been removed
   * (Phase 12 of `migrate-iac-to-pulumi`); this is historical baseline only.
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
   * `bucketName`, mirroring the `aws_s3_bucket_public_access_block` resource
   * the old Terraform-era bootstrap HCL applied to its `tfvars` bucket — a
   * historical HCL baseline only, since that HCL has since been removed
   * (Phase 12 of `migrate-iac-to-pulumi`).
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
