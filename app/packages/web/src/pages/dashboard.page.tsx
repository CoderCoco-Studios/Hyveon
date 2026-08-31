import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Server, ExternalLink, AlertTriangle } from 'lucide-react';
import { useGameStatus } from '../polling/game-status-provider.component.js';
import { useFileManager } from '../hooks/use-file-manager.hook.js';
import { GameCard } from '../components/game-card.component.js';
import { KpiStrip } from '../components/kpi-strip.component.js';
import { FileManagerModal } from '../components/file-manager-modal.component.js';
import { PendingChangesBanner } from '../components/pending-changes-banner.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { Input } from '@/components/ui/input.component';
import { Button } from '@/components/ui/button.component';
import { EmptyStateCard } from '@/components/empty-state-card.component';

/**
 * Dashboard route (`/`) — top KPI strip, then a search-filterable grid of
 * GameCards. Cost analysis lives at `/costs`, Discord settings at `/discord`,
 * the live log tail at `/logs`, and the watchdog at `/settings`. The search
 * input narrows the grid by game name or hostname client-side.
 */
export function DashboardPage() {
  const { statuses, estimates, loading, error, refresh, refreshGame } = useGameStatus();
  const fileMgr = useFileManager();
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => {
      const host = (s.hostname ?? s.publicIp ?? '').toLowerCase();
      return s.game.toLowerCase().includes(q) || host.includes(q);
    });
  }, [statuses, query]);

  return (
    <>
      <div className="max-w-7xl mx-auto">
        {/* Pending infrastructure changes banner */}
        <PendingChangesBanner />

        {/* KPI strip */}
        <KpiStrip statuses={statuses} estimates={estimates} />

        {/* Search filter + polling indicator */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--color-muted-foreground)] pointer-events-none" />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by game or hostname…"
              className="pl-9"
              aria-label="Filter games"
            />
          </div>
          <PollingIndicator />
        </div>

        {/* Game cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-6">
          {loading ? (
            <div className="col-span-full text-sm text-[var(--color-muted-foreground)] py-8 text-center">
              Loading servers…
            </div>
          ) : error && statuses.length === 0 ? (
            <div className="col-span-full py-8 flex justify-center">
              <StatusErrorCard error={error} onRetry={refresh} />
            </div>
          ) : statuses.length === 0 ? (
            <div className="col-span-full py-8 flex justify-center">
              <NoGamesCard />
            </div>
          ) : visible.length === 0 ? (
            <div className="col-span-full text-sm text-[var(--color-muted-foreground)] py-8 text-center">
              No games match <span className="font-[var(--font-mono)]">&quot;{query}&quot;</span>.
            </div>
          ) : (
            visible.map((s) => (
              <GameCard
                key={s.game}
                status={s}
                estimate={estimates?.games[s.game]}
                onRefresh={refreshGame}
                onOpenFiles={fileMgr.open}
              />
            ))
          )}
        </div>
      </div>

      {/* File manager modal */}
      {fileMgr.activeGame && (
        <FileManagerModal
          game={fileMgr.activeGame}
          status={fileMgr.status}
          message={fileMgr.message}
          credentials={fileMgr.credentials}
          onClose={fileMgr.close}
          onStart={fileMgr.start}
          onStop={fileMgr.stop}
        />
      )}
    </>
  );
}

/**
 * Shown when the status poll rejects before any statuses have ever loaded —
 * distinguishes "the fetch failed" from {@link NoGamesCard}'s "you have no
 * games configured yet" so a transient API error can't be mistaken for an
 * empty deployment.
 */
function StatusErrorCard({ error, onRetry }: { error: Error; onRetry: () => Promise<void> }) {
  return (
    <EmptyStateCard
      icon={AlertTriangle}
      tone="error"
      title="Couldn't load game status"
      description={error.message || 'The status request failed.'}
    >
      <Button variant="outline" size="sm" onClick={() => void onRetry()}>
        Retry
      </Button>
    </EmptyStateCard>
  );
}

/** Shown when the API returns no game statuses — guides first-time operators. */
function NoGamesCard() {
  return (
    <EmptyStateCard
      icon={Server}
      title="No games deployed"
      description={
        <>
          Declare a game on the{' '}
          <Link to="/games" className="underline underline-offset-2">
            Games
          </Link>{' '}
          page, then run a plan and apply from{' '}
          <Link to="/iac" className="underline underline-offset-2">
            Infrastructure
          </Link>{' '}
          to create its ECS task definition, EFS volume, and CloudWatch log group.
        </>
      }
    >
      <a
        href="https://codercoco.github.io/Hyveon/setup"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-primary-light)] underline-offset-4 hover:underline"
      >
        Open setup guide
        <ExternalLink className="size-3.5" />
      </a>
      <Link
        to="/games"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-primary-light)] underline-offset-4 hover:underline"
      >
        Add a game
      </Link>
    </EmptyStateCard>
  );
}
