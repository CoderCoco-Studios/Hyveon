import { Injectable } from '@nestjs/common';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  type BucketLocationConstraint,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { DynamoDBClient, CreateTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { ElectronStoreService } from './ElectronStoreService.js';

/**
 * How long `ensureLockTable` waits for a freshly-created lock table to reach
 * `ACTIVE` before giving up and reporting `failed`.
 */
const LOCK_TABLE_ACTIVE_WAIT_SECONDS = 60;

/**
 * The credentials/region shape shared by every wizard-bootstrap SDK client
 * (`S3Client`, `DynamoDBClient`, ...). `region` and `credentials` are
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
 * `openspec/changes/add-first-run-wizard`, "Cloud Bootstrap" spec) —
 * idempotently provisioning the Terraform backend resources via
 * `@aws-sdk/client-s3` directly, never by shelling out to `terraform`/`aws`.
 * Deliberately AWS-SDK-direct rather than routed through the cloud-agnostic
 * `RunTask`/`StopTask` contracts in `@hyveon/shared/cloud.ts` — bootstrap is
 * AWS-only setup plumbing, not a steady-state operation any other cloud
 * provider needs to satisfy (see design.md decision 6).
 */
@Injectable()
export class BootstrapService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Idempotently ensures the Terraform S3 state bucket exists with
   * versioning and default (AES256) server-side encryption enabled.
   *
   * @remarks
   * Mirrors the intent of `terraform/bootstrap/` (which provisions the
   * tfvars bucket, not this one — there is no Terraform resource for the
   * state bucket itself, since Terraform can't manage the backend it also
   * reads from) — kept in TSDoc here as the two must stay behaviourally
   * consistent if either changes.
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
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }

    return { status: created ? 'created' : 'exists' };
  }

  /**
   * Idempotently ensures the Terraform state-lock DynamoDB table exists,
   * with the `LockID` string hash key the S3 backend's native locking
   * requires, waiting until the table reaches `ACTIVE` before reporting
   * success on a fresh create.
   *
   * @param tableName - Name of the lock table to create/ensure.
   */
  async ensureLockTable(tableName: string): Promise<BootstrapResult> {
    const client = this.createDynamoDbClient();
    try {
      const created = await this.createTable(client, tableName);
      return { status: created ? 'created' : 'exists' };
    } catch (err) {
      return { status: 'failed', message: this.describeError(err) };
    }
  }

  /**
   * Creates the lock table and waits for it to become `ACTIVE`, returning
   * `true` if this call created it and `false` if it already existed
   * (`ResourceInUseException`) — both are success paths.
   */
  private async createTable(client: DynamoDBClient, tableName: string): Promise<boolean> {
    try {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [{ AttributeName: 'LockID', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      );
      await waitUntilTableExists(
        { client, maxWaitTime: LOCK_TABLE_ACTIVE_WAIT_SECONDS },
        { TableName: tableName },
      );
      return true;
    } catch (err) {
      if (this.isAwsErrorCode(err, 'ResourceInUseException')) {
        return false;
      }
      throw err;
    }
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

  private isAwsErrorCode(err: unknown, code: string): boolean {
    return err instanceof Error && err.name === code;
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Builds an S3 client from the credentials/region chosen in the wizard's
   * credentials step (`ElectronStoreService.aws`). A stored `profile` name
   * is resolved as a pasted-credentials entry first (`creds.aws.<profile>`)
   * and falls back to a real `~/.aws` CLI profile via `fromIni` — matching
   * how the credentials step can populate `profile` from either path (see
   * `AwsProfileService`/`WizardController.saveCredentials`). Extracted as a
   * protected seam so tests can stub it without touching real credentials.
   */
  protected createS3Client(): S3Client {
    return new S3Client(this.resolveClientConfig());
  }

  /**
   * Builds a DynamoDB client from the same wizard-chosen credentials/region
   * as {@link createS3Client}. Extracted as a protected seam so tests can
   * stub it without touching real credentials.
   */
  protected createDynamoDbClient(): DynamoDBClient {
    return new DynamoDBClient(this.resolveClientConfig());
  }

  private resolveClientConfig(): WizardAwsClientConfig {
    const aws = this.store.get('aws');
    if (!aws?.region) {
      throw new BootstrapCredentialsNotConfiguredError();
    }
    const { region, profile } = aws;
    if (!profile) {
      return { region };
    }
    const pasted = this.store.getPastedCredentials(profile);
    if (pasted) {
      return {
        region,
        credentials: { accessKeyId: pasted.accessKeyId, secretAccessKey: pasted.secretAccessKey },
      };
    }
    return { region, credentials: fromIni({ profile }) };
  }
}
