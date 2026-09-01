import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy,
  FolderOpen,
  ScrollText,
  CircleCheck,
  CircleX,
  Loader2,
  AlertTriangle,
  PowerOff,
  type LucideIcon,
} from 'lucide-react';
import { type GameStatus, type GameEstimate } from '../api.service.js';
import { Card } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { cn } from '@/lib/utils.utils';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { isSuppressed } from '../lib/confirm-skip.utils.js';
import { useGameActions } from '../hooks/use-game-actions.hook.js';

interface Props {
  status: GameStatus;
  estimate?: GameEstimate;
  onRefresh: (game: string) => void;
  onOpenFiles: (game: string) => void;
}

type ServerState = GameStatus['state'];

interface StatePresentation {
  label: string;
  badgeVariant: 'success' | 'warning' | 'destructive' | 'secondary';
  Icon: LucideIcon;
  accentClass: string;
  dotClass: string;
  lastRunLabel: string;
}

/**
 * Per-state presentation lookup keyed by {@link ServerState}, grouped so each state pulls its
 * badge/icon/accent/dot classes and labels from one place — `STATE_PRESENTATION[state].label`,
 * `STATE_PRESENTATION[state].Icon`, etc. Icons are always rendered `aria-hidden` — the text
 * label already conveys the state.
 */
const STATE_PRESENTATION: Record<ServerState, StatePresentation> = {
  running: {
    label: 'RUNNING',
    badgeVariant: 'success',
    Icon: CircleCheck,
    accentClass: 'bg-gradient-to-r from-[var(--color-cyan)] to-[var(--color-green)]',
    dotClass: 'size-1.5 rounded-full bg-[var(--color-green)] shadow-[0_0_6px_var(--color-green)] animate-pulse',
    lastRunLabel: 'Live',
  },
  starting: {
    label: 'STARTING',
    badgeVariant: 'warning',
    Icon: Loader2,
    accentClass: 'bg-gradient-to-r from-[var(--color-orange)] to-[var(--color-amber)]',
    dotClass: 'size-1.5 rounded-full bg-[var(--color-amber)] animate-pulse',
    lastRunLabel: 'Booting',
  },
  stopped: {
    label: 'STOPPED',
    badgeVariant: 'secondary',
    Icon: PowerOff,
    accentClass: 'bg-[var(--color-border)]',
    dotClass: 'size-1.5 rounded-full bg-[var(--color-muted-foreground)]',
    lastRunLabel: '—',
  },
  not_deployed: {
    label: 'NOT DEPLOYED',
    badgeVariant: 'secondary',
    Icon: CircleX,
    accentClass: 'bg-[var(--color-border)]',
    dotClass: 'size-1.5 rounded-full bg-[var(--color-muted-foreground)]',
    lastRunLabel: '—',
  },
  error: {
    label: 'ERROR',
    badgeVariant: 'destructive',
    Icon: AlertTriangle,
    accentClass: 'bg-[var(--color-red)]',
    dotClass: 'size-1.5 rounded-full bg-[var(--color-red)]',
    lastRunLabel: '—',
  },
};

/** Trim an ECS task ARN down to its 8-char short id (last segment of the ARN). */
function taskShortId(taskArn: string | undefined): string {
  if (!taskArn) return '—';
  const tail = taskArn.split('/').pop() ?? taskArn;
  return tail.slice(0, 8);
}

interface StatRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Stat({ label, value, mono }: StatRowProps) {
  return (
    <div>
      <div className="text-[0.65rem] uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
        {label}
      </div>
      <div className={cn('text-sm text-[var(--color-foreground)]', mono && 'font-[var(--font-mono)]')}>
        {value}
      </div>
    </div>
  );
}

/**
 * Card for a single game in the dashboard grid. Layout (top to bottom):
 *
 * 1. Gradient top-accent rule colored by state.
 * 2. Header — game name (Outfit 17/700) above hostname (DM Mono) with copy
 *    button, right-aligned status badge (icon + text + pulsing dot).
 * 3. Error reason — shown only in the `error` state, when `status.message`
 *    is present.
 * 4. 3-column stats grid — Last run, $/hr, Task short-id.
 * 5. Actions — Start / Stop primary (gradient) + Files / Logs secondary.
 *
 * After Start/Stop the card schedules a 3-second `onRefresh` to give the
 * backend time to pick up the ECS state change before re-polling
 * `/api/status/:game`.
 *
 * @remarks
 * `error` counts as a startable state (`canStart`) so the operator can
 * retry from a failed server without navigating away from the dashboard.
 */
export function GameCard({ status, estimate, onRefresh, onOpenFiles }: Props) {
  const { game, state, message } = status;
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stateAnnouncement, setStateAnnouncement] = useState('');
  const prevStateRef = useRef(state);
  const { busy, start, stop } = useGameActions(game, onRefresh);

  useEffect(() => {
    if (prevStateRef.current !== state) {
      setStateAnnouncement(`${game} server is now ${STATE_PRESENTATION[state].label.toLowerCase()}`);
      prevStateRef.current = state;
    }
  }, [state, game]);

  const canStart = state === 'stopped' || state === 'not_deployed' || state === 'error';
  const canStop  = state === 'running'  || state === 'starting';

  const connectStr = status.hostname ?? status.publicIp ?? null;
  const costPerHourLabel = estimate ? `$${estimate.costPerHour.toFixed(3)}` : '—';
  const { label, badgeVariant, Icon, accentClass, dotClass, lastRunLabel } = STATE_PRESENTATION[state];

  return (
    <>
      <ConfirmDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title={`Stop ${game}?`}
        description="Active sessions will end."
        confirmLabel="Stop server"
        confirmKey="stop-server"
        onConfirm={stop}
      />
      <Card className="relative overflow-hidden p-0 flex flex-col">
        {/* Screen-reader announcement for state transitions */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{stateAnnouncement}</span>

        {/* Top gradient accent rule */}
        <div className={cn('h-0.5 w-full', accentClass)} aria-hidden="true" />

        {/* Header */}
        <div className="px-5 pt-4 pb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-[var(--font-ui)] text-[17px] font-bold capitalize leading-tight text-[var(--color-foreground)]">
              {game}
            </h2>
            <div className="mt-1 flex items-center gap-1.5 min-w-0">
              <span
                className={cn(
                  'font-[var(--font-mono)] text-xs truncate',
                  connectStr ? 'text-[var(--color-cyan-light)]' : 'text-[var(--color-muted-foreground)]',
                )}
              >
                {connectStr ?? 'no hostname'}
              </span>
              {connectStr && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 min-w-11 p-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  onClick={() => void navigator.clipboard.writeText(connectStr)}
                  aria-label="Copy connect string"
                >
                  <Copy className="size-3" />
                </Button>
              )}
              {status.publicIp && status.hostname && (
                <span className="font-[var(--font-mono)] text-[0.65rem] text-[var(--color-muted-foreground)] truncate">
                  ({status.publicIp})
                </span>
              )}
            </div>
          </div>
          <Badge variant={badgeVariant} className="shrink-0 gap-1.5 text-[0.65rem]">
            <span className={dotClass} aria-hidden="true" />
            <Icon className={cn('size-3', state === 'starting' && 'motion-safe:animate-spin')} aria-hidden="true" />
            {label}
          </Badge>
        </div>

        {/* Error reason — only shown while the server is in the error state */}
        {state === 'error' && message && (
          <div
            data-testid={`game-card-error-${game}`}
            className="px-5 pb-3 -mt-2 flex items-start gap-1.5 text-xs text-[var(--color-red)]"
          >
            <AlertTriangle className="size-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </div>
        )}

        {/* 3-column stats grid */}
        <div className="px-5 pb-4 grid grid-cols-3 gap-x-4 gap-y-3 border-t border-[var(--color-border)] pt-4">
          <Stat label="Last run" value={lastRunLabel} />
          <Stat label="$ per hour" value={costPerHourLabel} />
          <Stat label="Task" value={taskShortId(status.taskArn)} mono />
        </div>

        {/* Actions */}
        <div className="px-5 pb-4 mt-auto flex flex-wrap gap-2">
          {canStart ? (
            <Button
              variant="start"
              size="sm"
              onClick={start}
              disabled={!canStart || busy}
              aria-busy={busy}
              aria-label={`Start ${game} server`}
              className="flex-1 min-w-[6rem] bg-gradient-to-r from-[var(--color-green)] to-[var(--color-cyan)] hover:brightness-110"
            >
              Start
            </Button>
          ) : (
            <Button
              variant="stop"
              size="sm"
              onClick={() => {
                if (isSuppressed('stop-server')) {
                  stop();
                } else {
                  setStopDialogOpen(true);
                }
              }}
              disabled={!canStop || busy}
              aria-busy={busy}
              aria-label={`Stop ${game} server`}
              className="flex-1 min-w-[6rem] bg-gradient-to-r from-[var(--color-red)] to-[var(--color-pink)] hover:brightness-110"
            >
              Stop
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => onOpenFiles(game)}>
            <FolderOpen className="size-3.5" />
            Files
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/logs" state={{ game }} aria-label={`View logs for ${game}`}>
              <ScrollText className="size-3.5" />
              Logs
            </Link>
          </Button>
        </div>
      </Card>
    </>
  );
}
