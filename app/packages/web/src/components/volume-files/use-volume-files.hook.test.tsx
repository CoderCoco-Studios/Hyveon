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

  it('should return read and write results and surface their failures', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeReadText.mockResolvedValue({ ok: true, value: { path: '/a.txt', content: 'hi', modifiedMs: 7 } });
    apiMock.volumeWriteText.mockResolvedValue({ ok: false, code: 'conflict', message: 'changed on disk' });

    const read = await act(() => result.current.readText('/a.txt'));
    const write = await act(() => result.current.writeText('/a.txt', 'yo', 7));

    expect(read).toEqual({ ok: true, value: { path: '/a.txt', content: 'hi', modifiedMs: 7 } });
    expect(write.ok).toBe(false);
    expect(apiMock.volumeWriteText).toHaveBeenCalledWith('minecraft', 'data', '/a.txt', 'yo', 7);
    expect(result.current.error).toBe('changed on disk');
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

  it('should track transfers for this game and refresh the listing when an upload finishes', async () => {
    const { result } = await renderLoaded();
    apiMock.volumeList.mockClear();

    act(() => pushTransfer(makeTransfer({ transferId: 'u1', phase: 'done' })));

    expect(result.current.transfers.map((t) => t.transferId)).toEqual(['u1']);
    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledOnce());
  });
});
