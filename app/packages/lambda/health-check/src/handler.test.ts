/**
 * Tests for the health-check Lambda handler. Covers: the destination host
 * always comes from the ECS attachment (never from config), the secret is
 * fetched only when `auth` is declared, no secret value or response body
 * ever reaches the logger, and every transport/credential failure is
 * fail-active.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DescribeTasksCommand, ECSClient } from '@aws-sdk/client-ecs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { GameServerHealthCheck } from '@hyveon/shared';

const ecsMock = mockClient(ECSClient);
const secretsManagerMock = mockClient(SecretsManagerClient);

process.env['AWS_REGION_'] = 'us-east-1';
process.env['ECS_CLUSTER'] = 'test-cluster';

const { handler } = await import('./handler.js');

/** Build a minimal, valid GameServerHealthCheck; override any field per test. */
function makeHealthCheck(overrides: Partial<GameServerHealthCheck> = {}): GameServerHealthCheck {
  return {
    kind: 'http',
    scheme: 'http',
    port: 8211,
    path: '/status',
    method: 'GET',
    timeoutMs: 2000,
    activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
    ...overrides,
  };
}

function runningTask(privateIp: string) {
  return {
    lastStatus: 'RUNNING',
    attachments: [
      {
        type: 'ElasticNetworkInterface',
        details: [
          { name: 'networkInterfaceId', value: 'eni-xyz' },
          { name: 'privateIPv4Address', value: privateIp },
        ],
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ecsMock.reset();
  secretsManagerMock.reset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('handler', () => {
  it('should resolve the destination host from the ECS attachment, never from config', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck({ port: 8212 }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://10.0.1.23:8212/status');
  });

  it('should not fetch a secret when the health check declares no auth', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck() });

    expect(secretsManagerMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it('should fetch the secret and inject it as the Authorization header when auth is declared', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    expect(secretsManagerMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('super-secret-token');
  });

  it('should override an operator-supplied Authorization header with the resolved credential', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'real-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        headers: { Authorization: 'stray-value' },
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('real-token');
  });

  it('should never let a secret value reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('super-secret-token');
  });

  it('should never let the response body reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1,"names":["secret-player-name"]}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck() });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('secret-player-name');
  });

  it('should be fail-active and log at warn when the ECS task has no matching attachment', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [{ lastStatus: 'RUNNING', attachments: [] }] });

    const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck() });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should be fail-active when the ECS task is not found', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [] });

    const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck() });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
  });

  it('should be fail-active when the secret is unavailable', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).rejects(new Error('ResourceNotFoundException'));

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should be fail-active when the request times out or is refused', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', healthCheck: makeHealthCheck() });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(verdict.reason).toContain('ECONNREFUSED');
  });

  it('should delegate a successful response to the engine and return a genuine verdict', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":0}}', { status: 200 }));

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({ activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 } }),
    });

    expect(verdict.active).toBe(false);
    expect(verdict.failureDerived).toBe(false);
  });
});
