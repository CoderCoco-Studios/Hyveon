import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  RestoreSecretCommand,
  ResourceNotFoundException,
  InvalidRequestException,
} from '@aws-sdk/client-secrets-manager';
import {
  SECRET_PLACEHOLDER,
  __resetSecretsClient,
  deleteHealthCheckAuthSecret,
  getBotToken,
  getPublicKey,
  healthCheckAuthSecretName,
  invalidateSecretsCache,
  putBotToken,
  putPublicKey,
  upsertHealthCheckAuthSecret,
} from './secretsStore.js';

const secrets = mockClient(SecretsManagerClient);

const BOT_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bot-token-abc';
const KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:public-key-def';

describe('getBotToken / getPublicKey', () => {
  beforeEach(() => {
    secrets.reset();
    __resetSecretsClient();
    invalidateSecretsCache();
  });

  it('should return the stored token when the secret has a real value', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: 'real-token' });
    const token = await getBotToken(BOT_ARN);
    expect(token).toBe('real-token');
  });

  it('should return null when the secret still holds the provisioning placeholder', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: SECRET_PLACEHOLDER });
    const token = await getBotToken(BOT_ARN);
    expect(token).toBeNull();
  });

  it('should return null when SecretString is empty', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: '' });
    const token = await getBotToken(BOT_ARN);
    expect(token).toBeNull();
  });

  it('should cache the result so repeated reads hit Secrets Manager once', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: 'real-token' });
    await getBotToken(BOT_ARN);
    await getBotToken(BOT_ARN);
    await getBotToken(BOT_ARN);
    expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('should cache independently per ARN so bot-token and public-key do not share a slot', async () => {
    secrets.on(GetSecretValueCommand, { SecretId: BOT_ARN }).resolves({ SecretString: 'token-v' });
    secrets.on(GetSecretValueCommand, { SecretId: KEY_ARN }).resolves({ SecretString: 'pubkey-v' });
    expect(await getBotToken(BOT_ARN)).toBe('token-v');
    expect(await getPublicKey(KEY_ARN)).toBe('pubkey-v');
  });

  it('should re-read after invalidateSecretsCache() so a UI save is visible next call', async () => {
    secrets
      .on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: 'old' })
      .resolvesOnce({ SecretString: 'new' });
    expect(await getBotToken(BOT_ARN)).toBe('old');
    invalidateSecretsCache();
    expect(await getBotToken(BOT_ARN)).toBe('new');
  });
});

describe('putBotToken / putPublicKey', () => {
  beforeEach(() => {
    secrets.reset();
    __resetSecretsClient();
    invalidateSecretsCache();
  });

  it('should write the bot token to the given secret ARN', async () => {
    secrets.on(PutSecretValueCommand).resolves({});
    await putBotToken(BOT_ARN, 'new-token');
    const calls = secrets.commandCalls(PutSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]!.input.SecretId).toBe(BOT_ARN);
    expect(calls[0]!.args[0]!.input.SecretString).toBe('new-token');
  });

  it('should evict the cache for this ARN after a write so the next read sees the new value', async () => {
    secrets
      .on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: 'old-token' })
      .resolvesOnce({ SecretString: 'new-token' });
    secrets.on(PutSecretValueCommand).resolves({});
    expect(await getBotToken(BOT_ARN)).toBe('old-token');
    await putBotToken(BOT_ARN, 'new-token');
    expect(await getBotToken(BOT_ARN)).toBe('new-token');
  });

  it('should delegate putPublicKey through the same mechanism', async () => {
    secrets.on(PutSecretValueCommand).resolves({});
    await putPublicKey(KEY_ARN, 'hex-public-key');
    const calls = secrets.commandCalls(PutSecretValueCommand);
    expect(calls[0]!.args[0]!.input.SecretId).toBe(KEY_ARN);
    expect(calls[0]!.args[0]!.input.SecretString).toBe('hex-public-key');
  });
});

describe('healthCheckAuthSecretName', () => {
  it('should build a deterministic per-game secret name', () => {
    expect(healthCheckAuthSecretName('palworld')).toBe('hyveon-palworld-healthcheck-auth');
  });
});

describe('upsertHealthCheckAuthSecret', () => {
  beforeEach(() => {
    secrets.reset();
    __resetSecretsClient();
  });

  afterEach(() => {
    secrets.reset();
  });

  it('should PutSecretValue and return the ARN when the secret already exists', async () => {
    secrets
      .on(PutSecretValueCommand, { SecretId: 'hyveon-palworld-healthcheck-auth' })
      .resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });

    const arn = await upsertHealthCheckAuthSecret('palworld', 'sk-abc123');

    expect(arn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf');
    expect(secrets.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('should CreateSecret and return the ARN when PutSecretValue reports the secret does not exist', async () => {
    secrets
      .on(PutSecretValueCommand)
      .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));
    secrets
      .on(CreateSecretCommand, { Name: 'hyveon-palworld-healthcheck-auth', SecretString: 'sk-abc123' })
      .resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });

    const arn = await upsertHealthCheckAuthSecret('palworld', 'sk-abc123');

    expect(arn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf');
  });

  it('should rethrow a PutSecretValue failure that is not ResourceNotFoundException', async () => {
    secrets.on(PutSecretValueCommand).rejects(new Error('AccessDenied'));

    await expect(upsertHealthCheckAuthSecret('palworld', 'sk-abc123')).rejects.toThrow('AccessDenied');
    expect(secrets.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('should restore a pending-deletion secret and retry PutSecretValue instead of falling through to CreateSecret', async () => {
    secrets
      .on(PutSecretValueCommand)
      .rejectsOnce(
        new InvalidRequestException({
          message:
            'You can\'t perform this operation on the secret because it was marked for deletion.',
          $metadata: {},
        }),
      )
      .resolvesOnce({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });
    secrets.on(RestoreSecretCommand).resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });

    const arn = await upsertHealthCheckAuthSecret('palworld', 'sk-abc123');

    expect(arn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf');
    const restoreCalls = secrets.commandCalls(RestoreSecretCommand);
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.args[0]!.input.SecretId).toBe('hyveon-palworld-healthcheck-auth');
    expect(secrets.commandCalls(PutSecretValueCommand)).toHaveLength(2);
    expect(secrets.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('should rethrow an InvalidRequestException that is not about pending deletion, without attempting a restore', async () => {
    secrets.on(PutSecretValueCommand).rejects(new InvalidRequestException({ message: 'Some other invalid request.', $metadata: {} }));

    await expect(upsertHealthCheckAuthSecret('palworld', 'sk-abc123')).rejects.toThrow('Some other invalid request.');
    expect(secrets.commandCalls(RestoreSecretCommand)).toHaveLength(0);
    expect(secrets.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });
});

describe('deleteHealthCheckAuthSecret', () => {
  beforeEach(() => {
    secrets.reset();
    __resetSecretsClient();
  });

  afterEach(() => {
    secrets.reset();
  });

  it('should DeleteSecret without ForceDeleteWithoutRecovery (default recovery window)', async () => {
    secrets.on(DeleteSecretCommand).resolves({});

    await deleteHealthCheckAuthSecret('palworld');

    const calls = secrets.commandCalls(DeleteSecretCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({ SecretId: 'hyveon-palworld-healthcheck-auth' });
  });

  it('should not throw when the secret does not exist', async () => {
    secrets
      .on(DeleteSecretCommand)
      .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));

    await expect(deleteHealthCheckAuthSecret('palworld')).resolves.toBeUndefined();
  });

  it('should rethrow a DeleteSecret failure that is not ResourceNotFoundException', async () => {
    secrets.on(DeleteSecretCommand).rejects(new Error('AccessDenied'));

    await expect(deleteHealthCheckAuthSecret('palworld')).rejects.toThrow('AccessDenied');
  });
});
