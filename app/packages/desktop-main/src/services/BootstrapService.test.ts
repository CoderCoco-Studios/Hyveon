import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
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
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { CONFIGURATION_OBJECT_KEY, withDeploymentConfigDefaults } from '@hyveon/shared';
import { BootstrapService, BootstrapCredentialsNotConfiguredError } from './BootstrapService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Typed stand-in for the AWS S3 SDK client, shared across the tests below. */
const s3Mock = mockClient(S3Client);

/** Typed stand-in for the AWS DynamoDB SDK client, shared across the `ensureRunsTable` tests below. */
const dynamoMock = mockClient(DynamoDBClient);

/** Build an `ElectronStoreService` stub whose `get('aws')` resolves to the given choice. */
function makeStore(
  aws: { profile?: string; region?: string } | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? aws : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** An AWS SDK v3 error carrying the given error-code `name`, as thrown by a rejected command. */
function awsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

beforeEach(() => {
  s3Mock.reset();
  dynamoMock.reset();
});

describe('BootstrapService', () => {
  describe('ensureStateBucket', () => {
    it('should create the bucket and enable versioning + encryption + public-access-block on a fresh bucket', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(s3Mock.commandCalls(CreateBucketCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-state-bucket',
        CreateBucketConfiguration: { LocationConstraint: 'us-west-2' },
      });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-state-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      });
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-state-bucket',
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      });
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-state-bucket',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('should omit CreateBucketConfiguration when the region is us-east-1', async () => {
      s3Mock.on(HeadBucketCommand).rejects(awsError('NotFound'));
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      await service.ensureStateBucket('my-state-bucket');

      expect(s3Mock.commandCalls(CreateBucketCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-state-bucket',
      });
    });

    it('should skip CreateBucket in us-east-1 when HeadBucket confirms the bucket already exists', async () => {
      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    });

    it('should treat BucketAlreadyOwnedByYou as a success no-op and still ensure versioning/encryption/public-access-block', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyOwnedByYou'));
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    });

    it('should report failure when the bucket already exists but public-access-block cannot be applied', async () => {
      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should report a clear failure when the bucket name is owned by another account', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyExists'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('taken-bucket-name');

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/already taken by another AWS account/i);
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    });

    it('should report failure with the error message for an unexpected CreateBucket error', async () => {
      s3Mock.on(CreateBucketCommand).rejects(new Error('network timeout'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'failed', message: 'network timeout' });
    });

    it('should report failure when versioning/encryption cannot be applied after a successful create', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureStateBucket('my-state-bucket')).rejects.toThrow(
        BootstrapCredentialsNotConfiguredError,
      );
    });

    it('should build the S3 client with static credentials when the profile resolves to pasted credentials', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const store = makeStore({ profile: 'hyveon-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new BootstrapService(store);

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(store.getPastedCredentials).toHaveBeenCalledWith('hyveon-pasted');
    });

    it('should fall back to a real ~/.aws CLI profile when the profile has no pasted-credentials entry', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const store = makeStore({ profile: 'default', region: 'us-west-2' }, undefined);
      const service = new BootstrapService(store);

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(store.getPastedCredentials).toHaveBeenCalledWith('default');
    });

    it('should not consult pasted credentials when no profile is stored', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const store = makeStore({ region: 'us-west-2' });
      const service = new BootstrapService(store);

      await service.ensureStateBucket('my-state-bucket');

      expect(store.getPastedCredentials).not.toHaveBeenCalled();
    });
  });

  describe('ensureConfigurationBucket', () => {
    it('should create the bucket with versioning, a 90-day noncurrent-version lifecycle rule, encryption, and public-access-block on a fresh bucket', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(s3Mock.commandCalls(CreateBucketCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        CreateBucketConfiguration: { LocationConstraint: 'us-west-2' },
      });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      });
      expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'expire-noncurrent-versions',
              Status: 'Enabled',
              Filter: {},
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            },
          ],
        },
      });
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      });
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('should treat BucketAlreadyOwnedByYou as a success no-op and still ensure versioning/lifecycle/encryption/public-access-block', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyOwnedByYou'));
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    });

    it('should skip CreateBucket in us-east-1 when HeadBucket confirms the bucket already exists', async () => {
      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    });

    it('should report a clear failure when the bucket name is owned by another account', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyExists'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('taken-bucket-name');

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/already taken by another AWS account/i);
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    });

    it('should report failure with the error message when the lifecycle rule cannot be applied after a successful create', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should report failure with the error message when encryption cannot be applied after a successful create', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(0);
    });

    it('should report failure when public-access-block cannot be applied after a successful create', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureConfigurationBucket('my-config-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureConfigurationBucket('my-config-bucket')).rejects.toThrow(
        BootstrapCredentialsNotConfiguredError,
      );
    });
  });

  /**
   * Tests for the fresh-install-bricking fix: `ensureDeploymentConfig` seeds
   * the initial `deployment-config.json` document — before this existed,
   * nothing anywhere ever created that object, so a fresh install was
   * completely unusable the moment the wizard finished (every
   * `DeploymentConfigService` write path reads the document before writing, and that
   * read threw when the object didn't exist). See this method's own doc
   * comment for the full rationale, and `DeploymentConfigService.freshInstall.test.ts`
   * for the genuine end-to-end proof that a seeded document really does let
   * `updateTopLevelSettings`/`addGameServer` succeed afterward.
   */
  describe('ensureDeploymentConfig', () => {
    it('should seed a minimal valid deployment-config document when none exists yet', async () => {
      s3Mock.on(HeadObjectCommand).rejects(awsError('NotFound'));
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-1"' });
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureDeploymentConfig('my-config-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(s3Mock.commandCalls(HeadObjectCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-config-bucket',
        Key: CONFIGURATION_OBJECT_KEY,
      });
      const putCall = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(putCall.Bucket).toBe('my-config-bucket');
      expect(putCall.Key).toBe(CONFIGURATION_OBJECT_KEY);
      const written = JSON.parse(new TextDecoder().decode(putCall.Body as Uint8Array));
      expect(written).toEqual(withDeploymentConfigDefaults({ hostedZoneName: '', gameServers: {} }));
    });

    it('should report exists (not an error) and skip PutObject when HeadObject confirms the document already exists', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureDeploymentConfig('my-config-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('should report failure with the error message when PutObject fails after HeadObject confirms the object is absent', async () => {
      s3Mock.on(HeadObjectCommand).rejects(awsError('NotFound'));
      s3Mock.on(PutObjectCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureDeploymentConfig('my-config-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureDeploymentConfig('my-config-bucket')).rejects.toThrow(
        BootstrapCredentialsNotConfiguredError,
      );
    });

    it('should report failure rather than seed over the object when HeadObject fails for a reason other than NotFound', async () => {
      s3Mock.on(HeadObjectCommand).rejects(awsError('AccessDenied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureDeploymentConfig('my-config-bucket');

      expect(result).toEqual({ status: 'failed', message: 'AccessDenied' });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
  });

  describe('cross-resource failure isolation', () => {
    it('should report the configuration bucket as failed and the state bucket as created independently, when only the configuration bucket\'s public-access-block call fails', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      // Default: PAB succeeds for any bucket...
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      // ...except the configuration bucket, whose PAB call is rejected.
      s3Mock
        .on(PutPublicAccessBlockCommand, { Bucket: 'my-config-bucket' })
        .rejects(new Error('access denied applying public-access-block'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      // Run both operations concurrently, mirroring how the renderer invokes
      // them (see `first-run-wizard.component.tsx`'s `runBootstrap`) — this
      // proves the two calls share no mutable state that could let one
      // resource's failure leak into or suppress the other's result.
      const [stateResult, configResult] = await Promise.all([
        service.ensureStateBucket('my-state-bucket'),
        service.ensureConfigurationBucket('my-config-bucket'),
      ]);

      expect(stateResult).toEqual({ status: 'created' });
      expect(configResult).toEqual({
        status: 'failed',
        message: 'access denied applying public-access-block',
      });
      // The state bucket's own configuration calls all completed — the
      // sibling's failure didn't short-circuit or skip them.
      expect(s3Mock.commandCalls(PutBucketVersioningCommand, { Bucket: 'my-state-bucket' })).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand, { Bucket: 'my-state-bucket' })).toHaveLength(1);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand, { Bucket: 'my-state-bucket' })).toHaveLength(1);
    });

    it('should report the state bucket as failed and the configuration bucket as created independently, when only the state bucket cannot be created', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock
        .on(CreateBucketCommand, { Bucket: 'my-state-bucket' })
        .rejects(awsError('BucketAlreadyExists'));
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      s3Mock.on(PutPublicAccessBlockCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const [stateResult, configResult] = await Promise.all([
        service.ensureStateBucket('my-state-bucket'),
        service.ensureConfigurationBucket('my-config-bucket'),
      ]);

      expect(stateResult.status).toBe('failed');
      expect(stateResult.message).toMatch(/already taken by another AWS account/i);
      expect(configResult).toEqual({ status: 'created' });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand, { Bucket: 'my-config-bucket' })).toHaveLength(1);
      expect(s3Mock.commandCalls(PutPublicAccessBlockCommand, { Bucket: 'my-config-bucket' })).toHaveLength(1);
    });
  });

  /**
   * Tests for the bootstrap-deadlock fix: `ensureRunsTable` creates the
   * run-history DynamoDB table via the AWS SDK directly, at wizard-bootstrap
   * time, before any Pulumi apply has ever run — see this method's own doc
   * comment for the full rationale and `RunRecordService.test.ts`'s
   * "pre-apply runsTableName fallback" describe block for the service-layer
   * half of this fix.
   */
  describe('ensureRunsTable', () => {
    it('should create the table with the exact schema dynamodb.ts documents (pk/sk keys, status-index GSI, PAY_PER_REQUEST billing) and enable point-in-time recovery', async () => {
      dynamoMock
        .on(DescribeTableCommand)
        .rejectsOnce(new ResourceNotFoundException({ message: 'not found', $metadata: {} }))
        .resolves({ Table: { TableStatus: 'ACTIVE' } });
      dynamoMock.on(CreateTableCommand).resolves({});
      dynamoMock.on(UpdateContinuousBackupsCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureRunsTable('hyveon-runs');

      expect(result).toEqual({ status: 'created' });
      const createInput = dynamoMock.commandCalls(CreateTableCommand)[0]!.args[0].input;
      expect(createInput.TableName).toBe('hyveon-runs');
      expect(createInput.BillingMode).toBe('PAY_PER_REQUEST');
      expect(createInput.KeySchema).toEqual([
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]);
      expect(createInput.AttributeDefinitions).toEqual([
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'startedAt', AttributeType: 'S' },
      ]);
      expect(createInput.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: 'status-index',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'startedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ]);
      expect(createInput.Tags).toEqual([
        { Key: 'Name', Value: 'hyveon-runs' },
        { Key: 'Project', Value: 'hyveon' },
      ]);
      expect(dynamoMock.commandCalls(UpdateContinuousBackupsCommand)[0]!.args[0].input).toEqual({
        TableName: 'hyveon-runs',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    it('should report exists (not an error) and skip CreateTable when DescribeTable confirms the table already exists', async () => {
      dynamoMock.on(DescribeTableCommand).resolves({ Table: { TableStatus: 'ACTIVE' } });
      dynamoMock.on(UpdateContinuousBackupsCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureRunsTable('hyveon-runs');

      expect(result).toEqual({ status: 'exists' });
      expect(dynamoMock.commandCalls(CreateTableCommand)).toHaveLength(0);
      // Point-in-time recovery is still (re-)applied on the already-exists
      // path, mirroring ensureStateBucket/ensureConfigurationBucket's
      // "bring an older resource up to the current standard" precedent.
      expect(dynamoMock.commandCalls(UpdateContinuousBackupsCommand)).toHaveLength(1);
    });

    it('should treat a ResourceInUseException race from CreateTable as exists, not a failure', async () => {
      dynamoMock
        .on(DescribeTableCommand)
        .rejectsOnce(new ResourceNotFoundException({ message: 'not found', $metadata: {} }))
        .resolves({ Table: { TableStatus: 'ACTIVE' } });
      dynamoMock.on(CreateTableCommand).rejects(new ResourceInUseException({ message: 'already exists', $metadata: {} }));
      dynamoMock.on(UpdateContinuousBackupsCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureRunsTable('hyveon-runs');

      expect(result).toEqual({ status: 'exists' });
    });

    it('should report failure with the error message for an unexpected CreateTable error', async () => {
      dynamoMock.on(DescribeTableCommand).rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));
      dynamoMock.on(CreateTableCommand).rejects(new Error('network timeout'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureRunsTable('hyveon-runs');

      expect(result).toEqual({ status: 'failed', message: 'network timeout' });
    });

    it('should report failure when point-in-time recovery cannot be enabled after a successful create', async () => {
      dynamoMock
        .on(DescribeTableCommand)
        .rejectsOnce(new ResourceNotFoundException({ message: 'not found', $metadata: {} }))
        .resolves({ Table: { TableStatus: 'ACTIVE' } });
      dynamoMock.on(CreateTableCommand).resolves({});
      dynamoMock.on(UpdateContinuousBackupsCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureRunsTable('hyveon-runs');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureRunsTable('hyveon-runs')).rejects.toThrow(BootstrapCredentialsNotConfiguredError);
    });
  });
});
