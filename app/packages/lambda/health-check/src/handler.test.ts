/**
 * Tests for the health-check Lambda handler. Covers: the destination host
 * always comes from the payload `privateIp` (never from config), no ECS call is made, the secret is
 * fetched only when `auth` is declared, no secret value or response body
 * ever reaches the logger, and every transport/credential failure is
 * fail-active.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HEALTH_CHECK_SECRET_DEADLINE_MS, type GameServerHealthCheck } from '@hyveon/shared';

const secretsManagerMock = mockClient(SecretsManagerClient);

process.env['AWS_REGION_'] = 'us-east-1';

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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  secretsManagerMock.reset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('handler', () => {
  // @spec RT-HEALTH-HTTP-001, RT-HEALTH-HTTP-002
  it('should take the destination host from the payload privateIp, never from config', async () => {
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', privateIp: '10.0.1.23', healthCheck: makeHealthCheck({ port: 8212 }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://10.0.1.23:8212/status');
  });

  it('should not fetch a secret when the health check declares no auth', async () => {
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', privateIp: '10.0.1.23', healthCheck: makeHealthCheck() });

    expect(secretsManagerMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  // @spec RT-HEALTH-AUTH-001
  it('should fetch the secret and inject it as the Authorization header when auth is declared', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    expect(secretsManagerMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('super-secret-token');
  });

  // @spec RT-HEALTH-AUTH-005
  it('should override an operator-supplied Authorization header with the resolved credential', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'real-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        headers: { Authorization: 'stray-value' },
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('real-token');
  });

  // @spec RT-HEALTH-AUTH-003
  it('should base64-encode a well-formed basic credential as Authorization: Basic', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }) });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expected = `Basic ${Buffer.from('admin:hunter2', 'utf8').toString('base64')}`;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(expected);
  });

  // @spec RT-HEALTH-AUTH-002
  it('should prefix a bearer credential as Authorization: Bearer', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'sk-abc123' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'bearer', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-abc123');
  });

  // @spec RT-HEALTH-AUTH-001
  it('should inject a raw credential verbatim when auth.type is explicitly "raw"', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('super-secret-token');
  });

  // @spec RT-HEALTH-AUTH-004
  it('should be fail-active when a basic credential secret is not valid JSON', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'not-json' });

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-AUTH-004
  it('should be fail-active when a basic credential secret is JSON but missing username/password', async () => {
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin' }) });

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
  });

  // @spec RT-HEALTH-LOG-004
  it('should never let a basic credential\'s username or password reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }) });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('hunter2');
    expect(allLoggedText).not.toContain('admin');
  });

  // @spec RT-HEALTH-LOG-004
  it('should never let a secret value reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('super-secret-token');
  });

  // @spec RT-HEALTH-LOG-004
  it('should never let the response body reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1,"names":["secret-player-name"]}}', { status: 200 }));

    await handler({ game: 'palworld', taskArn: 'task-arn', privateIp: '10.0.1.23', healthCheck: makeHealthCheck() });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('secret-player-name');
  });

  // @spec RT-HEALTH-HTTP-007, RT-HEALTH-FAIL-004
  it.each([undefined, null])('should be fail-active without a request when privateIp is %s', async (privateIp) => {
    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: privateIp as unknown as string,
      healthCheck: makeHealthCheck(),
    });

    expect(verdict).toMatchObject({ active: true, failureDerived: true });
    expect(verdict.reason).toMatch(/^health check failed:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-HTTP-008, RT-HEALTH-FAIL-004
  it.each(['', ' 10.0.1.23', '10.0.1.23 ', '::1', 'fe80::1', 'evil.example.com', '10.0.1', '10.0.1.256', '10.0.1.23/evil'])(
    'should be fail-active without a request when privateIp is %j',
    async (privateIp) => {
      const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', privateIp, healthCheck: makeHealthCheck() });

      expect(verdict).toMatchObject({ active: true, failureDerived: true });
      expect(verdict.reason).toMatch(/^health check failed:/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // @spec RT-HEALTH-HTTP-010
  it.each(['10.0.1.23', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1'])(
    'should accept the private IPv4 literal %s',
    async (privateIp) => {
      fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

      await handler({ game: 'palworld', taskArn: 'task-arn', privateIp, healthCheck: makeHealthCheck() });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://${privateIp}:8211/status`);
    },
  );

  // @spec RT-HEALTH-HTTP-010
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '224.0.0.1',
    '239.255.255.255',
    '255.255.255.255',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '100.64.0.1',
  ])('should be fail-active without a request when privateIp %s is outside the private ranges', async (privateIp) => {
    const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', privateIp, healthCheck: makeHealthCheck() });

    expect(verdict).toMatchObject({ active: true, failureDerived: true });
    expect(verdict.reason).toMatch(/^health check failed:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-HTTP-006, RT-HEALTH-HTTP-011
  it.each(['@evil.example.com/x', '.evil.example.com/x', '\\evil.example.com/x'])(
    'should keep the connect address on privateIp when the declared path is %j',
    async (path) => {
      fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

      await handler({ game: 'palworld', taskArn: 'task-arn', privateIp: '10.0.1.23', healthCheck: makeHealthCheck({ path }) });

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(new URL(url).hostname).toBe('10.0.1.23');
    },
  );

  // @spec RT-HEALTH-HTTP-011, RT-HEALTH-FAIL-004
  it('should be fail-active without a request when the declared path would replace the authority', async () => {
    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({ path: '//evil.example.com/x' }),
    });

    expect(verdict).toMatchObject({ active: true, failureDerived: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-HTTP-009
  it('should make no ECS API call and not depend on the ECS SDK', () => {
    const source = readFileSync(fileURLToPath(new URL('./handler.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain('client-ecs');
    expect(source).not.toContain('ECS_CLUSTER');
  });

  // @spec RT-HEALTH-FAIL-005, RT-HEALTH-FAIL-007, RT-HEALTH-FAIL-004
  it('should be fail-active without a request when GetSecretValue exceeds its overall deadline', async () => {
    vi.useFakeTimers();
    secretsManagerMock.on(GetSecretValueCommand).callsFake(() => new Promise(() => undefined));

    const pending = handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_SECRET_DEADLINE_MS + 1);
    const verdict = await pending;
    vi.useRealTimers();

    expect(verdict).toMatchObject({ active: true, failureDerived: true });
    expect(verdict.reason).toMatch(/^health check failed:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-FAIL-005
  it('should abort the GetSecretValue signal exactly at the deadline so SDK retries stop', async () => {
    vi.useFakeTimers();
    secretsManagerMock.on(GetSecretValueCommand).callsFake(() => new Promise(() => undefined));
    const sendSpy = vi.spyOn(SecretsManagerClient.prototype, 'send');

    const pending = handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    const signal = (sendSpy.mock.calls[0]?.[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_SECRET_DEADLINE_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await pending;
    vi.useRealTimers();
  });

  // @spec RT-HEALTH-FAIL-004
  it('should be fail-active when the secret is unavailable', async () => {
    secretsManagerMock.on(GetSecretValueCommand).rejects(new Error('ResourceNotFoundException'));

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({
        auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @spec RT-HEALTH-FAIL-004
  it('should be fail-active when the request times out or is refused', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const verdict = await handler({ game: 'palworld', taskArn: 'task-arn', privateIp: '10.0.1.23', healthCheck: makeHealthCheck() });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(verdict.reason).toContain('ECONNREFUSED');
  });

  // @spec RT-HEALTH-DECL-006
  it('should delegate a successful response to the engine and return a genuine verdict', async () => {
    fetchMock.mockResolvedValue(new Response('{"players":{"online":0}}', { status: 200 }));

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      privateIp: '10.0.1.23',
      healthCheck: makeHealthCheck({ activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 } }),
    });

    expect(verdict.active).toBe(false);
    expect(verdict.failureDerived).toBe(false);
  });
});
