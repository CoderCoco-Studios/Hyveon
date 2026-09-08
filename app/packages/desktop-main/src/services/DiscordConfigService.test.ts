/**
 * Tests for the DynamoDB + Secrets Manager-backed DiscordConfigService.
 *
 * The service is a thin wrapper over the cloud-agnostic `DiscordConfigStore`
 * and `SecretsStore` contracts (`AwsDiscordConfigStore`/`AwsSecretsStore` in
 * production, stubs here) — the stores themselves have their own tests under
 * the cloud-aws package. Here we validate the wiring: that the right stores
 * get called with the right args, that the redacted view strips both
 * secrets, and that the controller-facing contract (same method names as the
 * old file-backed service) still behaves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordConfigStore, SecretsStore, StackOutputs } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../logger.js';
import { DiscordConfigService } from './DiscordConfigService.js';
import { ConfigService } from './ConfigService.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';

/** Minimal `StackOutputs` stub exposing just the Discord-store fields. */
const STACK_OUTPUTS: StackOutputs = stackOutputs({
  ecsClusterName: '',
  ecsClusterArn: '',
  subnetIds: [],
  securityGroupId: '',
  fileManagerSecurityGroupId: '',
  efsFileSystemId: '',
  efsAccessPoints: {},
  domainName: '',
  gameNames: [],
  discordTableName: 'test-discord',
  auditTableName: '',
  runsTableName: '',
  discordBotTokenSecretArn: 'arn:bot-token',
  discordPublicKeySecretArn: 'arn:public-key',
  fileBrowserCredentialSecretArn: 'arn:filebrowser-credential',
  fileBrowserSchedulerRoleArn: 'arn:filebrowser-scheduler-role',
  interactionsInvokeUrl: 'https://url',
});

/** `get` mock for the injected `SecretsStore` stub — keyed by secret name/ARN so bot-token and public-key lookups can be stubbed independently. */
const secretsGetMock = vi.fn<SecretsStore['get']>();
const secretsPutMock = vi.fn<SecretsStore['put']>();
const secretsExistsMock = vi.fn<SecretsStore['exists']>();

/** Builds a `SecretsStore`-shaped stub backed by the shared mocks above. */
function makeSecretsStore(): SecretsStore {
  return { get: secretsGetMock, put: secretsPutMock, exists: secretsExistsMock };
}

/** Mocks for the injected `DiscordConfigStore` stub. */
const getConfigMock = vi.fn<DiscordConfigStore['getConfig']>();
const getBaseConfigMock = vi.fn<DiscordConfigStore['getBaseConfig']>();
const putConfigMock = vi.fn<DiscordConfigStore['putConfig']>();

/**
 * Builds a `DiscordConfigStore`-shaped stub backed by the mocks above.
 * `DiscordConfigService` must go through the injected `DiscordConfigStore`
 * (bound to `AwsDiscordConfigStore`, which resolves the wizard's credentials
 * itself) rather than `@hyveon/shared`'s `getDocClient()` directly, which
 * falls back to the AWS SDK's default provider chain and throws a spurious
 * `CredentialsProviderError` once any ambient host `aws login` session
 * expires, even with valid wizard-stored credentials.
 */
function makeDiscordStore(): DiscordConfigStore {
  return { getConfig: getConfigMock, getBaseConfig: getBaseConfigMock, putConfig: putConfigMock };
}

function makeService(
  outputs: StackOutputs | null = STACK_OUTPUTS,
  secrets: SecretsStore = makeSecretsStore(),
  discordStore: DiscordConfigStore = makeDiscordStore(),
): DiscordConfigService {
  const config = {
    getStackOutputs: async () => outputs,
    getRegion: () => 'us-east-1',
  } as Partial<ConfigService> as ConfigService;
  return new DiscordConfigService(config, secrets, discordStore);
}

beforeEach(() => {
  getConfigMock.mockReset();
  getBaseConfigMock.mockReset();
  putConfigMock.mockReset();
  secretsGetMock.mockReset();
  secretsPutMock.mockReset();
  secretsExistsMock.mockReset();
  getConfigMock.mockResolvedValue({
    clientId: '',
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
    gamePermissions: {},
  });
  getBaseConfigMock.mockResolvedValue({
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
  });
  putConfigMock.mockResolvedValue(undefined);
  secretsGetMock.mockResolvedValue(undefined);
  secretsPutMock.mockResolvedValue(undefined);
  vi.mocked(logger.debug).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('DiscordConfigService construction', () => {
  it('should return an empty config when Pulumi stack outputs are missing rather than crash the request', async () => {
    // `load()` catches the "table name missing" error so a freshly-cloned
    // repo where an apply hasn't run can still render the web UI (with
    // empty config) instead of 500ing on every Discord controller call.
    const svc = makeService(null);
    const cfg = await svc.getConfig();
    expect(cfg).toEqual({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('should log a warning-level detail-free error and degrade to an empty config when the DynamoDB read fails', async () => {
    getConfigMock.mockRejectedValueOnce(new Error('ResourceNotFoundException'));
    const svc = makeService();

    const cfg = await svc.getConfig();

    expect(cfg).toEqual({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load Discord config from DynamoDB',
      { error: 'ResourceNotFoundException' },
    );
  });
});

describe('DiscordConfigService.getRedacted', () => {
  it('should indicate when both secrets are configured and return the DDB config body', async () => {
    getConfigMock.mockResolvedValue({
      clientId: 'client-xyz',
      allowedGuilds: ['G1'],
      admins: { userIds: ['U1'], roleIds: [] },
      gamePermissions: {},
    });
    secretsGetMock.mockImplementation(async (name: string) => {
      if (name === 'arn:bot-token') return 'real-token';
      if (name === 'arn:public-key') return 'hex-key';
      return undefined;
    });

    const redacted = await makeService().getRedacted();

    expect(redacted).toMatchObject({
      clientId: 'client-xyz',
      allowedGuilds: ['G1'],
      botTokenSet: true,
      publicKeySet: true,
    });
    expect(redacted).not.toHaveProperty('botToken');
    expect(redacted).not.toHaveProperty('publicKey');
    expect(secretsGetMock).toHaveBeenCalledWith('arn:bot-token');
    expect(secretsGetMock).toHaveBeenCalledWith('arn:public-key');
  });

  it('should flag both secrets as unset when they still hold the placeholder', async () => {
    secretsGetMock.mockResolvedValue(undefined);
    const redacted = await makeService().getRedacted();
    expect(redacted.botTokenSet).toBe(false);
    expect(redacted.publicKeySet).toBe(false);
  });

  it('should include base guild and admin lists from the BASE#discord row', async () => {
    getBaseConfigMock.mockResolvedValue({
      allowedGuilds: ['G-base'],
      admins: { userIds: ['U-base'], roleIds: ['R-base'] },
    });
    const redacted = await makeService().getRedacted();
    expect(redacted.baseAllowedGuilds).toEqual(['G-base']);
    expect(redacted.baseAdmins).toEqual({ userIds: ['U-base'], roleIds: ['R-base'] });
  });

  it('should return empty base lists when no BASE#discord row exists', async () => {
    getBaseConfigMock.mockResolvedValue({ allowedGuilds: [], admins: { userIds: [], roleIds: [] } });
    const redacted = await makeService().getRedacted();
    expect(redacted.baseAllowedGuilds).toEqual([]);
    expect(redacted.baseAdmins).toEqual({ userIds: [], roleIds: [] });
  });

  it('should resolve with both secrets unset instead of throwing when Pulumi stack outputs are missing', async () => {
    // Regression test: `botTokenSecretArn`/`publicKeySecretArn` throw when
    // the stack hasn't been deployed yet. That throw used to happen before
    // `secrets.get(...)`'s `.catch()` was attached, so it escaped
    // `getRedacted()` uncaught — NestJS wrapped it in an RxJS Observable and
    // Electron's IPC bridge failed to clone it back to the renderer.
    const svc = makeService(null);
    const redacted = await svc.getRedacted();
    expect(redacted.botTokenSet).toBe(false);
    expect(redacted.publicKeySet).toBe(false);
    expect(secretsGetMock).not.toHaveBeenCalled();
  });
});

describe('DiscordConfigService.setCredentials', () => {
  it('should route clientId to DynamoDB and both secrets to Secrets Manager', async () => {
    const svc = makeService();
    const ok = await svc.setCredentials({ clientId: 'abc', botToken: 'tok', publicKey: 'hex' });
    expect(ok).toBe(true);
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'abc' }));
    expect(secretsPutMock).toHaveBeenCalledWith('arn:bot-token', 'tok');
    expect(secretsPutMock).toHaveBeenCalledWith('arn:public-key', 'hex');
  });

  it('should reject non-string inputs without writing anything', async () => {
    const svc = makeService();
    const ok = await svc.setCredentials({ clientId: 42 });
    expect(ok).toBe(false);
    expect(putConfigMock).not.toHaveBeenCalled();
    expect(secretsPutMock).not.toHaveBeenCalled();
  });

  it('should leave a field unchanged when its key is omitted from the body', async () => {
    const svc = makeService();
    await svc.setCredentials({ publicKey: 'hex' });
    expect(secretsPutMock).toHaveBeenCalledWith('arn:public-key', 'hex');
    expect(secretsPutMock).not.toHaveBeenCalledWith('arn:bot-token', expect.anything());
    expect(putConfigMock).not.toHaveBeenCalled();
  });

  it('should skip Secrets Manager writes when a token field is an empty string', async () => {
    const svc = makeService();
    await svc.setCredentials({ botToken: '' });
    expect(secretsPutMock).not.toHaveBeenCalled();
  });

  it('should not wipe the stored clientId when clientId is an empty string', async () => {
    const svc = makeService();
    await svc.setCredentials({ clientId: '' });
    expect(putConfigMock).not.toHaveBeenCalled();
  });

  it('should not wipe the stored clientId when clientId is whitespace-only', async () => {
    const svc = makeService();
    await svc.setCredentials({ clientId: '   ' });
    expect(putConfigMock).not.toHaveBeenCalled();
  });

  it('should trim clientId before persisting it', async () => {
    const svc = makeService();
    await svc.setCredentials({ clientId: '  abc  ' });
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'abc' }));
  });

  it('should log an error and rethrow with just the message when a Secrets Manager write fails', async () => {
    secretsPutMock.mockRejectedValueOnce(new Error('AccessDeniedException'));
    const svc = makeService();

    await expect(svc.setCredentials({ botToken: 'tok' })).rejects.toThrow('AccessDeniedException');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to write Discord bot credentials to Secrets Manager',
      { error: 'AccessDeniedException' },
    );
  });
});

describe('DiscordConfigService.allowedGuilds mutations', () => {
  it('should add a guild idempotently (no-op if already present)', async () => {
    getConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: ['G1'],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    const svc = makeService();
    await svc.addAllowedGuild('G1');
    expect(putConfigMock).not.toHaveBeenCalled();
  });

  it('should persist an added guild when it is new', async () => {
    const svc = makeService();
    await svc.addAllowedGuild('G2');
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ allowedGuilds: ['G2'] }));
  });

  it('should remove a guild from the dynamic allowlist and return ok', async () => {
    getConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: ['G1', 'G2'],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    const svc = makeService();
    const result = await svc.removeAllowedGuild('G1');
    expect(result).toEqual({ ok: true });
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ allowedGuilds: ['G2'] }));
  });

  it('should refuse to remove a guild that is in the base config', async () => {
    getBaseConfigMock.mockResolvedValue({
      allowedGuilds: ['G-base'],
      admins: { userIds: [], roleIds: [] },
    });
    const svc = makeService();
    const result = await svc.removeAllowedGuild('G-base');
    expect(result).toMatchObject({ ok: false });
    expect(putConfigMock).not.toHaveBeenCalled();
  });

  it('should dedupe and drop empty strings when setAllowedGuilds is called', async () => {
    const svc = makeService();
    await svc.setAllowedGuilds(['G1', '', 'G1', 'G2']);
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ allowedGuilds: ['G1', 'G2'] }));
  });

  it('should log an error and rethrow with just the message when the DynamoDB write fails', async () => {
    putConfigMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    const svc = makeService();

    await expect(svc.setAllowedGuilds(['G1'])).rejects.toThrow('ProvisionedThroughputExceededException');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to save Discord config to DynamoDB',
      { error: 'ProvisionedThroughputExceededException' },
    );
  });
});

describe('DiscordConfigService.setGamePermission', () => {
  it('should persist a sanitized permission entry for a known game', async () => {
    const svc = makeService();
    const ok = await svc.setGamePermission('palworld', {
      userIds: ['U1'],
      roleIds: ['R1'],
      actions: ['start', 'nope'],
    });
    expect(ok).toBe(true);
    expect(putConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gamePermissions: { palworld: { userIds: ['U1'], roleIds: ['R1'], actions: ['start'] } },
      }),
    );
  });

  it('should reject prototype-pollution game keys without writing', async () => {
    const svc = makeService();
    const ok = await svc.setGamePermission('__proto__', { userIds: [], roleIds: [], actions: [] });
    expect(ok).toBe(false);
    expect(putConfigMock).not.toHaveBeenCalled();
  });
});

describe('DiscordConfigService.deleteGamePermission', () => {
  it('should remove the entry and persist the updated config', async () => {
    getConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {
        palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] },
      },
    });
    const svc = makeService();
    const ok = await svc.deleteGamePermission('palworld');
    expect(ok).toBe(true);
    expect(putConfigMock).toHaveBeenCalledWith(expect.objectContaining({ gamePermissions: {} }));
  });

  it('should refuse to delete with an unsafe key', async () => {
    const svc = makeService();
    const ok = await svc.deleteGamePermission('constructor');
    expect(ok).toBe(false);
    expect(putConfigMock).not.toHaveBeenCalled();
  });
});
