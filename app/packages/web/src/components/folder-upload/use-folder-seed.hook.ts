import { useCallback, useEffect, useRef, useState } from 'react';
import { selectAll } from './folder-seed.utils.js';
import { api, type FolderScanResult, type FolderUploadRequest } from '../../api.service.js';
import { validateDestination, type FolderUploadLastRun, type VolumeLike } from '@hyveon/shared/folderUpload';

/** Options for {@link useFolderSeed}. */
export interface UseFolderSeedOptions {
  /** Game the selection belongs to; empty while a wizard draft has no name yet (nothing is persisted then). */
  game: string;
  /** The game's volumes; the destination defaults to the first one's path and is only persisted when valid against them. */
  volumes: VolumeLike[];
}

/** What {@link useFolderSeed} returns. */
export interface FolderSeedState {
  scan: FolderScanResult | null;
  include: string[];
  destination: string;
  /** Outcome of the most recent run, from the persisted per-game state. */
  lastRun: FolderUploadLastRun | null;
  /** Message from a failed pick or persist; restore failures are intentionally silent. */
  error: string | null;
  /** Restores the persisted selection (and a live scan) once per game; safe to call on every mount. */
  load: () => Promise<void>;
  /** Opens the native folder dialog and selects the whole folder. */
  pick: () => Promise<void>;
  setInclude: (include: string[]) => void;
  setDestination: (destination: string) => void;
  /** Persists the current selection under `asGame` (defaults to `game`); used by the wizard once the final name is known. */
  persistAs: (asGame?: string) => Promise<void>;
  /** The request to hand to `startUpload`, or `null` without a scan, a game, or a destination. */
  request: () => FolderUploadRequest | null;
  /** Deletes every selection this hook persisted (under any draft name), including saves still in flight; a name whose clear fails stays tracked for a retry. Does not touch in-memory state. */
  discardPersisted: () => Promise<void>;
  /** Forgets all in-memory state and which names were persisted (the persisted selection itself is left alone). */
  reset: () => void;
  /** Records a run outcome without re-reading it from main. */
  setLastRun: (lastRun: FolderUploadLastRun | null) => void;
}

/**
 * Owns the "seed from folder" selection: the scanned tree, the included paths, and the destination, restoring them from
 * the persisted per-game state and writing each change back with `setSelection`.
 *
 * @remarks
 * The hook lives above the step components so the wizard's selection survives moving between steps. The scan itself is
 * held in main and referenced by id; after an app restart `load` asks main to re-scan the remembered folder.
 *
 * @param options - See {@link UseFolderSeedOptions}.
 * @returns State and actions; see {@link FolderSeedState}.
 */
export function useFolderSeed({ game, volumes }: UseFolderSeedOptions): FolderSeedState {
  const [scan, setScan] = useState<FolderScanResult | null>(null);
  const [include, setIncludeState] = useState<string[]>([]);
  const [destination, setDestinationState] = useState('');
  const [lastRun, setLastRun] = useState<FolderUploadLastRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaultDestination = volumes[0]?.container_path ?? '';
  const loadedFor = useRef<string | null>(null);
  const scanRef = useRef<FolderScanResult | null>(null);
  /** Every game name a selection was saved under, so a discarded wizard draft can clear them all (the name may change). */
  const persistedAs = useRef<Set<string>>(new Set());
  /** Saves still awaiting `folderSetSelection`; each resolves to the name it persisted, or `null` on failure. */
  const inFlight = useRef<Set<Promise<string | null>>>(new Set());
  // Re-armed in the effect body so StrictMode's simulated unmount does not disable later setState calls.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback(
    async (target: string, nextScan: FolderScanResult | null, nextInclude: string[], nextDestination: string) => {
      if (!target || !nextScan || !validateDestination(nextDestination, volumes).ok) return;
      const save = (async (): Promise<string | null> => {
        try {
          await api.folderSetSelection({ game: target, scanId: nextScan.scanId, include: nextInclude, destination: nextDestination });
          persistedAs.current.add(target);
          return target;
        } catch (err) {
          if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
          return null;
        }
      })();
      inFlight.current.add(save);
      try {
        await save;
      } finally {
        inFlight.current.delete(save);
      }
    },
    [volumes],
  );

  const load = useCallback(async () => {
    if (!game || loadedFor.current === game) return;
    loadedFor.current = game;
    try {
      const stored = await api.folderGetSelection(game);
      if (!mountedRef.current || !stored || scanRef.current) return;
      setIncludeState(stored.include);
      setDestinationState(stored.destination);
      setLastRun(stored.lastRun ?? null);
      const rescanned = await api.folderRescan(game);
      if (!mountedRef.current || scanRef.current || !rescanned) return;
      scanRef.current = rescanned;
      setScan(rescanned);
    } catch {
      // Restoring is best-effort: a missing folder or bridge just leaves the section empty.
    }
  }, [game]);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const picked = await api.folderPick();
      if (!mountedRef.current || !picked) return;
      const nextInclude = selectAll(picked.tree);
      const nextDestination = destination || defaultDestination;
      loadedFor.current = game;
      scanRef.current = picked;
      setScan(picked);
      setIncludeState(nextInclude);
      setDestinationState(nextDestination);
      await persist(game, picked, nextInclude, nextDestination);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [game, destination, defaultDestination, persist]);

  const setInclude = useCallback(
    (next: string[]) => {
      setIncludeState(next);
      void persist(game, scan, next, destination);
    },
    [game, scan, destination, persist],
  );

  const setDestination = useCallback(
    (next: string) => {
      setDestinationState(next);
      void persist(game, scan, include, next);
    },
    [game, scan, include, persist],
  );

  const persistAs = useCallback(
    (asGame?: string) => persist(asGame ?? game, scan, include, destination),
    [game, scan, include, destination, persist],
  );

  const request = useCallback((): FolderUploadRequest | null => {
    if (!game || !scan || !destination) return null;
    return { game, scanId: scan.scanId, include, destination };
  }, [game, scan, include, destination]);

  const discardPersisted = useCallback(async () => {
    const pending = [...inFlight.current];
    const names = new Set(persistedAs.current);
    // A save still in flight would re-persist the discarded selection once it lands, so wait for it and clear that too.
    for (const name of await Promise.all(pending)) if (name) names.add(name);
    await Promise.all(
      [...names].map(async (name) => {
        try {
          await api.folderClearSelection(name);
          persistedAs.current.delete(name);
        } catch {
          // Stay tracked so a later discard retries; the selection is only ever a convenience, so nothing is surfaced.
          persistedAs.current.add(name);
        }
      }),
    );
  }, []);

  const reset = useCallback(() => {
    persistedAs.current.clear();
    loadedFor.current = null;
    scanRef.current = null;
    setScan(null);
    setIncludeState([]);
    setDestinationState('');
    setLastRun(null);
    setError(null);
  }, []);

  return { scan, include, destination, lastRun, error, load, pick, setInclude, setDestination, persistAs, request, discardPersisted, reset, setLastRun };
}
