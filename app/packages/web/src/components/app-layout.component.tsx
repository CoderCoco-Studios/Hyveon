import { ReactNode, useEffect, useState, type CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type EnvInfo } from '../api.service.js';
import { cn } from '../lib/utils.utils.js';
import { NavSections } from './app-nav.component.js';
import { AppTopbar } from './app-topbar.component.js';
import { Server, X } from 'lucide-react';

/**
 * Navigation shell — persistent sidebar + top bar that wraps all routed pages.
 * Sidebar shows "Monitoring" and "Configuration" sections with active-route
 * highlighting (purple gradient + 2px left accent). Top bar displays env pill
 * (e.g. "PROD · us-east-1"), Refresh, and LIVE indicator.
 *
 * On mobile (below the `md` breakpoint), the sidebar is replaced by an off-canvas drawer that slides
 * in from the left when the hamburger button in the top bar is clicked.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [env, setEnv] = useState<EnvInfo | null>(null);
  // The mobile drawer stores *which route it was opened on* rather than a
  // bare boolean, so "close whenever the route changes (e.g. browser
  // back/forward)" falls out of a render-time comparison instead of needing
  // an effect that calls setState on every navigation.
  const [menuOpenForPath, setMenuOpenForPath] = useState<string | null>(null);
  const mobileMenuOpen = menuOpenForPath === location.pathname;

  useEffect(() => {
    api.env().then(setEnv).catch(console.error);
  }, []);

  const envLabel = env
    ? `${env.environment} · ${env.region}`
    : 'local';

  const openMobileMenu = () => setMenuOpenForPath(location.pathname);
  const closeMobileMenu = () => setMenuOpenForPath(null);

  return (
    <div className="flex h-screen bg-background">
      {/* Skip-to-content link — first focusable element, revealed on focus.
          Explicitly excluded from the macOS drag region: it renders `fixed`
          at top-4/left-4, inside the sidebar brand block's drag area below,
          and Electron's app-region hit-testing is purely rectangle-based
          (not DOM nesting or z-index aware) — without `no-drag` here, a
          sighted keyboard user who tabs to reveal this link and clicks it
          drags the window instead of activating it. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-card focus:text-foreground focus:rounded-[var(--radius-md)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        Skip to main content
      </a>

      {/* Desktop sidebar — hidden on mobile */}
      <aside className="hidden md:flex w-60 border-r border-border bg-card flex-col">
        {/*
          Brand block. macOS's traffic lights render inside the header, not
          here (see `platformWindowChromeOptions()` in `electron-entry.ts` —
          `trafficLightPosition` is offset past the sidebar's 240px width so
          the buttons land in the header). This block is still the window's
          actual top-left corner, though, so it stays a drag region as a grab
          handle near that corner even though nothing is drawn on top of it —
          without this, macOS users couldn't drag the window from here.
          Windows/Linux don't need it, so this is scoped to darwin only.
        */}
        <div
          className="px-4 py-5 border-b border-border"
          data-testid="sidebar-brand-block"
          style={
            window.hyveon?.window && window.hyveon.window.platform === 'darwin'
              ? ({ WebkitAppRegion: 'drag' } as CSSProperties)
              : undefined
          }
        >
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center" aria-hidden="true">
              <Server className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-foreground">Game Servers</span>
          </div>
        </div>

        <NavSections currentPath={location.pathname} prefix="desktop" />
      </aside>

      {/* Mobile drawer backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={closeMobileMenu}
          aria-hidden="true"
        />
      )}

      {/* Mobile off-canvas drawer — always in DOM so aria-controls="mobile-nav" has a valid target */}
      <aside
        id="mobile-nav"
        aria-hidden={!mobileMenuOpen}
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-60 bg-card border-r border-border flex flex-col md:hidden',
          !mobileMenuOpen && 'hidden',
        )}
      >
          {/* Drawer header with close button */}
          <div className="px-4 py-5 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center" aria-hidden="true">
                <Server className="w-5 h-5 text-white" />
              </div>
              <span className="font-semibold text-foreground">Game Servers</span>
            </div>
            <button
              type="button"
              onClick={closeMobileMenu}
              aria-label="Close navigation"
              className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>

          <NavSections currentPath={location.pathname} onNavigate={closeMobileMenu} prefix="mobile" />
        </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <AppTopbar envLabel={envLabel} mobileMenuOpen={mobileMenuOpen} onOpenMobileMenu={openMobileMenu} />

        <main id="main" tabIndex={-1} className="flex-1 overflow-auto p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

// Re-exported for backward compatibility: `app-layout.component.test.tsx`
// and other consumers import these directly from this module's old location.
export { RefreshAllButton, LiveIndicator } from './app-topbar.component.js';
