import { useEffect, useRef, useState } from 'react';
import type { VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { api } from '../../api.service.js';

/**
 * Tracks the download and upload progress pushed for one game.
 *
 * @remarks
 * Rows are upserted by `transferId` and keep first-seen order. Pushes for other games are ignored and a game change
 * drops the previous game's rows.
 *
 * @param game - Game whose transfers to track.
 * @param onUploadDone - Called when an upload for this game settles as `done`, so the caller can refresh its listing.
 * @returns Every transfer seen for the game since the page mounted.
 */
export function useVolumeTransfers(game: string, onUploadDone?: () => void): VolumeTransferProgress[] {
  const [state, setState] = useState<{ game: string; transfers: VolumeTransferProgress[] }>({ game, transfers: [] });
  const onUploadDoneRef = useRef(onUploadDone);

  useEffect(() => {
    onUploadDoneRef.current = onUploadDone;
  });

  useEffect(() => {
    return api.volumeOnTransfer((progress) => {
      if (progress.game !== game) return;
      setState((prev) => {
        const transfers = prev.game === game ? prev.transfers : [];
        const index = transfers.findIndex((t) => t.transferId === progress.transferId);
        if (index === -1) return { game, transfers: [...transfers, progress] };
        return { game, transfers: transfers.map((t, i) => (i === index ? progress : t)) };
      });
      if (progress.kind === 'upload' && progress.phase === 'done') onUploadDoneRef.current?.();
    });
  }, [game]);

  return state.game === game ? state.transfers : [];
}
