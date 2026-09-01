import { RefreshCw, Menu } from 'lucide-react';
import { cn } from '../lib/utils.utils.js';
import { Button } from '@/components/ui/button.component';
import { isStale, usePollingActions, usePollingState } from '../polling/polling-provider.component.js';
import { useAppRegionStyle } from '../hooks/use-app-region-style.hook.js';
import { TrafficLightSpacer, TitlebarOverlaySpacer, WindowControls } from './window-chrome.component.js';

/**
 * Top-bar Refresh button — triggers every active poller in the registry. The
 * icon spins while at least one poll is in flight so the operator gets a brief
 * loading affordance even if the underlying call returns instantly.
 */
export function RefreshAllButton() {
  const { refreshAll } = usePollingActions();
  const { pollers } = usePollingState();
  const anyLoading = Object.values(pollers).some((p) => p.loading);
  const noDragStyle = useAppRegionStyle('no-drag');
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void refreshAll()}
      aria-label="Refresh all"
      aria-busy={anyLoading}
      disabled={Object.keys(pollers).length === 0}
      style={noDragStyle}
    >
      <RefreshCw className={cn('size-3.5', anyLoading && 'motion-safe:animate-spin')} aria-hidden="true" />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}

/**
 * Top-bar LIVE indicator — pulses cyan while at least one poller has a fresh
 * success, dims gray when every poller is past 2× its interval, and goes
 * neutral when no pollers are registered yet.
 */
export function LiveIndicator() {
  // See PollingIndicator: `now` is the provider's 1Hz heartbeat value, so the
  // staleness comparison below re-evaluates every second without this render
  // reading the clock itself.
  const { pollers, now } = usePollingState();
  const entries = Object.values(pollers);
  const anyFresh = entries.some((p) => p.lastSuccessAt !== null && !isStale(p, now));
  const allStale = entries.length > 0 && entries.every((p) => isStale(p, now));
  const dotClass = anyFresh
    ? 'bg-[var(--color-cyan)] motion-safe:animate-pulse'
    : allStale
      ? 'bg-[var(--color-muted-foreground)]/60'
      : 'bg-[var(--color-muted-foreground)]/40';
  const labelClass = allStale
    ? 'text-[var(--color-muted-foreground)]/60'
    : 'text-muted-foreground';
  const statusLabel = anyFresh ? 'Live — data is current' : allStale ? 'Stale — data may be out of date' : 'Connecting';
  const noDragStyle = useAppRegionStyle('no-drag');
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded border border-border"
      role="status"
      aria-label={statusLabel}
      style={noDragStyle}
    >
      <div className={cn('w-2 h-2 rounded-full', dotClass)} aria-hidden="true" />
      <span className={cn('hidden sm:inline text-xs font-medium', labelClass)} aria-hidden="true">LIVE</span>
    </div>
  );
}

/**
 * Persistent top bar — env pill, mobile hamburger, refresh/live status, and
 * (in Electron) the window's drag region plus title-bar chrome. Sits above
 * the routed page content; the sidebar/drawer nav lives in {@link AppLayout}.
 *
 * @param envLabel - Rendered pill text, e.g. `"PROD · us-east-1"` or `"local"`.
 * @param mobileMenuOpen - Whether the mobile drawer is currently open, for the
 *   hamburger button's `aria-expanded`.
 * @param onOpenMobileMenu - Opens the mobile drawer; wired to the hamburger button.
 */
export function AppTopbar({
  envLabel,
  mobileMenuOpen,
  onOpenMobileMenu,
}: {
  envLabel: string;
  mobileMenuOpen: boolean;
  onOpenMobileMenu: () => void;
}) {
  const dragStyle = useAppRegionStyle('drag');
  const noDragStyle = useAppRegionStyle('no-drag');
  return (
    <header
      className="h-14 border-b border-border bg-card flex items-center justify-between px-4 md:px-6"
      style={dragStyle}
    >
      <div className="flex items-center gap-4">
        <TrafficLightSpacer />

        {/* Hamburger button — only visible on mobile */}
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation"
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-nav"
          style={noDragStyle}
          className="shrink-0 md:hidden min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <Menu className="w-5 h-5" aria-hidden="true" />
        </button>

        <h1 className="hidden sm:block text-lg font-semibold text-foreground shrink-0">Hyveon</h1>
        <span className="inline-flex shrink-0 items-center px-2.5 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
          {envLabel}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <RefreshAllButton />
        <LiveIndicator />

        {/* Avatar placeholder — decorative */}
        <div
          className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center"
          aria-hidden="true"
          style={noDragStyle}
        >
          <span className="text-xs font-medium text-white">OP</span>
        </div>

        <WindowControls />

        <TitlebarOverlaySpacer />
      </div>
    </header>
  );
}
