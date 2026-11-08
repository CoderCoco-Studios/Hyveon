import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ipcErrorMessage, registerSelfBridgedHandlers } from './ipc-handlers.js';

const { mockHandle, mockRemoveHandler, mockLoggerError } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockRemoveHandler: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler } }));
vi.mock('./logger.js', () => ({ logger: { error: mockLoggerError } }));

// @spec APP-IPC-ERR-004
describe('ipcErrorMessage', () => {
  it('should read the field error from an object-body BadRequestException instead of "Bad Request Exception"', () => {
    const err = new BadRequestException({ success: false, error: 'include must be an array of strings' });
    expect(err.message).toBe('Bad Request Exception');
    expect(ipcErrorMessage(err)).toBe('include must be an array of strings');
  });

  it('should read a string-body HttpException body', () => {
    expect(ipcErrorMessage(new BadRequestException('bad runId'))).toBe('bad runId');
  });

  it('should fall back to .message for an HttpException body with no error text', () => {
    expect(ipcErrorMessage(new BadRequestException({ success: false }))).toBe('Bad Request Exception');
  });

  it('should return the message of a plain Error, a message-bearing object and a bare string', () => {
    expect(ipcErrorMessage(new Error('boom'))).toBe('boom');
    expect(ipcErrorMessage({ message: 'obj boom' })).toBe('obj boom');
    expect(ipcErrorMessage('bare')).toBe('bare');
  });
});

// @spec APP-IPC-ERR-005, APP-IPC-CALL-009
describe('registerSelfBridgedHandlers', () => {
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) delete (process.versions as { electron?: string }).electron;
    else Object.defineProperty(process.versions, 'electron', { value, configurable: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setElectron('30.0.0');
  });
  afterEach(() => setElectron(realElectronVersion));

  const registered = (channel: string) =>
    mockHandle.mock.calls.find(([c]: [string]) => c === channel)![1] as (evt: unknown, payload: unknown) => Promise<unknown>;

  it('should register nothing outside Electron', async () => {
    setElectron(undefined);
    await registerSelfBridgedHandlers({ 'iac.plan': vi.fn() });
    expect(mockHandle).not.toHaveBeenCalled();
    expect(mockRemoveHandler).not.toHaveBeenCalled();
  });

  it('should removeHandler before handle for every channel and call the handler as (payload, { evt })', async () => {
    const handler = vi.fn().mockResolvedValue({ streamId: 's1' });
    await registerSelfBridgedHandlers({ 'iac.plan': handler, 'iac.apply': vi.fn() });

    expect(mockRemoveHandler).toHaveBeenCalledWith('iac.plan');
    expect(mockRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(mockHandle.mock.invocationCallOrder[0]);
    const evt = { sender: {} };
    await expect(registered('iac.plan')(evt, { a: 1 })).resolves.toEqual({ streamId: 's1' });
    expect(handler).toHaveBeenCalledWith({ a: 1 }, { evt });
  });

  it('should log and reject with a plain Error carrying only the message when the handler throws before its ack', async () => {
    const sdkLike = Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
    await registerSelfBridgedHandlers({ 'iac.runs.logs': vi.fn().mockRejectedValue(sdkLike) });

    const rejection = await registered('iac.runs.logs')({}, undefined).catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(sdkLike);
    expect(Object.keys(rejection as object)).toEqual([]);
    expect((rejection as Error).message).toBe('AccessDenied');
    expect(mockLoggerError).toHaveBeenCalledWith(
      'ipc-main-bridge: handler for "iac.runs.logs" failed: AccessDenied',
      expect.objectContaining({ pattern: 'iac.runs.logs' }),
    );
  });

  it('should surface a BadRequestException field error as the rejection message', async () => {
    const bad = new BadRequestException({ success: false, error: 'iac.runs.logs requires a non-empty runId string' });
    await registerSelfBridgedHandlers({ 'iac.runs.logs': vi.fn().mockRejectedValue(bad) });

    await expect(registered('iac.runs.logs')({}, undefined)).rejects.toThrow('iac.runs.logs requires a non-empty runId string');
  });
});
