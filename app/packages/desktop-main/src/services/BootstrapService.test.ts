import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { BootstrapService, BootstrapCredentialsNotConfiguredError } from './BootstrapService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Typed stand-in for the AWS S3 SDK client, shared across the tests below. */
const s3Mock = mockClient(S3Client);

/** Typed stand-in for the AWS DynamoDB SDK client, shared across the tests below. */
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
    it('should create the bucket and enable versioning + encryption on a fresh bucket', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
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
    });

    it('should omit CreateBucketConfiguration when the region is us-east-1', async () => {
      s3Mock.on(HeadBucketCommand).rejects(awsError('NotFound'));
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
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
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
    });

    it('should treat BucketAlreadyOwnedByYou as a success no-op and still ensure versioning/encryption', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyOwnedByYou'));
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketEncryptionCommand)).toHaveLength(1);
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
      const store = makeStore({ profile: 'gsd-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new BootstrapService(store);

      const result = await service.ensureStateBucket('my-state-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(store.getPastedCredentials).toHaveBeenCalledWith('gsd-pasted');
    });

    it('should fall back to a real ~/.aws CLI profile when the profile has no pasted-credentials entry', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketEncryptionCommand).resolves({});
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
      const store = makeStore({ region: 'us-west-2' });
      const service = new BootstrapService(store);

      await service.ensureStateBucket('my-state-bucket');

      expect(store.getPastedCredentials).not.toHaveBeenCalled();
    });
  });

  describe('ensureLockTable', () => {
    it('should create the lock table with a LockID string hash key and wait for it to become ACTIVE', async () => {
      dynamoMock.on(CreateTableCommand).resolves({});
      dynamoMock.on(DescribeTableCommand).resolves({ Table: { TableStatus: 'ACTIVE' } });
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureLockTable('my-lock-table');

      expect(result).toEqual({ status: 'created' });
      expect(dynamoMock.commandCalls(CreateTableCommand)[0]!.args[0].input).toEqual({
        TableName: 'my-lock-table',
        AttributeDefinitions: [{ AttributeName: 'LockID', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
      expect(dynamoMock.commandCalls(DescribeTableCommand)).toHaveLength(1);
    });

    it('should treat ResourceInUseException as a success no-op without waiting', async () => {
      dynamoMock.on(CreateTableCommand).rejects(awsError('ResourceInUseException'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureLockTable('my-lock-table');

      expect(result).toEqual({ status: 'exists' });
      expect(dynamoMock.commandCalls(DescribeTableCommand)).toHaveLength(0);
    });

    it('should report failure with the error message for an unexpected CreateTable error', async () => {
      dynamoMock.on(CreateTableCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureLockTable('my-lock-table');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureLockTable('my-lock-table')).rejects.toThrow(
        BootstrapCredentialsNotConfiguredError,
      );
    });
  });

  describe('ensureTfvarsBucket', () => {
    it('should create the bucket with versioning and a 90-day noncurrent-version lifecycle rule on a fresh bucket', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureTfvarsBucket('my-tfvars-bucket');

      expect(result).toEqual({ status: 'created' });
      expect(s3Mock.commandCalls(CreateBucketCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-tfvars-bucket',
        CreateBucketConfiguration: { LocationConstraint: 'us-west-2' },
      });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-tfvars-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      });
      expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0]!.args[0].input).toEqual({
        Bucket: 'my-tfvars-bucket',
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
    });

    it('should treat BucketAlreadyOwnedByYou as a success no-op and still ensure versioning/lifecycle', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyOwnedByYou'));
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureTfvarsBucket('my-tfvars-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    });

    it('should skip CreateBucket in us-east-1 when HeadBucket confirms the bucket already exists', async () => {
      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
      const service = new BootstrapService(makeStore({ region: 'us-east-1' }));

      const result = await service.ensureTfvarsBucket('my-tfvars-bucket');

      expect(result).toEqual({ status: 'exists' });
      expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
    });

    it('should report a clear failure when the bucket name is owned by another account', async () => {
      s3Mock.on(CreateBucketCommand).rejects(awsError('BucketAlreadyExists'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureTfvarsBucket('taken-bucket-name');

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/already taken by another AWS account/i);
      expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    });

    it('should report failure with the error message when the lifecycle rule cannot be applied after a successful create', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});
      s3Mock.on(PutBucketVersioningCommand).resolves({});
      s3Mock.on(PutBucketLifecycleConfigurationCommand).rejects(new Error('access denied'));
      const service = new BootstrapService(makeStore({ region: 'us-west-2' }));

      const result = await service.ensureTfvarsBucket('my-tfvars-bucket');

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });

    it('should throw BootstrapCredentialsNotConfiguredError when no region is stored', async () => {
      const service = new BootstrapService(makeStore(undefined));

      await expect(service.ensureTfvarsBucket('my-tfvars-bucket')).rejects.toThrow(
        BootstrapCredentialsNotConfiguredError,
      );
    });
  });
});
