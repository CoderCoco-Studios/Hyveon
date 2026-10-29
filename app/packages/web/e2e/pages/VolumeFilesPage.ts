import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/** Session badge labels rendered by `SessionBar`. */
export type SessionStateLabel = 'Stopped' | 'Starting' | 'Running' | 'Stopping' | 'Orphaned' | 'Failed' | 'Not deployed';

/**
 * Page object for a game's file browser route (`/games/:name/files`). Wraps the session bar, the volume listing, the
 * breadcrumb and the toolbar so spec files read as test logic rather than locator soup.
 */
export class VolumeFilesPage {
  constructor(public readonly page: Page) {}

  /** Navigate to a game's file browser route. */
  async goto(game: string): Promise<void> {
    await gotoHashRoute(this.page, `/games/${game}/files`);
  }

  /**
   * Show a game's file browser inside the Electron shell. The packaged app loads from `file://`, so this sets
   * `location.hash` in two steps — resetting to `/` first guarantees a `hashchange` fires (see `e2e/pages/index.ts`).
   */
  async gotoElectron(game: string): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '/';
    });
    await this.page.evaluate((target) => {
      window.location.hash = `/games/${target}/files`;
    }, game);
  }

  // ── Session bar ──────────────────────────────────────────────────────

  /** The session state badge for `label`. */
  sessionState(label: SessionStateLabel): Locator {
    return this.page.getByText(label, { exact: true });
  }

  /** Session "Start" button, shown while the session is stopped or failed. */
  startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start', exact: true });
  }

  /** Session "Stop" button, shown while the session runs. */
  stopButton(): Locator {
    return this.page.getByRole('button', { name: 'Stop', exact: true });
  }

  /** Session "Restart" button, shown for an orphaned session. */
  restartButton(): Locator {
    return this.page.getByRole('button', { name: 'Restart', exact: true });
  }

  // ── Listing ──────────────────────────────────────────────────────────

  /** The table row for the entry called `name`. */
  row(name: string): Locator {
    return this.page.getByRole('row').filter({ has: this.page.getByText(name, { exact: true }) });
  }

  /** Opens the folder called `name` in the current directory. */
  async openFolder(name: string): Promise<void> {
    await this.row(name).getByRole('button', { name, exact: true }).click();
  }

  /** The path trail from the volume root to the current directory. */
  breadcrumb(): Locator {
    return this.page.getByRole('navigation', { name: 'Breadcrumb' });
  }

  // ── Toolbar and server guard ─────────────────────────────────────────

  /** "New folder" toolbar button. */
  newFolderButton(): Locator {
    return this.page.getByRole('button', { name: 'New folder' });
  }

  /** "Upload files" toolbar button. */
  uploadFilesButton(): Locator {
    return this.page.getByRole('button', { name: 'Upload files' });
  }

  /** Banner explaining that changes are disabled because the game server is running. */
  readOnlyBanner(): Locator {
    return this.page.getByRole('status').filter({ hasText: 'The server is running. Stop it to change files.' });
  }

  // ── Rendered-output audit ────────────────────────────────────────────

  /** Any link or media element in the page content that targets an `http(s)://` URL. */
  externalTargets(): Locator {
    return this.page.getByRole('main').locator('[href^="http" i], [src^="http" i], [action^="http" i]');
  }

  /**
   * Everything the page content shows or exposes to assistive tech: the text of the `main` region plus the `href`,
   * `src`, `title`, `aria-label`, `alt`, `placeholder` and `value` attribute of every element inside it.
   *
   * @returns The text first, then each attribute value found.
   */
  async renderedStrings(): Promise<string[]> {
    return this.page.getByRole('main').evaluate((main) => {
      const attributes = ['href', 'src', 'title', 'aria-label', 'alt', 'placeholder', 'value'];
      const values = [main.textContent ?? ''];
      for (const element of [main, ...main.querySelectorAll('*')]) {
        for (const name of attributes) {
          const value = element.getAttribute(name);
          if (value) values.push(value);
        }
      }
      return values;
    });
  }
}
