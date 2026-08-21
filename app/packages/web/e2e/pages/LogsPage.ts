import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/**
 * Page object for the `/logs` route added in CoderCoco/Hyveon#63.
 * Wraps the LIVE/PAUSED pill, the searchable game combobox, the in-stream
 * search input, the autoscroll toggle, the Pause/Resume button, the log
 * box, and the footer line-count summary so spec files read as test logic
 * rather than locator soup.
 */
export class LogsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/logs` directly via URL. */
  async goto(): Promise<void> {
    await gotoHashRoute(this.page, '/logs');
  }

  /**
   * Navigate to `/logs` by clicking the "Game Logs" sidebar link (the child
   * of the `Logs` group, which is itself a non-interactive heading) and
   * waiting for the URL to settle. Use this in Electron e2e specs where the
   * renderer is already at a route and navigation must go through the
   * rendered sidebar rather than a raw `page.goto()` call.
   */
  async gotoViaSidebar(): Promise<void> {
    await this.page.getByRole('link', { name: 'Game Logs' }).click();
    await this.page.waitForURL('**/logs');
  }

  // ── Header ───────────────────────────────────────────────────────────

  /** "Server Logs" heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Server Logs' });
  }

  /**
   * The LIVE/PAUSED status pill. Exact-match prevents the badge from
   * substring-matching incidental words ("Lively", "Alive") inside log
   * lines.
   */
  liveBadge(): Locator {
    return this.page.getByText('Live', { exact: true });
  }

  /** Counterpart to `liveBadge()` — visible while the stream is paused. */
  pausedBadge(): Locator {
    return this.page.getByText('Paused', { exact: true });
  }

  // ── Toolbar ──────────────────────────────────────────────────────────

  /**
   * Game combobox trigger. The `aria-label` always starts with
   * `"Game selector"` so the regex matches regardless of which game is
   * currently selected.
   */
  gameComboboxTrigger(): Locator {
    return this.page.getByRole('button', { name: /^Game selector/ });
  }

  /** Search input rendered inside the combobox popover after it opens. */
  gameSearchInput(): Locator {
    return this.page.getByPlaceholder('Search games…');
  }

  /** Filtered game item inside the open popover, by game name. */
  gameOption(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  /**
   * Open the combobox, type into the search filter, and click the
   * matching game option. The trigger collapses on selection.
   */
  async selectGame(name: string): Promise<void> {
    await this.gameComboboxTrigger().click();
    await this.gameSearchInput().fill(name);
    await this.gameOption(name).click();
  }

  /** In-stream search input that highlights matches in the visible buffer. */
  searchInput(): Locator {
    return this.page.getByPlaceholder('Search visible buffer…');
  }

  /** Type into the in-stream search input and let React re-render highlights. */
  async search(query: string): Promise<void> {
    await this.searchInput().fill(query);
  }

  /** Autoscroll checkbox — wrapped in a `<label>` with text "Autoscroll". */
  autoscrollCheckbox(): Locator {
    return this.page.getByLabel('Autoscroll');
  }

  /** Pause/Resume button. The accessible name flips with the state. */
  pauseButton(): Locator {
    return this.page.getByRole('button', { name: 'Pause' });
  }

  /** Counterpart to `pauseButton()` — visible while the stream is paused. */
  resumeButton(): Locator {
    return this.page.getByRole('button', { name: 'Resume' });
  }

  // ── Log stream ───────────────────────────────────────────────────────

  /**
   * A `<mark>` highlight rendered by the in-stream search. Without a
   * search query active the page contains zero `<mark>` elements, so this
   * is a stable signal for "search-highlighting is working".
   */
  highlightMarks(): Locator {
    return this.page.locator('mark');
  }

  /** A specific search highlight by exact matched text. */
  highlightMark(text: string): Locator {
    return this.page.locator('mark', { hasText: text });
  }

  // ── Footer ───────────────────────────────────────────────────────────

  /**
   * Footer summary line — `<N> lines · oldest <age>` plus an optional
   * "buffered N" suffix. `count` anchors the regex to the start so
   * unrelated `5` substrings elsewhere don't match.
   */
  footerLineCount(count: number): Locator {
    return this.page.getByText(new RegExp(`^${count} lines? · oldest `));
  }
}
