import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalErrorReporting, reportRendererError } from './report-renderer-error.utils.js';

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
