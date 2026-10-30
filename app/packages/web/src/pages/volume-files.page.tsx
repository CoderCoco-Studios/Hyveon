import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { FolderX } from 'lucide-react';
import { Button } from '@/components/ui/button.component';
import { EmptyStateCard } from '../components/empty-state-card.component.js';
import { InlineAlert } from '../components/inline-alert.component.js';
import { LoadingState } from '../components/loading-state.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { SessionBar } from '../components/volume-files/session-bar.component.js';
import { useVolumeSession } from '../components/volume-files/use-volume-session.hook.js';
import { useVolumeTransfers } from '../components/volume-files/use-volume-transfers.hook.js';
import { VolumeBrowser } from '../components/volume-files/volume-browser.component.js';
import { VolumePicker } from '../components/volume-files/volume-picker.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

/** Router state the dashboard sets so the page launches the session on arrival. */
interface FilesRouteState {
  autoStart?: boolean;
}

/** Message for each session state that has nothing to browse, keyed by state. */
const IDLE_MESSAGES = {
  stopped: 'The file browser session is not running. Start it to browse this game’s volumes.',
  starting: 'Starting the file browser session…',
  stopping: 'Stopping the file browser session…',
  orphaned: 'A previous file browser session is still running. Restart it to browse.',
  failed: 'The file browser session is not running. Start it to try again.',
} as const;

/**
 * Game volume file browser route (`/games/:name/files`).
 *
 * @remarks
 * Holds a file-browser helper session while open. Arriving with `state.autoStart` (the dashboard Files action)
 * launches the session once when it is stopped or failed, then clears the state so Back and refresh do not relaunch;
 * opening the page any other way only shows the session's state.
 */
export function VolumeFilesPage() {
  const { name = '' } = useParams<{ name: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useVolumeSession(name);
  // Downloads are not counted in `uploadHolders`, so the session bar needs the pushed transfers to know one is running.
  const transferActive = useVolumeTransfers(name).some((t) => t.phase === 'running');
  const [chosen, setChosen] = useState<string | null>(null);
  // The volume last browsed while running, so an open editor survives the session leaving `running`.
  const [lastBrowsed, setLastBrowsed] = useState<{ game: string; volume: string } | null>(null);
  const autoStartDone = useRef(false);
  const { status } = session;
  const { start } = session;

  const autoStart = (location.state as FilesRouteState | null)?.autoStart === true;
  const state = status?.state;
  useEffect(() => {
    if (!autoStart || autoStartDone.current || state === undefined || state === 'stopping') return;
    autoStartDone.current = true;
    if (state === 'stopped' || state === 'failed') void start();
    navigate(location.pathname, { replace: true, state: null });
  }, [autoStart, state, start, navigate, location.pathname]);

  const volumes = status?.volumes ?? [];
  const selected = volumes.find((v) => v.name === chosen && v.mounted) ?? volumes.find((v) => v.mounted) ?? null;
  const running = state === 'running';
  if (running && selected && (lastBrowsed?.game !== name || lastBrowsed.volume !== selected.name)) {
    setLastBrowsed({ game: name, volume: selected.name });
  }
  const browseVolume = running ? (selected?.name ?? null) : lastBrowsed?.game === name ? lastBrowsed.volume : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={name} titleClassName="capitalize" subtitle="Game files" backTo={`/games/${name}`} backLabel="Back to game">
        <PollingIndicator />
      </PageHeader>

      {status === null ? (
        session.error !== null ? (
          <div className="space-y-3">
            <InlineAlert message={session.error} />
            <Button size="sm" variant="outline" onClick={() => void session.reattach()}>
              Retry
            </Button>
          </div>
        ) : (
          <LoadingState label="Checking the file browser session…" />
        )
      ) : status.state === 'not_deployed' ? (
        <EmptyStateCard icon={FolderX} title="Nothing to browse yet" description="This game's volume doesn't exist yet. Apply the infrastructure first." />
      ) : (
        <>
          <SessionBar status={status} transferActive={transferActive} actionError={session.error} onStart={() => void session.start()} onStop={() => void session.stop()} onRestart={() => void session.restart()} onAutoStopDue={() => void session.refresh()} />
          {volumes.length > 0 && <VolumePicker volumes={volumes} selected={selected?.name ?? null} onSelect={setChosen} />}
          {browseVolume !== null && (
            <VolumeBrowser game={name} volume={browseVolume} status={status} ended={!running} onSessionLost={() => void session.refresh()} />
          )}
          {running && browseVolume === null && (
            <p className="text-sm text-[var(--color-muted-foreground)]">No volume is available to browse. Apply the infrastructure first.</p>
          )}
          {status.state !== 'running' && (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {IDLE_MESSAGES[status.state]}
            </p>
          )}
        </>
      )}
    </div>
  );
}
