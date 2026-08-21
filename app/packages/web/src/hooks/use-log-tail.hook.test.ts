import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type { LogEventLine } from '@hyveon/desktop-preload';
import { useLogTail, type LogTailApi } from './use-log-tail.hook.js';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

/** Build a {@link LogEventLine} test fixture with a given message and timestamp. */
function line(message: string, timestamp: number): LogEventLine {
  return { message, timestamp, eventId: `${timestamp}:${message}` };
}

/** Build a {@link LogTailApi} test double with sensible defaults, overridable per test. */
function makeApi(overrides: Partial<LogTailApi> = {}): LogTailApi {
  return {
    get: vi.fn().mockResolvedValue({ lines: [] }),
    stream: vi.fn().mockImplementation(toStreamHandleMock(async function* () {})),
    getOlder: vi.fn().mockResolvedValue({ lines: [], atOldest: true }),
    getNewer: vi.fn().mockResolvedValue({ lines: [], hasMore: false }),
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

/** Resolves a promise on the next microtask/macrotask tick — used to interleave a slow async call with a subsequent state change in generation-guard tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: [line('line one', 1000), line('line two', 2000)] }) });
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
    let push: ((chunk: string) => void) | undefined;
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
      get: vi.fn().mockResolvedValue({ lines: [line('first-target line', 1000)] }),
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
      const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: [line('a', 1000), line('b', 2000)] }) });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));

      setScrollPosition(result.current.boxRef, { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      expect(result.current.mode).toBe('live');
      expect(api.getOlder).not.toHaveBeenCalled();
    });

    it('should enter historical mode and prepend older lines when scrolling near the top', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [line('newer1', 1000), line('newer2', 1100)] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older1', 500), line('older2', 600)], atOldest: false }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      // mode flips to 'historical' synchronously, before the getOlder
      // promise resolves and setLines runs — wait for both under the same
      // waitFor rather than asserting lines immediately after the mode
      // check settles, which raced the still-pending setLines update.
      await waitFor(() => {
        expect(result.current.mode).toBe('historical');
        expect(result.current.lines.map((l) => l.text)).toEqual(['older1', 'older2', 'newer1', 'newer2']);
      });
      expect(result.current.hasNewer).toBe(true);
      // The window's actual oldest-visible line (newer1, timestamp 1000) seeds the boundary.
      expect(api.getOlder).toHaveBeenCalledWith('watchdog', 1000, 300);
    });

    it("should seed the first getOlder boundary from the initial snapshot's oldest line timestamp instead of Date.now()", async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [line('newer1', 12345)] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older1', 100)], atOldest: false }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(api.getOlder).toHaveBeenCalled());
      // Seeded from the snapshot's real line timestamp, not a Date.now() fallback that would
      // re-fetch (and duplicate) lines already present in the initial snapshot.
      expect(api.getOlder).toHaveBeenCalledWith('watchdog', 12345, 300);
    });

    it('should evict lines from the bottom of the window once prepending older lines exceeds the cap', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: Array.from({ length: 250 }, (_, i) => line(`live-${i}`, 10_000 + i)) }),
        getOlder: vi.fn().mockResolvedValue({
          lines: Array.from({ length: 100 }, (_, i) => line(`old-${i}`, 100 + i)),
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
        get: vi.fn().mockResolvedValue({ lines: [line('a', 1000)] }),
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
      let push: ((chunk: string) => void) | undefined;
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [line('a', 1000)] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older', 100)], atOldest: false }),
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

    it('should page forward via getNewer, appending results, when scrolling back to the bottom while in historical mode', async () => {
      const aLine = line('a', 1000);
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [aLine] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older', 100)], atOldest: false }),
        getNewer: vi.fn().mockResolvedValue({ lines: [line('gap-filled', 2000)], hasMore: false }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.mode).toBe('historical'));

      setScrollPosition(result.current.boxRef, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain('gap-filled'));
      // The forward boundary/exclusion is derived from the window's actual
      // current newest-visible line — here, the original snapshot's 'a'
      // line, which already carries a real CloudWatch timestamp/eventId —
      // rather than a value pinned once at historical-mode entry.
      expect(api.getNewer).toHaveBeenCalledWith('watchdog', aLine.timestamp, 300, [aLine.eventId]);
      // Forward paging alone does not switch the mode back to 'live' — only jumpToLatest does.
      expect(result.current.mode).toBe('historical');
    });

    it("should page forward again from the window's current boundary line on a subsequent scroll-to-bottom", async () => {
      const aLine = line('a', 1000);
      const page1Line = line('page1', 2000);
      const page2Line = line('page2', 3000);
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [aLine] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older', 100)], atOldest: false }),
        getNewer: vi
          .fn()
          .mockResolvedValueOnce({ lines: [page1Line], hasMore: true })
          .mockResolvedValueOnce({ lines: [page2Line], hasMore: false }),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.mode).toBe('historical'));

      setScrollPosition(result.current.boxRef, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain('page1'));

      setScrollPosition(result.current.boxRef, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain('page2'));

      // Second call's boundary/exclusion is derived fresh from page1's line
      // (now the window's newest-visible line) — not carried forward as a
      // scalar from the first call's result.
      expect(api.getNewer).toHaveBeenNthCalledWith(2, 'watchdog', page1Line.timestamp, 300, [page1Line.eventId]);
    });

    it('should re-fetch a fresh snapshot via api.get and discard the buffer on jumpToLatest', async () => {
      let push: ((chunk: string) => void) | undefined;
      const api = makeApi({
        get: vi
          .fn()
          .mockResolvedValueOnce({ lines: [line('a', 1000)] })
          .mockResolvedValueOnce({ lines: [line('fresh1', 9000), line('fresh2', 9100)] }),
        getOlder: vi.fn().mockResolvedValue({ lines: [line('older', 100)], atOldest: false }),
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

      act(() => push?.('buffered while historical'));
      await waitFor(() => expect(result.current.bufferedCount).toBe(1));

      act(() => result.current.jumpToLatest());

      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(['fresh1', 'fresh2']));
      expect(result.current.mode).toBe('live');
      expect(result.current.hasNewer).toBe(false);
      expect(result.current.bufferedCount).toBe(0);
      // The buffered live line is discarded, not spliced into the fresh snapshot.
      expect(result.current.lines.map((l) => l.text)).not.toContain('buffered while historical');
      expect(result.current.autoscroll).toBe(true);
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('should reset mode/atOldest back to live/false when the target changes', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: [line('a', 1000)] }),
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

    it('should discard a stale getOlder result that resolves after the target has already changed', async () => {
      const older = deferred<{ lines: LogEventLine[]; atOldest: boolean }>();
      const api = makeApi({
        get: vi
          .fn()
          .mockResolvedValueOnce({ lines: [line('a', 1000)] })
          .mockResolvedValueOnce({ lines: [line('b', 2000)] }),
        getOlder: vi.fn().mockReturnValue(older.promise),
      });
      const { result, rerender } = renderHook(({ target }) => useLogTail(target, api), {
        initialProps: { target: 'watchdog' },
      });
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.loadingOlder).toBe(true));

      rerender({ target: 'health-check' });
      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(['b']));

      act(() => older.resolve({ lines: [line('stale-older', 1)], atOldest: false }));
      await Promise.resolve();
      await Promise.resolve();

      // The stale page must not land in `lines` (which now belongs to the new target) nor
      // resurrect `loadingOlder`/`mode` for a fetch the current target never requested.
      expect(result.current.lines.map((l) => l.text)).toEqual(['b']);
      expect(result.current.loadingOlder).toBe(false);
      expect(result.current.mode).toBe('live');
    });

    it('should discard a stale getOlder result that resolves after jumpToLatest already ran', async () => {
      const older = deferred<{ lines: LogEventLine[]; atOldest: boolean }>();
      const api = makeApi({
        get: vi
          .fn()
          .mockResolvedValueOnce({ lines: [line('a', 1000)] })
          .mockResolvedValueOnce({ lines: [line('fresh', 2000)] }),
        getOlder: vi.fn().mockReturnValue(older.promise),
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());
      await waitFor(() => expect(result.current.loadingOlder).toBe(true));

      act(() => result.current.jumpToLatest());
      await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(['fresh']));

      act(() => older.resolve({ lines: [line('stale-older', 1)], atOldest: false }));
      await Promise.resolve();
      await Promise.resolve();

      expect(result.current.lines.map((l) => l.text)).toEqual(['fresh']);
      expect(result.current.mode).toBe('live');
    });

    it('should derive the next getNewer boundary from the backfilled window after eviction pushes the original live-tailed lines out, instead of jumping back to a stale live-entry timestamp (Bug 2 regression)', async () => {
      // Reproduces the exact reported gap: the initial snapshot has a couple
      // of live-tailed lines with real (but "close to now") timestamps.
      // Enough older backfill is then prepended in one loadOlder call that
      // the total exceeds WINDOW_SIZE (300), evicting every original
      // snapshot line off the bottom — so the window's newest-visible line
      // is now one of the *backfilled* lines, not anything from the
      // original entry-time snapshot.
      const initialLines = [line('live-a', 999_000), line('live-b', 999_100)];
      // 300 older lines, timestamps far below the initial snapshot's — once
      // prepended ahead of the 2 initial lines (302 total) and trimmed to
      // WINDOW_SIZE (300) from the front, both initial lines are evicted.
      const olderLines = Array.from({ length: 300 }, (_, i) => line(`old-${i}`, 1000 + i));
      const getNewerMock = vi.fn().mockResolvedValue({ lines: [line('resumed-here', 1299)], hasMore: false });
      const api = makeApi({
        get: vi.fn().mockResolvedValue({ lines: initialLines }),
        getOlder: vi.fn().mockResolvedValue({ lines: olderLines, atOldest: false }),
        getNewer: getNewerMock,
      });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));

      setScrollPosition(result.current.boxRef, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(result.current.lines).toHaveLength(300));
      // Confirm the eviction actually happened: neither original live-tailed
      // line survives in the window.
      expect(result.current.lines.map((l) => l.text)).not.toContain('live-a');
      expect(result.current.lines.map((l) => l.text)).not.toContain('live-b');
      const newestVisible = result.current.lines[result.current.lines.length - 1]!;
      expect(newestVisible.text).toBe(`old-${olderLines.length - 1}`);

      // Scroll back toward the bottom of *this* historical window (not
      // toward "now") — handleScroll's loadNewer must resume from the
      // window's actual newest-visible backfilled line's timestamp, not the
      // wall-clock-ish timestamp of the long-evicted original snapshot.
      setScrollPosition(result.current.boxRef, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
      act(() => result.current.handleScroll());

      await waitFor(() => expect(getNewerMock).toHaveBeenCalled());
      const [, afterTimestamp] = getNewerMock.mock.calls[0] as [string, number, number, string[]];
      expect(afterTimestamp).toBe(newestVisible.timestamp);
      expect(afterTimestamp).not.toBeGreaterThan(1300);
      expect(afterTimestamp).toBeLessThan(999_000);
    });
  });
});
