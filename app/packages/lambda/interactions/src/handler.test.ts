/**
 * Tests for the Discord InteractionsLambda handler.
 *
 * Covers: signature verification, PING/PONG, the permission check against
 * DynamoDB-stored config, autocomplete filtering, deferred-ack dispatch, and
 * async-invocation of the followup Lambda. External clients (Secrets Manager,
 * DynamoDB, Lambda Invoke, and the `@noble/ed25519` verify function) are
 * mocked — we never hit the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Mock @noble/ed25519 so we can flip verification success/failure per test.
const verifyAsyncMock = vi.fn();
vi.mock('@noble/ed25519', () => ({
  verifyAsync: (...args: unknown[]) => verifyAsyncMock(...args),
}));

// Mock the shared config + secrets stores so we never hit AWS.
const getPublicKeyMock = vi.fn();
const getEffectiveDiscordConfigMock = vi.fn();
vi.mock('@hyveon/shared', async () => {
  const actual = await vi.importActual<typeof import('@hyveon/shared')>('@hyveon/shared');
  return {
    ...actual,
    getPublicKey: (...args: unknown[]) => getPublicKeyMock(...args),
    getEffectiveDiscordConfig: (...args: unknown[]) => getEffectiveDiscordConfigMock(...args),
  };
});

const lambdaMock = mockClient(LambdaClient);

process.env['TABLE_NAME'] = 'test-discord';
process.env['DISCORD_PUBLIC_KEY_SECRET_ARN'] = 'arn:aws:secretsmanager:us-east-1:123:secret:pubkey';
process.env['FOLLOWUP_LAMBDA_NAME'] = 'test-followup';
process.env['GAME_NAMES'] = 'palworld,satisfactory';
process.env['AWS_REGION_'] = 'us-east-1';

// Import after env + mocks so the handler picks them up.
const { handler } = await import('./handler.js');

function makeEvent(body: unknown, sig = 'deadbeef', ts = '1700000000'): APIGatewayProxyEventV2 {
  return {
    headers: {
      'x-signature-ed25519': sig,
      'x-signature-timestamp': ts,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function parsed(res: APIGatewayProxyResultV2): { statusCode: number; body: unknown } {
  if (typeof res === 'string') return { statusCode: 200, body: JSON.parse(res) };
  const code = res.statusCode ?? 200;
  const body = res.body ? (() => {
    try {
      return JSON.parse(res.body);
    } catch {
      return res.body;
    }
  })() : undefined;
  return { statusCode: code, body };
}

beforeEach(() => {
  lambdaMock.reset();
  verifyAsyncMock.mockReset();
  getPublicKeyMock.mockReset();
  getEffectiveDiscordConfigMock.mockReset();
  getPublicKeyMock.mockResolvedValue('0a'.repeat(32));
  getEffectiveDiscordConfigMock.mockResolvedValue({
    clientId: 'app-id',
    allowedGuilds: ['G1'],
    admins: { userIds: ['ADMIN'], roleIds: [] },
    gamePermissions: {
      palworld: { userIds: ['U1'], roleIds: [], actions: ['start', 'stop', 'status'] },
      satisfactory: { userIds: [], roleIds: [], actions: [] },
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InteractionsLambda: signature verification', () => {
  it('should return 401 when the signature headers are missing', async () => {
    const res = await handler({
      headers: {},
      body: '{}',
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2);
    const p = parsed(res);
    expect(p.statusCode).toBe(401);
  });

  it('should return 401 when the public key secret is unset', async () => {
    getPublicKeyMock.mockResolvedValueOnce(null);
    const res = await handler(makeEvent({ type: 1 }));
    expect(parsed(res).statusCode).toBe(401);
  });

  it('should return 401 when ed25519 verification fails', async () => {
    verifyAsyncMock.mockResolvedValueOnce(false);
    const res = await handler(makeEvent({ type: 1 }));
    expect(parsed(res).statusCode).toBe(401);
  });

  it('should return 401 when the signature hex contains a non-hex digit', async () => {
    // 'parseInt("0g", 16)' returns 0 rather than NaN — without pair-validation this would
    // silently decode as a valid byte and let a malformed signature reach verifyAsync.
    verifyAsyncMock.mockResolvedValue(true);
    const res = await handler(makeEvent({ type: 1 }, '0g' + 'aa'.repeat(31)));
    expect(parsed(res).statusCode).toBe(401);
    expect(verifyAsyncMock).not.toHaveBeenCalled();
  });

  it('should verify against timestamp + raw body concatenation', async () => {
    verifyAsyncMock.mockResolvedValueOnce(true);
    await handler(makeEvent({ type: 1 }, 'aa', '1234567890'));
    expect(verifyAsyncMock).toHaveBeenCalledTimes(1);
    // The second arg is the message bytes; decode and confirm it begins with the timestamp.
    const msgBytes = verifyAsyncMock.mock.calls[0]![1] as Uint8Array;
    const msgString = new TextDecoder().decode(msgBytes);
    expect(msgString.startsWith('1234567890')).toBe(true);
    expect(msgString).toContain('"type":1');
  });
});

describe('InteractionsLambda: PING handshake', () => {
  it('should respond with type:1 PONG on a valid PING', async () => {
    verifyAsyncMock.mockResolvedValue(true);
    const res = await handler(makeEvent({ type: 1, id: 'i1', application_id: 'app', token: 'tok' }));
    const p = parsed(res);
    expect(p.statusCode).toBe(200);
    expect(p.body).toEqual({ type: 1 });
  });
});

describe('InteractionsLambda: APPLICATION_COMMAND dispatch', () => {
  beforeEach(() => {
    verifyAsyncMock.mockResolvedValue(true);
    lambdaMock.on(InvokeCommand).resolves({});
  });

  function commandEvent(opts: {
    name: string;
    guildId?: string;
    userId?: string;
    roles?: string[];
    game?: string;
  }): APIGatewayProxyEventV2 {
    return makeEvent({
      id: 'i1',
      application_id: 'app-id',
      token: 'tok-1',
      type: 2,
      guild_id: opts.guildId ?? 'G1',
      member: {
        user: { id: opts.userId ?? 'U1' },
        roles: opts.roles ?? [],
      },
      data: {
        name: opts.name,
        options: opts.game ? [{ type: 3, name: 'game', value: opts.game }] : [],
      },
    });
  }

  it('should refuse a command from a guild that is not on the allowlist', async () => {
    const res = await handler(commandEvent({ name: 'server-start', guildId: 'GX', game: 'palworld' }));
    const body = parsed(res).body as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toMatch(/not enabled/i);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('should refuse a command when the user lacks permission for the action', async () => {
    const res = await handler(commandEvent({ name: 'server-start', userId: 'NOBODY', game: 'palworld' }));
    const body = parsed(res).body as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toMatch(/don't have permission/);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('should reply with a deferred ack and async-invoke the followup Lambda on a permitted command', async () => {
    const res = await handler(commandEvent({ name: 'server-start', userId: 'U1', game: 'palworld' }));
    const body = parsed(res).body as { type: number; data: { flags: number } };
    expect(body.type).toBe(5);
    expect(body.data.flags).toBe(64);
    const invokes = lambdaMock.commandCalls(InvokeCommand);
    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.args[0]!.input.FunctionName).toBe('test-followup');
    expect(invokes[0]!.args[0]!.input.InvocationType).toBe('Event');
    const payload = JSON.parse(
      Buffer.from(invokes[0]!.args[0]!.input.Payload as Uint8Array).toString('utf8'),
    );
    expect(payload.kind).toBe('start');
    expect(payload.game).toBe('palworld');
    expect(payload.interactionToken).toBe('tok-1');
  });

  it('should reject server-start without a game option', async () => {
    const res = await handler(commandEvent({ name: 'server-start', userId: 'U1' }));
    const body = parsed(res).body as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toMatch(/required/i);
  });

  it('should dispatch server-list without requiring a game option', async () => {
    const res = await handler(commandEvent({ name: 'server-list', userId: 'U1' }));
    const body = parsed(res).body as { type: number };
    expect(body.type).toBe(5);
    const invokes = lambdaMock.commandCalls(InvokeCommand);
    expect(invokes).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(invokes[0]!.args[0]!.input.Payload as Uint8Array).toString('utf8'),
    );
    expect(payload.kind).toBe('list');
  });

  it('should treat server-status without a game as list-style dispatch', async () => {
    const res = await handler(commandEvent({ name: 'server-status', userId: 'U1' }));
    expect((parsed(res).body as { type: number }).type).toBe(5);
    const payload = JSON.parse(
      Buffer.from(
        lambdaMock.commandCalls(InvokeCommand)[0]!.args[0]!.input.Payload as Uint8Array,
      ).toString('utf8'),
    );
    expect(payload.kind).toBe('list');
  });

  it('should allow admin users to run commands they have no explicit per-game entry for', async () => {
    const res = await handler(commandEvent({ name: 'server-stop', userId: 'ADMIN', game: 'satisfactory' }));
    expect((parsed(res).body as { type: number }).type).toBe(5);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });
});

describe('InteractionsLambda: APPLICATION_COMMAND_AUTOCOMPLETE', () => {
  beforeEach(() => {
    verifyAsyncMock.mockResolvedValue(true);
  });

  function autocompleteEvent(partial: string, name = 'server-start'): APIGatewayProxyEventV2 {
    return makeEvent({
      id: 'i1',
      application_id: 'app-id',
      token: 'tok-1',
      type: 4,
      guild_id: 'G1',
      member: { user: { id: 'U1' }, roles: [] },
      data: {
        name,
        options: [{ type: 3, name: 'game', value: partial, focused: true }],
      },
    });
  }

  it('should return only games the caller can run and matching the partial input', async () => {
    const res = await handler(autocompleteEvent('pal'));
    const body = parsed(res).body as { type: number; data: { choices: { name: string; value: string }[] } };
    expect(body.type).toBe(8);
    expect(body.data.choices).toEqual([{ name: 'palworld', value: 'palworld' }]);
  });

  it('should cap autocomplete choices at 25 to satisfy the Discord limit', async () => {
    const manyGames = Array.from({ length: 50 }, (_, i) => `game${i}`);
    process.env['GAME_NAMES'] = manyGames.join(',');
    getEffectiveDiscordConfigMock.mockResolvedValueOnce({
      clientId: 'app-id',
      allowedGuilds: ['G1'],
      admins: { userIds: ['U1'], roleIds: [] },
      gamePermissions: {},
    });
    const res = await handler(autocompleteEvent('game'));
    const body = parsed(res).body as { data: { choices: unknown[] } };
    expect(body.data.choices).toHaveLength(25);
    process.env['GAME_NAMES'] = 'palworld,satisfactory';
  });

  it('should return an empty choice list when no game option is focused', async () => {
    const evt = makeEvent({
      id: 'i1',
      application_id: 'app-id',
      token: 'tok-1',
      type: 4,
      guild_id: 'G1',
      member: { user: { id: 'U1' }, roles: [] },
      data: { name: 'server-start', options: [] },
    });
    const res = await handler(evt);
    const body = parsed(res).body as { type: number; data: { choices: unknown[] } };
    expect(body.type).toBe(8);
    expect(body.data.choices).toEqual([]);
  });
});
