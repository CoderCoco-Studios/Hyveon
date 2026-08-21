import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useLogTail, type LogTailApi } from './use-log-tail.hook.js';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

/** Build a {@link LogTailApi} test double with sensible defaults, overridable per test. */
function makeApi(overrides: Partial<LogTailApi> = {}): LogTailApi {
  return {
    get: vi.fn().mockResolvedValue({ lines: [] }),
    stream: vi.fn().mockImplementation(toStreamHandleMock(async function* () {})),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('hyveon', {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('useLogTail', () => {
  it('should seed lines from api.get and call api.stream on mount for a non-empty target', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: ['line one', 'line two'] }) });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.lines).toHaveLength(2));
    expect(result.current.lines.map((l) => l.text)).toEqual(['line one', 'line two']);
    expect(api.get).toHaveBeenCalledWith('watchdog');
    expect(api.stream).toHaveBeenCalledWith('watchdog');
  });

  it('should not call api.get/api.stream when target is an empty string', () => {
    const api = makeApi();
    renderHook(() => useLogTail('', api));
    expect(api.get).not.toHaveBeenCalled();
    expect(api.stream).not.toHaveBeenCalled();
  });

  it('should buffer incoming lines while paused and flush them into lines on resume', async () => {
    let push: ((line: string) => void) | undefined;
    const api = makeApi({
      stream: vi.fn().mockImplementation(
        toStreamHandleMock(async function* () {
          yield await new Promise<string>((resolve) => {
            push = resolve;
          });
        }),
      ),
    });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    act(() => result.current.handlePauseToggle());
    expect(result.current.paused).toBe(true);
    act(() => push?.('buffered line'));
    await waitFor(() => expect(result.current.bufferedCount).toBe(1));
    expect(result.current.lines).toHaveLength(0);
    act(() => result.current.handlePauseToggle());
    expect(result.current.paused).toBe(false);
    expect(result.current.lines.map((l) => l.text)).toEqual(['buffered line']);
    expect(result.current.bufferedCount).toBe(0);
  });

  it('should reset lines/paused/error and cancel the previous stream when target changes', async () => {
    const cancel1 = vi.fn();
    const handle1 = toStreamHandleMock(async function* () {})();
    handle1.cancel = cancel1;
    const api = makeApi({
      get: vi.fn().mockResolvedValue({ lines: ['first-target line'] }),
      stream: vi.fn().mockReturnValueOnce(handle1).mockImplementation(toStreamHandleMock(async function* () {})),
    });
    const { result, rerender } = renderHook(({ target }) => useLogTail(target, api), {
      initialProps: { target: 'watchdog' },
    });
    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    act(() => result.current.handlePauseToggle());
    rerender({ target: 'health-check' });
    await waitFor(() => expect(cancel1).toHaveBeenCalled());
    expect(result.current.paused).toBe(false);
    expect(api.get).toHaveBeenCalledWith('health-check');
  });

  it('should set error and still start the stream when api.get rejects', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.error).toBe('Could not load initial logs; trying live stream.'));
    expect(api.stream).toHaveBeenCalledWith('watchdog');
  });

  it('should set an error message when the stream throws', async () => {
    const api = makeApi({
      stream: vi.fn().mockImplementation(
        toStreamHandleMock(
          // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a stream failure
          async function* () {
            throw new Error('boom');
          },
        ),
      ),
    });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.error).toBe('Stream ended with error: boom'));
  });
});
