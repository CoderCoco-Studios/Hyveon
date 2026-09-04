import type { Page, Locator } from '@playwright/test';

/** Status-badge labels rendered by `GameCard`. */
export type ServerStateLabel =
  | 'RUNNING'
  | 'STARTING'
  | 'STOPPED'
  | 'NOT DEPLOYED'
  | 'ERROR';

/**
 * Page object for the dashboard route (`/`). Wraps the KPI strip, the search
 * filter, the GameCard grid, and the per-card action buttons so spec files
 * read as test logic rather than locator soup.
 */
export class DashboardPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the dashboard root. */
  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  /**
   * Show the dashboard inside the Electron shell. Sets `location.hash` to
   * `/` — a same-value set fires no `hashchange`, so `HashRouter` would not
   * re-render (see `e2e/pages/index.ts`) — then clicks "Refresh all", since
   * the app-level status poller fires once at launch, before the test
   * registers its IPC mocks, so the grid must be re-fetched for the seeded
   * `games.status` mock to take effect.
   *
   * Call after `applyHyveonMocks()` so the mocks are in place before the refresh.
   */
  async gotoElectron(): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '/';
    });
    // Wait for the launch-time status poll to settle before refreshing. While
    // a poll is in flight the registry's `inFlight` guard would silently drop
    // a `refreshAll()`, so the seeded mock would never be re-fetched. The
    // top-bar button mirrors that state via `aria-busy`, so it's a reliable
    // "the poller is idle" signal to gate the click on.
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('button[aria-label="Refresh all"]');
      return btn !== null && !btn.hasAttribute('disabled') && btn.getAttribute('aria-busy') === 'false';
    });
    await this.page.getByRole('button', { name: 'Refresh all' }).click();
  }

  // ── GameCard grid ────────────────────────────────────────────────────

  /** `<h3>` element inside a card whose game name matches `name`. */
  gameCardHeading(name: string): Locator {
    return this.page.getByRole('heading', { name });
  }

  /** Status badge by its rendered text label (RUNNING / STOPPED / etc.). */
  statusBadge(state: ServerStateLabel): Locator {
    // exact: true prevents CSS-uppercase KPI labels ("SERVERS RUNNING") from
    // substring-matching when Playwright evaluates innerText.
    return this.page.getByText(state, { exact: true });
  }

  /**
   * Error-reason text rendered on a game card in the `error` state, keyed
   * off the `data-testid="game-card-error-{name}"` hook
   * `GameCard` renders alongside the message so it can be located without
   * depending on the message's actual wording.
   *
   * @param name - the game's name, matching {@link gameCardHeading}.
   * @returns a locator for that card's error-message row.
   */
  gameCardErrorMessage(name: string): Locator {
    return this.page.getByTestId(`game-card-error-${name}`);
  }

  /** Empty-state card heading shown when no games are deployed. */
  emptyConfiguredMessage(): Locator {
    return this.page.getByRole('heading', { name: /no games deployed/i });
  }

  /** "Open setup guide" CTA link inside the no-games card. */
  setupGuideLink(): Locator {
    return this.page.getByRole('link', { name: /open setup guide/i });
  }

  /** "Add a game" CTA link inside the no-games card, routing to `/games`. */
  addGameLink(): Locator {
    return this.page.getByRole('link', { name: /add a game/i });
  }

  /** Empty-state when the search input filters out every card. */
  emptySearchMessage(): Locator {
    return this.page.getByText(/no games match/i);
  }

  // ── Card action buttons ──────────────────────────────────────────────

  /** IP address / hostname text rendered on a running game card. */
  gameIpAddress(hostname: string): Locator {
    return this.page.getByText(hostname);
  }

  /** Primary CTA shown on a stopped/not-deployed/error card. */
  startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start' });
  }

  /** Primary CTA shown on a running/starting card. */
  stopButton(): Locator {
    return this.page.getByRole('button', { name: 'Stop' });
  }

  /** Confirmation button inside the stop-confirmation dialog. */
  confirmStopButton(): Locator {
    return this.page.getByRole('button', { name: /stop server/i });
  }

  // ── Search filter ────────────────────────────────────────────────────

  /** Search input above the grid that filters by game name or hostname. */
  searchInput(): Locator {
    return this.page.getByLabel('Filter games');
  }

  /** Type into the search input and let React rerender the filtered grid. */
  async filter(query: string): Promise<void> {
    await this.searchInput().fill(query);
  }

  // ── Pending changes banner ──────────────────────────────

  /** The `PendingChangesBanner` container (`role="status"`), when it's visible. */
  pendingChangesBanner(): Locator {
    return this.page.getByRole('status').filter({ hasText: 'Configuration changed' });
  }

  /** "View pending" link inside the banner, which routes to `/games`. */
  viewPendingLink(): Locator {
    return this.pendingChangesBanner().getByRole('link', { name: 'View pending' });
  }

  /** Dismiss ("X") button inside the banner. */
  dismissBannerButton(): Locator {
    return this.page.getByRole('button', { name: 'Dismiss pending changes banner' });
  }

  // ── KPI strip ────────────────────────────────────────────────────────

  /** A KPI tile by its label ('Servers running', 'Current run rate', etc.). */
  kpiTileLabel(label: string): Locator {
    return this.page.getByText(label);
  }

  /** The "Servers running" KPI value (e.g. "1/2"). */
  serversRunningValue(value: string): Locator {
    return this.page.getByText(value, { exact: true });
  }
}
