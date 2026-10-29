import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { VolumeEntryInfo, VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { useVolumeFiles } from './use-volume-files.hook.js';
import { makeDirEntry, makeFileEntry, makeTransfer } from './volume-files.test-utils.js';

const apiMock = vi.hoisted(() => ({
  volumeList: vi.fn(),
  volumeMkdir: vi.fn(),
  volumeRename: vi.fn(),
  volumeRemove: vi.fn(),
  volumeReadText: vi.fn(),
  volumeWriteText: vi.fn(),
  volumeDownload: vi.fn(),
  volumeUploadFiles: vi.fn(),
  volumeUploadDropped: vi.fn(),
  volumeUploadFolder: vi.fn(),
  volumeOnTransfer: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

let pushTransfer: (progress: VolumeTransferProgress) => void;

/** Resolves `volumeList` with `entries` for any path. */
function listing(entries: VolumeEntryInfo[]) {
  apiMock.volumeList.mockImplementation(async (_game: string, _volume: string, path: string) => ({
    ok: true,
    value: { path, entries },
  }));
}

/** Renders the hook for `minecraft`/`data` and waits for the first listing. */
async function renderLoaded(entries: VolumeEntryInfo[] = [makeFileEntry('a.txt')]) {
  listing(entries);
  const hook = renderHook(() => useVolumeFiles('minecraft', 'data', true));
  await waitFor(() => expect(hook.result.current.listing).not.toBeNull());
  return hook;
}

beforeEach(() => {
  listing([]);
  apiMock.volumeOnTransfer.mockImplementation((cb: (progress: VolumeTransferProgress) => void) => {
    pushTransfer = cb;
    return () => undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useVolumeFiles', () => {
  it('should list the root when enabled and sort folders first', async () => {
    const { result } = await renderLoaded([makeFileEntry('b.txt'), makeDirEntry('A'), makeFileEntry('a.txt')]);

    expect(apiMock.volumeList).toHaveBeenCalledWith('minecraft', 'data', '/');
    expect(result.current.path).toBe('/');
    expect(result.current.listing?.map((e) => e.name)).toEqual(['A', 'a.txt', 'b.txt']);
  });

  it('should not list while disabled or without a volume', async () => {
    renderHook(() => useVolumeFiles('minecraft', 'data', false));
    const { result } = renderHook(() => useVolumeFiles('minecraft', null, true));
    await act(async () => undefined);

    expect(apiMock.volumeList).not.toHaveBeenCalled();
    expect(result.current.listing).toBeNull();
  });

  it('should keep folders first when sorting by size descending', async () => {
    const { result } = await renderLoaded([makeFileEntry('small', 1), makeDirEntry('d'), makeFileEntry('big', 99)]);

    act(() => result.current.setSort({ key: 'size', dir: 'desc' }));

    expect(result.current.sort).toEqual({ key: 'size', dir: 'desc' });
    expect(result.current.listing?.map((e) => e.name)).toEqual(['d', 'big', 'small']);
  });

  it('should list the opened directory and reset to the root when the volume changes', async () => {
    listing([makeDirEntry('world')]);
    const { result, rerender } = renderHook(({ volume }) => useVolumeFiles('minecraft', volume, true), {
      initialProps: { volume: 'data' },
    });
    await waitFor(() => expect(result.current.listing).not.toBeNull());

    act(() => result.current.open('/world'));
    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledWith('minecraft', 'data', '/world'));
    expect(result.current.path).toBe('/world');

    rerender({ volume: 'mods' });
    expect(result.current.path).toBe('/');
    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledWith('minecraft', 'mods', '/'));
  });

  it('should surface a conflict message and keep the listing', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeRename.mockResolvedValue({ ok: false, code: 'conflict', message: 'x exists' });
    apiMock.volumeList.mockClear();

    await act(() => result.current.rename('/a.txt', 'x'));

    expect(apiMock.volumeRename).toHaveBeenCalledWith('minecraft', 'data', '/a.txt', 'x');
    expect(result.current.error).toBe('x exists');
    expect(result.current.listing?.map((e) => e.name)).toEqual(['a.txt']);
    expect(apiMock.volumeList).not.toHaveBeenCalled();
  });

  it('should refresh the listing after a successful mutation and clear the previous error', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeRename.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'x exists' });
    await act(() => result.current.rename('/a.txt', 'x'));
    expect(result.current.error).toBe('x exists');

    apiMock.volumeRemove.mockResolvedValue({ ok: true, value: true });
    listing([]);
    apiMock.volumeList.mockClear();
    await act(() => result.current.remove('/a.txt'));

    expect(apiMock.volumeRemove).toHaveBeenCalledWith('minecraft', 'data', '/a.txt');
    expect(apiMock.volumeList).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.listing).toEqual([]);
  });

  it('should create a folder under the current path', async () => {
    const { result } = await renderLoaded([makeDirEntry('world')]);
    act(() => result.current.open('/world'));
    await waitFor(() => expect(result.current.path).toBe('/world'));
    apiMock.volumeMkdir.mockResolvedValue({ ok: true, value: makeDirEntry('sub') });

    await act(() => result.current.mkdir('sub'));

    expect(apiMock.volumeMkdir).toHaveBeenCalledWith('minecraft', 'data', '/world', 'sub');
  });

  it('should download an entry by its joined path', async () => {
    const { result } = await renderLoaded([makeDirEntry('world')]);
    act(() => result.current.open('/world'));
    await waitFor(() => expect(result.current.path).toBe('/world'));
    apiMock.volumeDownload.mockResolvedValue({ ok: true, value: { transferId: 't' } });

    await act(() => result.current.download(makeDirEntry('region')));

    expect(apiMock.volumeDownload).toHaveBeenCalledWith('minecraft', 'data', '/world/region', true);
  });

  it('should return read and write results without setting the page error', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeReadText.mockResolvedValue({ ok: true, value: { path: '/a.txt', content: 'hi', modifiedMs: 7 } });
    apiMock.volumeWriteText.mockResolvedValue({ ok: false, code: 'conflict', message: 'changed on disk' });

    const read = await act(() => result.current.readText('/a.txt'));
    const write = await act(() => result.current.writeText('/a.txt', 'yo', 7));

    expect(read).toEqual({ ok: true, value: { path: '/a.txt', content: 'hi', modifiedMs: 7 } });
    expect(write.ok).toBe(false);
    expect(apiMock.volumeWriteText).toHaveBeenCalledWith('minecraft', 'data', '/a.txt', 'yo', 7);
    expect(result.current.error).toBeNull();
  });

  it('should report the code of every failed operation to onFailure, editor reads and writes included', async () => {
    listing([makeFileEntry('a.txt')]);
    const onFailure = vi.fn();
    const { result } = renderHook(() => useVolumeFiles('minecraft', 'data', true, onFailure));
    await waitFor(() => expect(result.current.listing).not.toBeNull());
    apiMock.volumeWriteText.mockResolvedValue({ ok: false, code: 'server-running', message: 'running' });
    apiMock.volumeRemove.mockResolvedValue({ ok: false, code: 'server-check-failed', message: 'unsure' });

    await act(() => result.current.writeText('/a.txt', 'yo', 7));
    await act(() => result.current.remove('/a.txt'));

    expect(onFailure.mock.calls).toEqual([['server-running'], ['server-check-failed']]);
  });

  it('should upload a folder into an explicit directory when one is given', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeUploadFolder.mockResolvedValue({ ok: true, value: { started: true, runId: 'r' } });

    await act(() => result.current.uploadFolder('/world'));

    expect(apiMock.volumeUploadFolder).toHaveBeenCalledWith('minecraft', 'data', '/world');
  });

  it('should upload into the current path through the dialog and the dropped-files route', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeUploadFiles.mockResolvedValue({ ok: true, value: null });
    apiMock.volumeUploadDropped.mockResolvedValue({ ok: true, value: { transferId: 't' } });
    const files = [new File(['x'], 'x.txt')];

    await act(() => result.current.uploadFiles());
    await act(() => result.current.uploadDropped(files));

    expect(apiMock.volumeUploadFiles).toHaveBeenCalledWith('minecraft', 'data', '/');
    expect(apiMock.volumeUploadDropped).toHaveBeenCalledWith('minecraft', 'data', '/', files);
    expect(result.current.error).toBeNull();
  });

  it('should surface a folder upload that did not start as an error', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeUploadFolder.mockResolvedValue({ ok: true, value: { started: false, error: 'Pick a folder first.' } });

    await act(() => result.current.uploadFolder());

    expect(apiMock.volumeUploadFolder).toHaveBeenCalledWith('minecraft', 'data', '/');
    expect(result.current.error).toBe('Pick a folder first.');
  });

  it('should not set an error when a folder upload starts', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeUploadFolder.mockResolvedValue({ ok: true, value: { started: true, runId: 'r' } });

    await act(() => result.current.uploadFolder());

    expect(result.current.error).toBeNull();
  });

  it('should surface a rejected IPC call as an error', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeRemove.mockRejectedValue(new Error('bridge down'));

    await act(() => result.current.remove('/a.txt'));

    expect(result.current.error).toBe('bridge down');
  });

  it('should surface a failed listing as an error', async () => {
    apiMock.volumeList.mockResolvedValue({ ok: false, code: 'unreachable', message: 'helper unreachable' });
    const { result } = renderHook(() => useVolumeFiles('minecraft', 'data', true));

    await waitFor(() => expect(result.current.error).toBe('helper unreachable'));
    expect(result.current.listing).toBeNull();
  });

  it('should clear a failed listing error once a later listing succeeds', async () => {
    apiMock.volumeList.mockResolvedValue({ ok: false, code: 'failed', message: 'listing broke' });
    const { result } = renderHook(() => useVolumeFiles('minecraft', 'data', true));
    await waitFor(() => expect(result.current.error).toBe('listing broke'));

    listing([makeFileEntry('a.txt')]);
    await act(() => result.current.refresh());

    expect(result.current.error).toBeNull();
    expect(result.current.listing?.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('should keep an operation error when a listing that began before it succeeds afterwards', async () => {
    const { result } = await renderLoaded();
    let resolveList: (value: { ok: true; value: { path: string; entries: VolumeEntryInfo[] } }) => void = () => undefined;
    apiMock.volumeList.mockReturnValue(new Promise((resolve) => (resolveList = resolve)));
    apiMock.volumeUploadFiles.mockResolvedValue({ ok: false, code: 'failed', message: 'upload broke' });

    let pendingRefresh: Promise<void> = Promise.resolve();
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    await act(() => result.current.uploadFiles());
    expect(result.current.error).toBe('upload broke');

    await act(async () => {
      resolveList({ ok: true, value: { path: '/', entries: [makeFileEntry('b.txt')] } });
      await pendingRefresh;
    });

    expect(result.current.error).toBe('upload broke');
    expect(result.current.listing?.map((e) => e.name)).toEqual(['b.txt']);
  });

  it.each(['unreachable', 'no-session'] as const)('should report a listing that fails %s to onFailure', async (code) => {
    apiMock.volumeList.mockResolvedValue({ ok: false, code, message: 'gone' });
    const onFailure = vi.fn();

    renderHook(() => useVolumeFiles('minecraft', 'data', true, onFailure));

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(code));
  });

  it('should not report a listing failure with a mutation-only code to onFailure', async () => {
    apiMock.volumeList.mockResolvedValue({ ok: false, code: 'server-running', message: 'The server is running.' });
    const onFailure = vi.fn();
    const { result } = renderHook(() => useVolumeFiles('minecraft', 'data', true, onFailure));

    await waitFor(() => expect(result.current.error).toBe('The server is running.'));

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('should track transfers for this game and refresh the listing when an upload finishes', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeList.mockClear();

    act(() => pushTransfer(makeTransfer({ transferId: 'u1', phase: 'done' })));

    expect(result.current.transfers.map((t) => t.transferId)).toEqual(['u1']);
    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledOnce());
  });

  it('should refresh the current directory when a mutation started in another directory resolves', async () => {
    const { result } = await renderLoaded([makeDirEntry('B'), makeFileEntry('x')]);
    let resolveRemove: (value: { ok: true; value: true }) => void = () => undefined;
    apiMock.volumeRemove.mockReturnValue(new Promise((resolve) => (resolveRemove = resolve)));
    apiMock.volumeList.mockImplementation(async (_game: string, _volume: string, path: string) => ({
      ok: true,
      value: { path, entries: path === '/B' ? [makeFileEntry('in-b.txt')] : [makeDirEntry('B')] },
    }));

    let removal: Promise<unknown> = Promise.resolve();
    act(() => {
      removal = result.current.remove('/x');
    });
    act(() => result.current.open('/B'));
    await waitFor(() => expect(result.current.listing?.map((e) => e.name)).toEqual(['in-b.txt']));
    await act(async () => {
      resolveRemove({ ok: true, value: true });
      await removal;
    });

    expect(result.current.path).toBe('/B');
    expect(result.current.listing?.map((e) => e.name)).toEqual(['in-b.txt']);
    expect(apiMock.volumeList).toHaveBeenLastCalledWith('minecraft', 'data', '/B');
  });

  it('should discard a listing that resolves after the path has changed', async () => {
    let resolveRoot: (value: unknown) => void = () => undefined;
    apiMock.volumeList.mockImplementation((_game: string, _volume: string, path: string) =>
      path === '/'
        ? new Promise((resolve) => (resolveRoot = resolve))
        : Promise.resolve({ ok: true, value: { path, entries: [makeFileEntry('in-b.txt')] } }),
    );
    const { result } = renderHook(() => useVolumeFiles('minecraft', 'data', true));

    act(() => result.current.open('/B'));
    await waitFor(() => expect(result.current.listing?.map((e) => e.name)).toEqual(['in-b.txt']));
    await act(async () => {
      resolveRoot({ ok: true, value: { path: '/', entries: [makeFileEntry('stale.txt')] } });
    });

    expect(result.current.listing?.map((e) => e.name)).toEqual(['in-b.txt']);
    expect(result.current.error).toBeNull();
  });

  it('should discard a listing and error that resolve after the volume has changed', async () => {
    let resolveData: (value: unknown) => void = () => undefined;
    apiMock.volumeList.mockImplementation((_game: string, volume: string, path: string) =>
      volume === 'data'
        ? new Promise((resolve) => (resolveData = resolve))
        : Promise.resolve({ ok: true, value: { path, entries: [makeFileEntry('mods.txt')] } }),
    );
    const { result, rerender } = renderHook(({ volume }) => useVolumeFiles('minecraft', volume, true), {
      initialProps: { volume: 'data' },
    });

    rerender({ volume: 'mods' });
    await waitFor(() => expect(result.current.listing?.map((e) => e.name)).toEqual(['mods.txt']));
    await act(async () => {
      resolveData({ ok: false, code: 'unreachable', message: 'stale failure' });
    });

    expect(result.current.listing?.map((e) => e.name)).toEqual(['mods.txt']);
    expect(result.current.error).toBeNull();
  });
});
