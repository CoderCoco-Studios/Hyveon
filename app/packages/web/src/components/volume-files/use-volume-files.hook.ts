import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  VolumeEntryInfo,
  VolumeResult,
  VolumeTextFile,
  VolumeTransferProgress,
} from '@hyveon/shared/volumeFiles';
import { joinVolumePath } from '@hyveon/shared/volumeFiles';
import { api } from '../../api.service.js';
import { useVolumeTransfers } from './use-volume-transfers.hook.js';
import { settleVolumeResult, sortVolumeEntries, type VolumeSort } from './volume-files.utils.js';

/** Handle returned by {@link useVolumeFiles}. */
export interface VolumeFiles {
  /** Directory being shown; `/` is the volume root. */
  path: string;
  /** Sorted entries of {@link VolumeFiles.path}, or `null` until the first listing resolves. */
  listing: VolumeEntryInfo[] | null;
  sort: VolumeSort;
  setSort(sort: VolumeSort): void;
  /** Navigates to a full volume path. */
  open(path: string): void;
  refresh(): Promise<void>;
  /** Creates a folder under the current path. */
  mkdir(name: string): Promise<VolumeResult<VolumeEntryInfo>>;
  /** Renames the entry at a full volume path. */
  rename(path: string, newName: string): Promise<VolumeResult<VolumeEntryInfo>>;
  /** Deletes the entry at a full volume path. */
  remove(path: string): Promise<VolumeResult<true>>;
  readText(path: string): Promise<VolumeResult<VolumeTextFile>>;
  writeText(path: string, content: string, expectedModifiedMs: number): Promise<VolumeResult<{ modifiedMs: number }>>;
  /** Downloads an entry of the current directory; main asks where to save it. */
  download(entry: VolumeEntryInfo): Promise<void>;
  /** Uploads files picked in main's dialog into the current directory. */
  uploadFiles(): Promise<void>;
  /** Uploads files dropped onto the page into the current directory. */
  uploadDropped(files: File[]): Promise<void>;
  /** Uploads a folder picked in main's dialog into the current directory; its progress is the folder-upload meter's. */
  uploadFolder(): Promise<void>;
  transfers: VolumeTransferProgress[];
  /** Message of the last failed listing or operation, or `null`. */
  error: string | null;
}

const ROOT = '/';
const DEFAULT_SORT: VolumeSort = { key: 'name', dir: 'asc' };

/**
 * Lists and operates on one volume of a game's file-browser session.
 *
 * @remarks
 * Does nothing until `enabled` and a `volume` are both set. Changing the game or volume resets the path to the root.
 * Every operation clears the previous error, then either refreshes the listing (mutations) or sets {@link VolumeFiles.error}
 * from the failed result's message; a rejected IPC call is reported the same way. `readText` and `writeText` return
 * their result so an editor can react, and also set `error`. Uploads finish asynchronously: the listing refreshes when
 * a pushed upload transfer settles as `done`.
 *
 * @param game - Game whose session serves the volume.
 * @param volume - Volume name, sent verbatim (empty for a legacy default volume), or `null` before one is chosen.
 * @param enabled - False while the session is not ready to serve requests.
 * @returns The listing, navigation, operations, transfers and last error.
 */
export function useVolumeFiles(game: string, volume: string | null, enabled: boolean): VolumeFiles {
  const scope = `${game}\0${volume ?? ''}`;
  // Keyed by scope so switching game or volume never shows the previous one's path, listing or error.
  const [location, setLocation] = useState({ scope, path: ROOT });
  const [loaded, setLoaded] = useState<{ scope: string; path: string; entries: VolumeEntryInfo[] } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const [sort, setSort] = useState<VolumeSort>(DEFAULT_SORT);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const path = location.scope === scope ? location.path : ROOT;
  const canList = enabled && volume !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!canList) return;
    const request = ++requestRef.current;
    const result = await settleVolumeResult(() => api.volumeList(game, volume, path));
    if (!mountedRef.current || request !== requestRef.current) return;
    if (result.ok) setLoaded({ scope, path, entries: result.value.entries });
    else setFailure({ scope, message: result.message });
  }, [canList, game, volume, path, scope]);

  // Mutations resolve later than the render that started them; they must refresh the current path, not their own.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  const transfers = useVolumeTransfers(game, refresh);

  /** Runs one operation against the current volume, refreshing the listing on success when asked. */
  const run = useCallback(
    async <T>(operation: (vol: string) => Promise<VolumeResult<T>>, refreshOnSuccess: boolean): Promise<VolumeResult<T>> => {
      if (volume === null) return { ok: false, code: 'unknown-volume', message: 'No volume selected.' };
      setFailure(null);
      const result = await settleVolumeResult(() => operation(volume));
      if (!mountedRef.current) return result;
      if (!result.ok) setFailure({ scope, message: result.message });
      else if (refreshOnSuccess) await refreshRef.current();
      return result;
    },
    [volume, scope],
  );

  const open = useCallback(
    (next: string) => {
      setFailure(null);
      setLocation({ scope, path: next });
    },
    [scope],
  );

  const listing = useMemo(
    () => (loaded?.scope === scope && loaded.path === path ? sortVolumeEntries(loaded.entries, sort) : null),
    [loaded, scope, path, sort],
  );

  return {
    path,
    listing,
    sort,
    setSort,
    open,
    refresh,
    mkdir: (name) => run((vol) => api.volumeMkdir(game, vol, path, name), true),
    rename: (from, newName) => run((vol) => api.volumeRename(game, vol, from, newName), true),
    remove: (target) => run((vol) => api.volumeRemove(game, vol, target), true),
    readText: (target) => run((vol) => api.volumeReadText(game, vol, target), false),
    writeText: (target, content, expectedModifiedMs) =>
      run((vol) => api.volumeWriteText(game, vol, target, content, expectedModifiedMs), false),
    download: async (entry) => {
      await run((vol) => api.volumeDownload(game, vol, joinVolumePath(path, entry.name), entry.isDir), false);
    },
    uploadFiles: async () => {
      await run((vol) => api.volumeUploadFiles(game, vol, path), false);
    },
    uploadDropped: async (files) => {
      await run((vol) => api.volumeUploadDropped(game, vol, path, files), false);
    },
    uploadFolder: async () => {
      await run(async (vol) => {
        const result = await api.volumeUploadFolder(game, vol, path);
        if (result.ok && result.value?.started === false) return { ok: false, code: 'failed', message: result.value.error };
        return result;
      }, false);
    },
    transfers,
    error: failure?.scope === scope ? failure.message : null,
  };
}
