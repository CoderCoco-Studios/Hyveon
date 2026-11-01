import { useCallback, useEffect, useRef, useState } from 'react';
import type { VolumeResult, VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { api } from '../../api.service.js';
import { usePoller } from '../../polling/polling-provider.component.js';
import { settleVolumeResult } from './volume-files.utils.js';

/** Poller name for the session status refresh while a session exists. */
export const VOLUME_SESSION_POLLER = 'volumeSession';

/** Interval between status refreshes while the session is starting or stopping. */
export const VOLUME_SESSION_INTERVAL_MS = 3000;

/** Interval between status refreshes while the session is running, to notice a helper that vanished. */
export const VOLUME_SESSION_RUNNING_INTERVAL_MS = 30_000;

/** Handle returned by {@link useVolumeSession}. */
export interface VolumeSession {
  /** Latest session status for the game, or `null` before the first attach resolves. */
  status: VolumeSessionStatus | null;
  /** Launches the session; progress follows through pushes and polling. */
  start(): Promise<void>;
  /** Stops the session. */
  stop(): Promise<void>;
  /** Stops and relaunches the session. */
  restart(): Promise<void>;
  /** Re-reads the status now (a no-op unless the session is starting, stopping or running); failures are swallowed. */
  refresh(): Promise<void>;
  /** Attaches again after a failed attach, clearing the error first. */
  reattach(): Promise<void>;
  /** Message of the last failed session action, or `null`. */
  error: string | null;
}

// @spec HELPER-FB-015, HELPER-FB-016, HELPER-FB-021
/**
 * Follows one game's file-browser helper session.
 *
 * @remarks
 * Holds the session while mounted: attaches on mount and detaches on unmount so the auto-stop timer is not kept alive
 * by a closed page. Status pushes for this game replace the local status, and a poller refreshes it every
 * {@link VOLUME_SESSION_INTERVAL_MS} while the state is `starting` or `stopping` and every
 * {@link VOLUME_SESSION_RUNNING_INTERVAL_MS} while `running`, because only a status read notices a helper that has
 * vanished. Must be rendered inside `<PollingProvider>`.
 *
 * @param game - Game whose session to follow.
 * @returns The status, the start/stop/restart/refresh/reattach actions and the last action error.
 */
export function useVolumeSession(game: string): VolumeSession {
  // Keyed by game so switching games never shows the previous game's status or error.
  const [snapshot, setSnapshot] = useState<{ game: string; status: VolumeSessionStatus } | null>(null);
  const [failure, setFailure] = useState<{ game: string; message: string } | null>(null);
  // Names the game this hook is currently attached to (`null` once unmounted), so a late result for a game the hook
  // has since left is dropped even though the hook itself is still mounted. Re-armed in the effect body for StrictMode.
  const activeGameRef = useRef<string | null>(null);

  // Bumped whenever a status is applied, so a status read that started earlier can tell it has been overtaken.
  const statusVersionRef = useRef(0);

  const isActive = useCallback(() => activeGameRef.current === game, [game]);

  const applyStatus = useCallback(
    (next: VolumeSessionStatus) => {
      if (isActive() && next.game === game) {
        statusVersionRef.current += 1;
        setSnapshot({ game, status: next });
      }
    },
    [game, isActive],
  );

  const attach = useCallback(
    () =>
      settleVolumeResult(async () => ({ ok: true, value: await api.volumeSessionAttach(game) })).then((result) => {
        if (!isActive()) return;
        if (result.ok) applyStatus(result.value);
        else setFailure({ game, message: result.message });
      }),
    [game, applyStatus, isActive],
  );

  useEffect(() => {
    activeGameRef.current = game;
    const unsubscribe = api.volumeOnSession(applyStatus);
    void attach();
    return () => {
      activeGameRef.current = null;
      unsubscribe();
      void api.volumeSessionDetach(game).catch(() => undefined);
    };
  }, [game, applyStatus, attach]);

  const reattach = useCallback(async () => {
    setFailure(null);
    await attach();
  }, [attach]);

  const status = snapshot?.game === game ? snapshot.status : null;

  const refresh = useCallback(async () => {
    const version = statusVersionRef.current;
    const next = await api.volumeSessionStatus(game);
    // An action result, push or attach applied a newer status while this read was in flight; it is stale.
    if (version === statusVersionRef.current) applyStatus(next);
  }, [game, applyStatus]);

  const state = status?.state;
  const transitional = state === 'starting' || state === 'stopping';
  const { refresh: pollNow } = usePoller(
    VOLUME_SESSION_POLLER,
    refresh,
    transitional ? VOLUME_SESSION_INTERVAL_MS : VOLUME_SESSION_RUNNING_INTERVAL_MS,
    transitional || state === 'running',
  );

  const act = useCallback(
    async (action: () => Promise<VolumeResult<VolumeSessionStatus>>) => {
      setFailure(null);
      const result = await settleVolumeResult(action);
      if (!isActive()) return;
      if (result.ok) applyStatus(result.value);
      else setFailure({ game, message: result.message });
    },
    [game, applyStatus, isActive],
  );

  const start = useCallback(
    () => act(async () => ({ ok: true, value: await api.volumeSessionStart(game) })),
    [act, game],
  );
  const stop = useCallback(() => act(() => api.volumeSessionStop(game)), [act, game]);
  const restart = useCallback(() => act(() => api.volumeSessionRestart(game)), [act, game]);

  return { status, start, stop, restart, refresh: pollNow, reattach, error: failure?.game === game ? failure.message : null };
}
