import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalErrorReporting, reportRendererError } from './report-renderer-error.utils.js';

const MODULE_PATH = './report-renderer-error.utils.js';

/** Install a `window.hyveon` stub whose `diagnostics.reportError` is a spy. */
function stubBridge(reportError: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('hyveon', { diagnostics: { reportError } });
}

describe('reportRendererError', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should call window.hyveon.diagnostics.reportError with the given arguments', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);

    reportRendererError('boom', 'Error: boom\n  at x', 'boundary');

    expect(reportError).toHaveBeenCalledWith('boom', 'Error: boom\n  at x', 'boundary');
  });

  it('should not throw when window.hyveon is undefined', () => {
    vi.stubGlobal('hyveon', undefined);

    expect(() => reportRendererError('boom', undefined, 'window-error')).not.toThrow();
  });

  it('should not throw when window.hyveon.diagnostics is undefined', () => {
    vi.stubGlobal('hyveon', {});

    expect(() => reportRendererError('boom', undefined, 'window-error')).not.toThrow();
  });

  it('should swallow a rejection from window.hyveon.diagnostics.reportError', async () => {
    const reportError = vi.fn().mockRejectedValue(new Error('ipc unavailable'));
    stubBridge(reportError);

    expect(() => reportRendererError('boom', undefined, 'unhandled-rejection')).not.toThrow();
    // Let the rejected promise's .catch(() => undefined) settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('installGlobalErrorReporting', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should forward a window error event to reportRendererError', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const error = new Error('render crashed');
    window.dispatchEvent(new ErrorEvent('error', { message: 'render crashed', error }));

    expect(reportError).toHaveBeenCalledWith('render crashed', error.stack, 'window-error');
  });

  it('should forward an unhandledrejection event with an Error reason', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const reason = new Error('promise blew up');
    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason: unknown };
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);

    expect(reportError).toHaveBeenCalledWith('promise blew up', reason.stack, 'unhandled-rejection');
  });

  it('should coerce a non-Error unhandledrejection reason to a string message with no stack', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason: unknown };
    Object.defineProperty(event, 'reason', { value: 'plain string rejection' });
    window.dispatchEvent(event);

    expect(reportError).toHaveBeenCalledWith('plain string rejection', undefined, 'unhandled-rejection');
  });
});

describe('installConsoleForwarding', () => {
  const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const;
  const originalConsole: Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    CONSOLE_LEVELS.forEach((level) => {
      console[level] = originalConsole[level];
    });
  });

  it('should leave console methods untouched when no bridge is present', async () => {
    vi.stubGlobal('hyveon', undefined);
    const { installConsoleForwarding } = await import(MODULE_PATH);
    const before = console.log;

    installConsoleForwarding();

    expect(console.log).toBe(before);
  });

  it('should still invoke the original console method after installing', async () => {
    vi.stubGlobal('hyveon', { diagnostics: { reportLog: vi.fn().mockResolvedValue(undefined) } });
    const spy = vi.fn();
    console.log = spy;
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('hello world');

    expect(spy).toHaveBeenCalledWith('hello world');
  });

  it('should forward a console.log call to diagnostics.reportLog on the next flush', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('hello world');
    expect(reportLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'log', message: 'hello world' }], undefined);
  });

  it('should join multiple console arguments and stringify non-string values', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.warn('count is', 42, { ok: true });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'warn', message: 'count is 42 {"ok":true}' }], undefined);
  });

  it('should cap entries sent in one flush and report the overflow as dropped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    for (let i = 0; i < 60; i += 1) {
      console.log(`entry ${i}`);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(1);
    const [entries, droppedCount] = reportLog.mock.calls[0] as [unknown[], number | undefined];
    expect(entries).toHaveLength(50);
    expect(droppedCount).toBe(10);
  });

  it('should not call reportLog on a flush with nothing queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).not.toHaveBeenCalled();
  });

  it('should not throw when diagnostics.reportLog rejects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockRejectedValue(new Error('ipc unavailable'));
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.error('boom');

    await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.not.toThrow();
  });
});
