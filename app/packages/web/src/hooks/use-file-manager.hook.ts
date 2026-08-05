import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileMgrStatus, type FileMgrCredentials } from '../api.service.js';
import { usePollingActions } from '../polling/polling-provider.component.js';

/** Name under which the file-manager helper poll registers in the polling registry. */
export const FILE_MANAGER_POLLER = 'filemgr';
/** Reactive cadence while a helper task is starting or stopping. */
export const FILE_MANAGER_INTERVAL_MS = 5000;

/**
 * Manages the FileBrowser helper-task lifecycle for the file-manager modal.
 * Owns the currently-active game, the latest `FileMgrStatus`, a user-facing
 * message, and the one-time login credential a successful `start()` returns,
 * plus start/stop/close actions that drive `/api/files/:game/*`.
 *
 * Polling is reactive rather than interval-based: we register a 5-second
 * poller with the shared {@link PollingProvider} only while the helper task
 * is mid-transition. Two transient flags cover the windows ECS spends in a
 * "wrong" state right after `runTask` / `stopTask`:
 *
 *   - `pendingStart` — set on a successful Start, cleared once status reaches
 *     `starting` / `running`. Without it, an immediate read after `runTask`
 *     can come back `stopped` (the new task isn't visible to
 *     `listTasksByStartedBy` yet) and the poller would never register.
 *   - `pendingStop`  — set on a successful Stop, cleared once status reaches
 *     `stopped` / `not_deployed`. Without it, the post-Stop read still says
 *     `running` for a few seconds and the modal would stick on stale data.
 *
 * Either way, the registry unregisters automatically once the helper settles
 * or the modal closes, so there's no background polling for an idle task.
 */
export function useFileManager() {
  const { register } = usePollingActions();
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [status, setStatus] = useState<FileMgrStatus | null>(null);
  const [message, setMessage] = useState('');
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingStop, setPendingStop] = useState(false);
  // Held in its own piece of state, deliberately NOT part of `status`:
  // `fetchOnce` overwrites `status` from `api.filesMgrStatus()` on every poll
  // tick, which carries no credentials field at all (see `FileMgrStatus`'s
  // doc) — folding credentials into `status` would make them vanish on the
  // very next poll instead of staying visible for the rest of the session.
  const [credentials, setCredentials] = useState<FileMgrCredentials | null>(null);

  // Latest `activeGame` used inside the registered poller closure — keeps
  // the registration stable when the consumer toggles between games.
  const gameRef = useRef<string | null>(null);
  // Synced in an effect rather than assigned during render: a render-phase
  // ref write is visible to renders React may discard (`react-hooks/refs`).
  // Only the interval-driven poller closure reads this, so updating it after
  // commit is soon enough.
  useEffect(() => {
    gameRef.current = activeGame;
  });

  const fetchOnce = useCallback(async (game: string) => {
    const s = await api.filesMgrStatus(game);
    setStatus(s);

    // Clear the pending flags here rather than in an effect watching
    // `status.state`. `fetchOnce` is the only thing that ever advances the
    // status, so this fires at exactly the same moments the old effect did,
    // without the extra render pass that `react-hooks/set-state-in-effect`
    // flags. Deriving the flags at render instead would be wrong: the
    // transition is one-way, and a later move back to `stopped` must not
    // resurrect a `pendingStart` the user never re-requested.
    if (s.state === 'starting' || s.state === 'running') {
      setPendingStart(false);
    }
    if (s.state === 'stopped' || s.state === 'not_deployed') {
      setPendingStop(false);
    }
  }, []);

  const open = useCallback(
    (game: string) => {
      setActiveGame(game);
      setMessage('');
      setPendingStart(false);
      setPendingStop(false);
      setCredentials(null);
      void fetchOnce(game);
    },
    [fetchOnce],
  );

  const close = useCallback(() => {
    setActiveGame(null);
    setStatus(null);
    setMessage('');
    setPendingStart(false);
    setPendingStop(false);
    setCredentials(null);
  }, []);

  const start = useCallback(async () => {
    if (!activeGame) return;
    setMessage('Launching…');
    const result = await api.filesMgrStart(activeGame);
    setMessage(result.message);
    if (result.success) {
      setPendingStart(true);
      setCredentials(result.credentials ?? null);
      void fetchOnce(activeGame);
    }
  }, [activeGame, fetchOnce]);

  const stop = useCallback(async () => {
    if (!activeGame) return;
    const result = await api.filesMgrStop(activeGame);
    setMessage(result.message);
    if (result.success) {
      setPendingStop(true);
      setCredentials(null);
    }
    void fetchOnce(activeGame);
  }, [activeGame, fetchOnce]);

  // Register the reactive poller only while the helper task is mid-transition
  // (starting, start-in-flight, or stop-in-flight). Unregisters automatically
  // when the state settles or the modal closes.
  useEffect(() => {
    if (!activeGame) return;
    const transitioning = status?.state === 'starting' || pendingStart || pendingStop;
    if (!transitioning) return;
    return register(
      FILE_MANAGER_POLLER,
      async () => {
        const game = gameRef.current;
        if (!game) return;
        await fetchOnce(game);
      },
      FILE_MANAGER_INTERVAL_MS,
    );
  }, [register, activeGame, status?.state, pendingStart, pendingStop, fetchOnce]);

  return { activeGame, status, message, credentials, open, close, start, stop };
}
