import { useCallback, useState } from 'react';
import type { VolumeFilesErrorCode } from '@hyveon/shared/volumeFiles';
import { useGameStatus } from '../../polling/game-status-provider.component.js';
import type { GameStatus } from '../../api.service.js';

/** Why file mutations are blocked, or `null` when they are allowed. */
export type ServerGuardBlock = 'running' | 'unconfirmed' | null;

/** Handle returned by {@link useServerGuard}. */
export interface ServerGuard {
  block: ServerGuardBlock;
  /** Feeds a failed operation's code so a `server-running` / `server-check-failed` result blocks further mutations. */
  noteFailure(code: VolumeFilesErrorCode): void;
  /** Re-reads the game's server status; the block clears once it reads `stopped`. */
  retry(): Promise<void>;
}

/**
 * Decides whether the game's server state allows changing files.
 *
 * @remarks
 * The game status poll blocks mutations while the server is `starting`/`running` and reports `error` as unconfirmed.
 * A mutation that comes back `server-running` or `server-check-failed` latches the same block until a status that
 * was fetched afterwards reads `stopped`. Must be rendered inside `<GameStatusProvider>`.
 *
 * @param game - Game whose server to watch.
 * @returns The current block, a failure reporter and a retry action.
 */
export function useServerGuard(game: string): ServerGuard {
  const { statuses, refreshGame } = useGameStatus();
  const current = statuses.find((s) => s.game === game);
  const [latch, setLatch] = useState<{ block: 'running' | 'unconfirmed'; seen: GameStatus | undefined } | null>(null);

  const latched = latch !== null && !(current !== latch.seen && current?.state === 'stopped') ? latch.block : null;
  let block: ServerGuardBlock = latched;
  if (current?.state === 'starting' || current?.state === 'running') block = 'running';
  else if (current?.state === 'error') block = 'unconfirmed';

  const noteFailure = useCallback(
    (code: VolumeFilesErrorCode) => {
      if (code === 'server-running') setLatch({ block: 'running', seen: current });
      else if (code === 'server-check-failed') setLatch({ block: 'unconfirmed', seen: current });
    },
    [current],
  );

  const retry = useCallback(() => refreshGame(game).catch(() => undefined), [game, refreshGame]);

  return { block, noteFailure, retry };
}
