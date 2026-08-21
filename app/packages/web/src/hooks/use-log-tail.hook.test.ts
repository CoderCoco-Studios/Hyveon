import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useLogTail, type LogTailApi } from './use-log-tail.hook.js';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

/** Build a {@link LogTailApi} test double with sensible defaults, overridable per test. */
function makeApi(overrides: Partial<LogTailApi> = {}): LogTailApi {
  return {
    get: vi.fn().mockResolvedValue({ lines: [] }),
    stream: vi.fn().mockImplementation(toStreamHandleMock(async function* () {})),
    getOlder: vi.fn().mockResolvedValue({ lines: [], atOldest: true }),
    getRange: vi.fn().mockResolvedValue({ lines: [] }),
    ...overrides,
  };
}

/** Assigns a minimal `scrollTop`/`scrollHeight`/`clientHeight` stub to `boxRef.current` ahead of firing `handleScroll`. */
function setScrollPosition(
  boxRef: React.RefObject<HTMLDivElement | null>,
  { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  boxRef.current = { scrollTop, scrollHeight, clientHeight } as HTMLDivElement;
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

  it('should exclude lines whose level is hidden from visibleLines without removing them from lines', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: ['INFO up', 'ERROR down'] }) });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.lines).toHaveLength(2));
    act(() => result.current.toggleLevel('ERROR'));
    expect(result.current.visibleLines.map((l) => l.text)).toEqual(['INFO up']);
    expect(result.current.lines).toHaveLength(2);
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

  describe('windowed viewport — historical backfill', () => {
    it('should stay in live mode and never call getOlder when scrolling stays away from the top', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: ['a', 'b'] }) });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));

      setScrollPosition(result.current.boxRef, { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      expect(result.current.mode).toBe('live');
      expect(api.getOlder).not.toHaveBeenCalled();
    });

    it('should enter historical mode and prepend older lines when scrolling near the top', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['newer1', 'newer2'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: ['older1', 'older2'], oldestTimestamp: 500, atOldest: false }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(result.current.mode).toBe('historical'));
      expect(result.current.lines.map((l) => l.text)).toEqual(['older1', 'older2', 'newer1', 'newer2']);
      expect(result.current.hasNewer).toBe(true);
      expect(api.getOlder).toHaveBeenCalledWith('watchdog', expect.any(Number), 300);
    });

    it('should evict lines from the bottom of the window once prepending older lines exceeds the cap', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: Array.from({ length: 250 }, (_, i) => `live-${i}`) }),
        getOlder: vi.fn().mockResolvedValue({
          lines: Array.from({ length: 100 }, (_, i) => `old-${i}`),
          oldestTimestamp: 100,
          atOldest: false,
        }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(250));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(result.current.lines).toHaveLength(300));
      expect(result.current.lines[0]!.text).toBe('old-0');
      // The newest 50 of the original 250 live lines were evicted off the bottom to stay within the 300 cap.
      expect(result.current.lines[result.current.lines.length - 1]!.text).toBe('live-199');
    });

    it('should set atOldest and stop issuing further getOlder calls once a backward fetch reports atOldest', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['a'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [], atOldest: true }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.atOldest).toBe(true));

      act(() => result.current.handleScroll());
      expect(api.getOlder).toHaveBeenCalledTimes(1);
    });

    it('should buffer incoming live lines instead of appending them to lines while in historical mode', async () => {
      let push: ((line: string) => void) | undefined;
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['a'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: ['older'], oldestTimestamp: 100, atOldest: false }),
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

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.mode).toBe('historical'));

      act(() => push?.('live line while historical'));
      await waitFor(() => expect(result.current.bufferedCount).toBe(1));
      expect(result.current.lines.map((l) => l.text)).not.toContain('live line while historical');
    });

    it('should fetch a forward gap-fill when scrolling back to the bottom while in historical mode', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['a'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: ['older'], oldestTimestamp: 100, atOldest: false }),
        getRange: vi.fn().mockResolvedValue({ lines: ['gap-filled'] }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.mode).toBe('historical'));

      setScrollPosition(result.current.boxRef, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain('gap-filled'));
      expect(api.getRange).toHaveBeenCalledWith('watchdog', expect.any(Number), expect.any(Number));
      // Forward gap-fill alone does not switch the mode back to 'live' — only jumpToLatest does.
      expect(result.current.mode).toBe('historical');
    });

    it('should discard the historical window and flush the buffer into lines on jumpToLatest', async () => {
      let push: ((line: string) => void) | undefined;
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['a'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: ['older'], oldestTimestamp: 100, atOldest: false }),
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

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.mode).toBe('historical'));

      act(() => push?.('flushed line'));
      await waitFor(() => expect(result.current.bufferedCount).toBe(1));

      act(() => result.current.jumpToLatest());

      expect(result.current.mode).toBe('live');
      expect(result.current.hasNewer).toBe(false);
      expect(result.current.bufferedCount).toBe(0);
      expect(result.current.lines.map((l) => l.text)).toEqual(['flushed line']);
      expect(result.current.autoscroll).toBe(true);
    });

    it('should reset mode/atOldest back to live/false when the target changes', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: ['a'] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [], atOldest: true }),
      });
      const { result, rerender } = renderHook(({ target }) => useLogTail(target, api), {
        initialProps: { target: 'watchdog' },
      });
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.atOldest).toBe(true));

      rerender({ target: 'health-check' });

      await waitFor(() => expect(result.current.mode).toBe('live'));
      expect(result.current.atOldest).toBe(false);
    });
  });
});
