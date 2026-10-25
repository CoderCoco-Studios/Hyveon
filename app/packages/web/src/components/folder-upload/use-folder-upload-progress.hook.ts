import { useEffect, useRef, useState } from 'react';
import { api, type FolderUploadProgress } from '../../api.service.js';

/**
 * Tracks the latest upload progress snapshot for `game`.
 *
 * @remarks
 * Asks main for the current snapshot on mount, so a reopened page resumes a run already in flight, then follows the
 * push channel. Snapshots for other games are ignored.
 *
 * @param game - Game whose run to follow.
 * @returns The latest snapshot, or `null` when no run exists in this session.
 */
export function useFolderUploadProgress(game: string): FolderUploadProgress | null {
  // Keyed by game so switching games never shows the previous game's snapshot.
  const [snapshot, setSnapshot] = useState<{ game: string; progress: FolderUploadProgress | null } | null>(null);
  // Snapshots pushed before the initial getProgress resolves are newer than its answer.
  const pushedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    pushedRef.current = false;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.folderOnProgress((next) => {
        if (cancelled || next.game !== game) return;
        pushedRef.current = true;
        setSnapshot({ game, progress: next });
      });
    } catch {
      // No bridge: the meter just stays empty.
    }
    void (async () => {
      try {
        const current = await api.folderGetProgress(game);
        if (!cancelled && !pushedRef.current) setSnapshot({ game, progress: current });
      } catch {
        // Best-effort restore.
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [game]);

  return snapshot?.game === game ? snapshot.progress : null;
}
