import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useRunHistory, type StatusFilter } from './use-run-history.hook.js';

/** Builds a sample run-history record, overridable per-test. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-1',
    runId: 'run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** Resolves a promise on a later tick — used to interleave a slow `list()` call with a subsequent hook update in staleness-guard tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const listMock = vi.fn();

beforeEach(() => {
  listMock.mockReset();
  vi.stubGlobal('hyveon', { iac: { runs: { list: listMock } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('useRunHistory', () => {
  it('should fetch the first page on mount and settle loading once it resolves', async () => {
    listMock.mockResolvedValue({ records: [makeRecord()] });

    const { result } = renderHook(() => useRunHistory('all'));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toHaveLength(1);
    expect(listMock).toHaveBeenCalledWith({ limit: 25, status: undefined });
  });

  it('should fetch the next, older page and append it when loadMore is called', async () => {
    listMock.mockResolvedValueOnce({ records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })], nextBefore: 'sk-1' });
    const { result } = renderHook(() => useRunHistory('all'));
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    listMock.mockResolvedValueOnce({ records: [makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })] });
    result.current.loadMore();

    await waitFor(() => expect(result.current.records).toHaveLength(2));
    expect(listMock).toHaveBeenLastCalledWith({ limit: 25, before: 'sk-1', status: undefined });
  });

  it('should re-fetch with the selected status filter', async () => {
    listMock.mockResolvedValue({ records: [makeRecord({ status: 'failed' })] });
    const { result, rerender } = renderHook(({ status }: { status: StatusFilter }) => useRunHistory(status), {
      initialProps: { status: 'all' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ status: 'failed' as const });

    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ limit: 25, status: 'failed' }));
  });

  it('should discard a loadMore response that resolves after a newer request has been issued', async () => {
    listMock.mockResolvedValueOnce({ records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })], nextBefore: 'sk-1' });
    const { result, rerender } = renderHook(({ status }: { status: StatusFilter }) => useRunHistory(status), {
      initialProps: { status: 'all' },
    });
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    const stale = deferred<{ records: unknown[]; nextBefore?: string }>();
    listMock.mockReturnValueOnce(stale.promise);
    result.current.loadMore();

    // A filter change bumps the request generation counter mid-flight —
    // this newer request must win even though the stale one resolves after it.
    listMock.mockResolvedValueOnce({ records: [makeRecord({ runId: 'run-2', sk: 'sk-2', status: 'failed' })] });
    rerender({ status: 'failed' as const });
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(result.current.records[0]).toMatchObject({ runId: 'run-2' });

    stale.resolve({ records: [makeRecord({ runId: 'stale', sk: 'sk-stale' })] });
    await Promise.resolve();
    expect(result.current.records).not.toContainEqual(expect.objectContaining({ runId: 'stale' }));
  });

  it('should clear loadingMore once loadMore settles even after a filter change superseded the request', async () => {
    listMock.mockResolvedValueOnce({ records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })], nextBefore: 'sk-1' });
    const { result, rerender } = renderHook(({ status }: { status: StatusFilter }) => useRunHistory(status), {
      initialProps: { status: 'all' },
    });
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    const pendingLoadMore = deferred<{ records: unknown[] }>();
    listMock.mockReturnValueOnce(pendingLoadMore.promise);
    result.current.loadMore();
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    listMock.mockResolvedValueOnce({ records: [makeRecord({ status: 'failed' })] });
    rerender({ status: 'failed' as const });
    pendingLoadMore.resolve({ records: [] });

    await waitFor(() => expect(result.current.loadingMore).toBe(false));
  });
});
