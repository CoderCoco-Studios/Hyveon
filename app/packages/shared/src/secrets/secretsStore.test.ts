import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SECRET_PLACEHOLDER,
  __resetSecretsClient,
  getBotToken,
  getPublicKey,
  invalidateSecretsCache,
  putBotToken,
  putPublicKey,
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
