import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageHandler } from '@nestjs/microservices';
import { BridgedElectronIPCTransport, registerIpcMainBridges, SELF_BRIDGED_PATTERNS } from './ipc-main-bridge.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle` / `ipcMain.removeHandler` call so tests can
 * assert on bridge registration without a real Electron main process.
 */
const { mockIpcMainHandle, mockIpcMainRemoveHandler, mockLoggerError } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainRemoveHandler = vi.fn();
  const mockLoggerError = vi.fn();
  return { mockIpcMainHandle, mockIpcMainRemoveHandler, mockLoggerError };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock('./logger.js', () => ({
  logger: { error: mockLoggerError },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `BridgedElectronIPCTransport` whose `messagePatternHandlers` map
 * is pre-seeded with a `vi.fn()` NestJS message handler per `patterns`
 * entry, mirroring the shape `Server.addHandler` would populate at runtime.
 */
function makeTransport(patterns: string[]): {
  transport: BridgedElectronIPCTransport;
  handlers: Map<string, MessageHandler>;
} {
  const transport = new BridgedElectronIPCTransport();
  const handlers = transport.messagePatternHandlers;
  for (const pattern of patterns) {
    handlers.set(pattern, vi.fn().mockResolvedValue(undefined));
  }
  return { transport, handlers };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('registerIpcMainBridges', () => {
  // registerIpcMainBridges only wires the bridge when running inside a real
  // Electron main process, detected via `process.versions.electron`. Vitest
  // runs under plain Node where it's undefined, so fake it for the "is
  // Electron" cases and restore afterwards.
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setElectron('30.0.0');
  });
  afterEach(() => setElectron(realElectronVersion));

  it('should be a silent no-op when not running inside an Electron main process', async () => {
    // Plain-Node runtimes (integration test server, Docker, CI) have no
    // `process.versions.electron`; importing electron there would throw, so
    // the bridge must skip without touching ipcMain at all.
    setElectron(undefined);
    const { transport } = makeTransport(['games.list', 'env.get']);

    await expect(registerIpcMainBridges(transport)).resolves.toBeUndefined();

    expect(mockIpcMainHandle).not.toHaveBeenCalled();
    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
  });

  it('should register a removeHandler-then-handle pair for every non-excluded pattern', async () => {
    const patterns = ['games.list', 'games.status', 'env.get', 'costs.estimate', 'logs.get'];
    const { transport } = makeTransport(patterns);

    await registerIpcMainBridges(transport);

    for (const pattern of patterns) {
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith(pattern);
      expect(mockIpcMainHandle).toHaveBeenCalledWith(pattern, expect.any(Function));
    }
  });

  it('should call removeHandler before handle for each bridged pattern', async () => {
    const { transport } = makeTransport(['games.list']);

    await registerIpcMainBridges(transport);

    const removeCall = mockIpcMainRemoveHandler.mock.invocationCallOrder[0];
    const handleCall = mockIpcMainHandle.mock.invocationCallOrder[0];
    expect(removeCall).toBeLessThan(handleCall);
  });

  it('should invoke the underlying NestJS handler as handler(payload, { evt }) when the ipcMain.handle callback fires', async () => {
    const { transport, handlers } = makeTransport(['games.list']);
    const handler = handlers.get('games.list')!;

    await registerIpcMainBridges(transport);

    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'games.list',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    const fakeEvt = { sender: {} };
    const payload = { some: 'payload' };
    await registeredCallback(fakeEvt, payload);

    expect(handler).toHaveBeenCalledWith(payload, { evt: fakeEvt });
  });

  it('should skip "logs.stream" entirely, leaving it to bridge itself', async () => {
    expect(SELF_BRIDGED_PATTERNS.has('logs.stream')).toBe(true);

    const { transport } = makeTransport(['logs.stream', 'logs.get']);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalledWith('logs.stream');
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith('logs.stream', expect.any(Function));
    // The sibling pattern on the same map is still bridged normally.
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('logs.get');
    expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.get', expect.any(Function));
  });

  it('should skip "iac.plan" entirely, leaving it to bridge itself', async () => {
    expect(SELF_BRIDGED_PATTERNS.has('iac.plan')).toBe(true);

    const { transport } = makeTransport(['iac.plan', 'games.list']);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalledWith('iac.plan');
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith('iac.plan', expect.any(Function));
    // The sibling pattern on the same map is still bridged normally.
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('games.list');
    expect(mockIpcMainHandle).toHaveBeenCalledWith('games.list', expect.any(Function));
  });

  it('should skip "iac.rollback.confirm" entirely, leaving it to bridge itself', async () => {
    // "iac.rollback.confirm" must stay in SELF_BRIDGED_PATTERNS: IacController.confirmRollback
    // takes an undecorated `ctx` second parameter exactly like iac.plan/apply/destroy — routing
    // it through the generic bridge would silently drop `ctx`, crashing every real invocation.
    // See ipc-main-bridge.ts's own doc comment for the full root cause.
    expect(SELF_BRIDGED_PATTERNS.has('iac.rollback.confirm')).toBe(true);

    const { transport } = makeTransport(['iac.rollback.confirm', 'games.list']);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalledWith('iac.rollback.confirm');
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith('iac.rollback.confirm', expect.any(Function));
    // The sibling pattern on the same map is still bridged normally.
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('games.list');
    expect(mockIpcMainHandle).toHaveBeenCalledWith('games.list', expect.any(Function));
  });

  it('should skip "iac.stack.initialize" entirely, leaving it to bridge itself', async () => {
    // IacController.initializeStack streams `onPhase` progress over its own
    // side channels, exactly like `iac.plan`, so it must self-bridge too.
    expect(SELF_BRIDGED_PATTERNS.has('iac.stack.initialize')).toBe(true);

    const { transport } = makeTransport(['iac.stack.initialize', 'games.list']);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalledWith('iac.stack.initialize');
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith('iac.stack.initialize', expect.any(Function));
    // The sibling pattern on the same map is still bridged normally.
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('games.list');
    expect(mockIpcMainHandle).toHaveBeenCalledWith('games.list', expect.any(Function));
  });

  it('should be a no-op when the transport has no registered handlers', async () => {
    const { transport } = makeTransport([]);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainHandle).not.toHaveBeenCalled();
    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
  });

  it('should resolve with the handler result unchanged when the handler succeeds', async () => {
    const { transport, handlers } = makeTransport(['games.list']);
    vi.mocked(handlers.get('games.list')!).mockResolvedValue({ ok: true });

    await registerIpcMainBridges(transport);
    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'games.list',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    await expect(registeredCallback({ sender: {} }, {})).resolves.toEqual({ ok: true });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('should normalize an Error with non-cloneable custom fields to a plain, cloneable Error and log it', async () => {
    const { transport, handlers } = makeTransport(['wizard.guidedIam.submitBootstrapKey']);
    // Mirrors an AWS SDK exception: extends Error but carries non-plain
    // fields ($metadata, symbol-keyed internals) that fail Electron's
    // structured-clone — the exact shape that produced the reported hang.
    const awsLikeError = Object.assign(new Error('The security token included in the request is invalid.'), {
      $metadata: { httpStatusCode: 403 },
      Code: 'InvalidClientTokenId',
    });
    vi.mocked(handlers.get('wizard.guidedIam.submitBootstrapKey')!).mockRejectedValue(awsLikeError);

    await registerIpcMainBridges(transport);
    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'wizard.guidedIam.submitBootstrapKey',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    let caught: unknown;
    try {
      await registeredCallback({ sender: {} }, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('The security token included in the request is invalid.');
    // The exact bug this normalization prevents: the raw AWS SDK error's
    // non-plain fields must not survive onto the value handed back to
    // Electron, which is what fails structured-clone.
    expect(Object.keys(caught as Error)).not.toContain('$metadata');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('wizard.guidedIam.submitBootstrapKey'),
      expect.objectContaining({ pattern: 'wizard.guidedIam.submitBootstrapKey' }),
    );
  });

  it('should normalize a non-Error, non-object rejection to a plain Error via String()', async () => {
    const { transport, handlers } = makeTransport(['games.list']);
    vi.mocked(handlers.get('games.list')!).mockRejectedValue('a bare string rejection');

    await registerIpcMainBridges(transport);
    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'games.list',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    await expect(registeredCallback({ sender: {} }, {})).rejects.toThrow('a bare string rejection');
  });

  it('should preserve the message from an error-like object rejection instead of stringifying it', async () => {
    const { transport, handlers } = makeTransport(['games.list']);
    vi.mocked(handlers.get('games.list')!).mockRejectedValue({ message: 'error-like object rejection' });

    await registerIpcMainBridges(transport);
    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'games.list',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    await expect(registeredCallback({ sender: {} }, {})).rejects.toThrow('error-like object rejection');
  });
});
