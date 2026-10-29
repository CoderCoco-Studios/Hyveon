import { useCallback, useEffect, useRef, useState } from 'react';
import type { VolumeResult, VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { api } from '../../api.service.js';
import { usePoller } from '../../polling/polling-provider.component.js';
import { settleVolumeResult } from './volume-files.utils.js';

/** Poller name for the session status refresh while the session is in a transitional state. */
export const VOLUME_SESSION_POLLER = 'volumeSession';

/** Interval between status refreshes while the session is starting or stopping. */
export const VOLUME_SESSION_INTERVAL_MS = 3000;

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
  /** Message of the last failed session action, or `null`. */
  error: string | null;
}

/**
 * Follows one game's file-browser helper session.
 *
 * @remarks
 * Holds the session while mounted: attaches on mount and detaches on unmount so the auto-stop timer is not kept alive
 * by a closed page. Status pushes for this game replace the local status, and a poller refreshes it every
 * {@link VOLUME_SESSION_INTERVAL_MS} while the state is `starting` or `stopping`, ending at `running` (ready) or a
 * terminal state. Must be rendered inside `<PollingProvider>`.
 *
 * @param game - Game whose session to follow.
 * @returns The status, the start/stop/restart actions and the last action error.
 */
export function useVolumeSession(game: string): VolumeSession {
  // Keyed by game so switching games never shows the previous game's status or error.
  const [snapshot, setSnapshot] = useState<{ game: string; status: VolumeSessionStatus } | null>(null);
  const [failure, setFailure] = useState<{ game: string; message: string } | null>(null);
  const mountedRef = useRef(true);

  const applyStatus = useCallback(
    (next: VolumeSessionStatus) => {
      if (mountedRef.current && next.game === game) setSnapshot({ game, status: next });
    },
    [game],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = api.volumeOnSession(applyStatus);
    void settleVolumeResult(async () => ({ ok: true, value: await api.volumeSessionAttach(game) })).then((result) => {
      if (!mountedRef.current) return;
      if (result.ok) applyStatus(result.value);
      else setFailure({ game, message: result.message });
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      void api.volumeSessionDetach(game).catch(() => undefined);
    };
  }, [game, applyStatus]);

  const status = snapshot?.game === game ? snapshot.status : null;

  const refresh = useCallback(async () => {
    applyStatus(await api.volumeSessionStatus(game));
  }, [game, applyStatus]);

  usePoller(VOLUME_SESSION_POLLER, refresh, VOLUME_SESSION_INTERVAL_MS, status?.state === 'starting' || status?.state === 'stopping');

  const act = useCallback(
    async (action: () => Promise<VolumeResult<VolumeSessionStatus>>) => {
      setFailure(null);
      const result = await settleVolumeResult(action);
      if (!mountedRef.current) return;
      if (result.ok) applyStatus(result.value);
      else setFailure({ game, message: result.message });
    },
    [game, applyStatus],
  );

  const start = useCallback(
    () => act(async () => ({ ok: true, value: await api.volumeSessionStart(game) })),
    [act, game],
  );
  const stop = useCallback(() => act(() => api.volumeSessionStop(game)), [act, game]);
  const restart = useCallback(() => act(() => api.volumeSessionRestart(game)), [act, game]);

  return { status, start, stop, restart, error: failure?.game === game ? failure.message : null };
}
