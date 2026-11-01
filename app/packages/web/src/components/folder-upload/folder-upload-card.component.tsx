import { useCallback, useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { validateDestination, type VolumeLike } from '@hyveon/shared/folderUpload';
import { Button } from '@/components/ui/button.component';
import { SectionCard } from '../section-card.component.js';
import { ErrorBanner } from '../error-banner.component.js';
import { api } from '../../api.service.js';
import { FolderSeedSection } from './folder-seed-section.component.js';
import { FolderUploadProgressMeter } from './folder-upload-progress-meter.component.js';
import { summarizeSelection } from './folder-seed.utils.js';
import { useFolderSeed } from './use-folder-seed.hook.js';
import { useFolderUploadProgress } from './use-folder-upload-progress.hook.js';

/** Props for {@link FolderUploadCard}. */
export interface FolderUploadCardProps {
  /** Game to upload into. */
  game: string;
  /** The game's declared volumes. */
  volumes: VolumeLike[];
  /** Whether the game's infrastructure has been applied. */
  deployed: boolean;
}

/** Matches the start guard's message for an open file-manager session. */
const HELPER_OPEN = /already open/i;

// @spec HELPER-UPLOAD-004, HELPER-UPLOAD-006, HELPER-UPLOAD-011, HELPER-SELECT-005, HELPER-SAFE-004
/**
 * Game-page card for seeding a volume from a local folder: the selection (shared with the wizard's Storage step),
 * the upload action with its disabled explanations, and the progress meter.
 *
 * @remarks
 * Upload needs the game deployed and its server stopped. When the start guard reports an open file-manager session,
 * the card offers to stop that orphaned session and retry; the upload then launches its own secured session. The retry
 * runs only when the stop succeeded, otherwise the stop failure message is shown.
 *
 * @param props - See {@link FolderUploadCardProps}.
 */
export function FolderUploadCard({ game, volumes, deployed }: FolderUploadCardProps) {
  const seed = useFolderSeed({ game, volumes });
  const progress = useFolderUploadProgress(game);
  const [serverBusy, setServerBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [helperOpen, setHelperOpen] = useState(false);

  // Fetches whether the server task is up; setState only happens after the await, never synchronously in an effect.
  const refreshServer = useCallback(async () => {
    try {
      const status = await api.statusGame(game);
      setServerBusy(status.state === 'running' || status.state === 'starting');
    } catch {
      setServerBusy(false);
    }
  }, [game]);

  useEffect(() => {
    let cancelled = false;
    api
      .statusGame(game)
      .then((status) => {
        if (!cancelled) setServerBusy(status.state === 'running' || status.state === 'starting');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [game]);

  const { setLastRun } = seed;
  const reloadLastRun = useCallback(async () => {
    try {
      const stored = await api.folderGetSelection(game);
      setLastRun(stored?.lastRun ?? null);
    } catch {
      // The meter already shows the run's outcome; the persisted copy is only for after a restart.
    }
  }, [game, setLastRun]);

  const start = useCallback(async () => {
    const request = seed.request();
    if (!request) return;
    setStartError(null);
    setHelperOpen(false);
    setStarting(true);
    try {
      const result = await api.folderStartUpload(request);
      if (!result.started) {
        if (HELPER_OPEN.test(result.error)) setHelperOpen(true);
        else setStartError(result.error);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [seed]);

  async function stopHelperAndRetry() {
    setHelperOpen(false);
    try {
      const stopped = await api.volumeSessionStop(game);
      if (!stopped.ok) {
        setStartError(stopped.message);
        return;
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
      return;
    }
    await start();
  }

  const handleSettled = useCallback(() => {
    void reloadLastRun();
    void refreshServer();
  }, [reloadLastRun, refreshServer]);

  const running = progress?.phase === 'starting-helper' || progress?.phase === 'awaiting-confirmation' || progress?.phase === 'uploading' || progress?.phase === 'verifying';
  const destinationOk = seed.destination !== '' && validateDestination(seed.destination, volumes).ok;
  const selected = seed.scan ? summarizeSelection(seed.scan.tree, seed.include).files : 0;
  const ready = seed.scan !== null && destinationOk && selected > 0;

  let blocker: string | null = null;
  if (!deployed) blocker = 'This game has not been deployed yet. Apply the infrastructure first; your selection is kept.';
  else if (serverBusy) blocker = 'The game server is running. Stop it before uploading.';

  return (
    <SectionCard title="Seed from folder">
      <div className="space-y-4">
        <FolderSeedSection seed={seed} volumes={volumes} idPrefix="game-folder-seed" disabled={running} hideHeading />

        {seed.scan === null && seed.lastRun && !progress && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            A previous selection exists but its folder could not be read. Choose the folder again to resume.
          </p>
        )}

        {blocker && (
          <p role="status" className="text-xs text-[var(--color-muted-foreground)]">
            {blocker}
          </p>
        )}

        {startError && <ErrorBanner>{startError}</ErrorBanner>}

        {helperOpen && (
          <div role="alertdialog" aria-label="File manager session open" className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3 text-sm">
            <p>A file manager session for this game is already running. Stop it, then the upload starts its own session.</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => void stopHelperAndRetry()}>
                Stop session and upload
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setHelperOpen(false)}>
                Keep it open
              </Button>
            </div>
          </div>
        )}

        <Button type="button" disabled={!ready || blocker !== null || running || starting} onClick={() => void start()}>
          <Upload />
          Upload folder
        </Button>

        <FolderUploadProgressMeter
          game={game}
          progress={progress}
          lastRun={seed.lastRun}
          onRestart={() => void start()}
          restartDisabled={!ready || blocker !== null || starting}
          onSettled={handleSettled}
        />
      </div>
    </SectionCard>
  );
}
