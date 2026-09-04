import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.service.js';

/** Delay before re-polling `games.getStatus` after a Start/Stop call, to give the backend time to pick up the ECS state change. */
const REFRESH_DELAY_MS = 3000;

/** Live state and actions returned by {@link useGameActions}. */
export interface UseGameActionsResult {
  busy: boolean;
  start: () => void;
  stop: () => void;
}

/**
 * Start/Stop orchestration for a single game's card: calls the API, shows a toast (with an
 * Undo action on a successful stop), and schedules a delayed `onRefresh` so the backend has
 * time to pick up the ECS state change before the dashboard re-polls.
 *
 * @remarks
 * `error` counts as a startable state upstream — this hook itself is state-agnostic and just
 * exposes `start`/`stop`. The pending refresh timeout is tracked in a ref and cleared on
 * unmount and whenever a new `start`/`stop` call schedules its own timeout, so an unmounted
 * card never calls `setState` or `onRefresh` for a game that's no longer rendered.
 *
 * @param game - The game id to act on.
 * @param onRefresh - Called (after the refresh delay) to re-fetch this game's status.
 * @returns `busy` (true while a start/stop call and its pending refresh are in flight), plus
 *   `start` and `stop` action functions.
 */
export function useGameActions(game: string, onRefresh: (game: string) => void): UseGameActionsResult {
  const [busy, setBusy] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current !== null) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current !== null) {
      clearTimeout(refreshTimeoutRef.current);
    }
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null;
      onRefresh(game);
      setBusy(false);
    }, REFRESH_DELAY_MS);
  }, [game, onRefresh]);

  const start = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const res = await api.start(game);
        if (res.success) {
          toast.success(res.message);
        } else {
          toast.error(`Failed to start ${game}`, { description: res.message });
        }
      } catch (err) {
        toast.error(`Failed to start ${game}`, {
          description: err instanceof Error ? err.message : 'An unknown error occurred',
        });
      } finally {
        // Always schedule a refresh even on error — transient failures shouldn't
        // leave the card disabled until reload.
        scheduleRefresh();
      }
    })();
  }, [game, scheduleRefresh]);

  const stop = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const res = await api.stop(game);
        if (!res.success) {
          toast.error(`Failed to stop ${game}`, { description: res.message });
          return;
        }
        toast(res.message, {
          duration: 5000,
          action: {
            label: 'Undo',
            onClick: () => {
              void api.start(game)
                .then((undoRes) => {
                  if (!undoRes.success) {
                    toast.error(`Failed to undo stop of ${game}`, { description: undoRes.message });
                    return;
                  }
                  scheduleRefresh();
                })
                .catch((err: unknown) => {
                  toast.error(`Failed to undo stop of ${game}`, {
                    description: err instanceof Error ? err.message : 'An unknown error occurred',
                  });
                });
            },
          },
        });
      } catch (err) {
        toast.error(`Failed to stop ${game}`, {
          description: err instanceof Error ? err.message : 'An unknown error occurred',
        });
      } finally {
        scheduleRefresh();
      }
    })();
  }, [game, scheduleRefresh]);

  return { busy, start, stop };
}
