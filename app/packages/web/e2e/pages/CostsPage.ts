import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/**
 * Page object for the `/costs` route. Wraps the per-game estimates table and
 * the AWS Cost Explorer link-out callout so spec files read as test logic
 * rather than locator soup.
 */
export class CostsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/costs` directly (the route isn't yet linked from the sidebar). */
  async goto(): Promise<void> {
    await gotoHashRoute(this.page, '/costs');
  }

  /**
   * Navigate to `/costs` inside the Electron shell where `page.goto()` cannot
   * change the React Router route. Resets to `/` first, then sets
   * `location.hash` to `/costs` — a single assignment straight to `/costs`
   * would silently no-op if the app is already on that route, since setting
   * `location.hash` to its current value fires neither `hashchange` nor
   * `popstate`, and `HashRouter` only re-renders on those events (mirrors
   * `DiscordPage.goto()`'s two-step reset for the same reason).
   *
   * TODO(#190): replace with a sidebar navigation click once the Costs link is
   * wired into the sidebar in the Electron project.
   */
  async gotoElectron(): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '/';
    });
    await this.page.evaluate(() => {
      window.location.hash = '/costs';
    });
    await this.heading().waitFor();
  }

  // ── Headline ─────────────────────────────────────────────────────────

  /** "Cost Analysis" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Cost Analysis' });
  }

  /** "Open AWS Cost Explorer" link-out to the real AWS console. */
  costExplorerLink(): Locator {
    return this.page.getByRole('link', { name: /Open AWS Cost Explorer/i });
  }

  // ── Estimates table ──────────────────────────────────────────────────

  /** All `<tr>` rows including the header — index 0 is the header, 1.. are games. */
  tableRows(): Locator {
    return this.page.getByRole('row');
  }

  /**
   * A `<td>` or `<th>` cell whose accessible name matches `name` (string or
   * regex). Pass a `RegExp` for partial matches, e.g. `/valheim/`.
   */
  tableCell(name: string | RegExp): Locator {
    return this.page.getByRole('cell', { name });
  }

  /** Sortable column header button by its visible label (`Game`, `vCPU`, `$/hour`, etc.). */
  sortHeader(label: string): Locator {
    const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return this.page.getByRole('button', { name: new RegExp(`^${escaped}`) });
  }

  /** Click a sort header to toggle the active column / direction. */
  async clickSort(label: string): Promise<void> {
    await this.sortHeader(label).click();
  }

  /** Search input above the table that filters rows by game name. */
  filterInput(): Locator {
    return this.page.getByPlaceholder('Filter games…');
  }

  /** Type into the search input and let React rerender the filtered table. */
  async filter(query: string): Promise<void> {
    await this.filterInput().fill(query);
  }

  /** "No estimates match…" message shown when a filter query matches zero rows. */
  noMatchesMessage(): Locator {
    return this.page.getByText(/No estimates match/);
  }
}
