import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the persistent navigation shell rendered by `AppLayout.tsx`
 * (sidebar + top bar). Encapsulates locators that are shared across every
 * route so individual specs don't reach into the layout chrome.
 */
export class AppLayout {
  constructor(public readonly page: Page) {}

  /** Top-bar product heading — used as a "the dashboard mounted" smoke check. */
  brandHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Hyveon' });
  }

  /** The top bar itself — doubles as the app's draggable custom title bar. */
  header(): Locator {
    return this.page.getByRole('banner');
  }

  /** Linux-only app-drawn window-control button, by its accessible name (Minimize/Maximize/Restore/Close). */
  windowControlButton(name: 'Minimize' | 'Maximize' | 'Restore' | 'Close'): Locator {
    return this.page.getByRole('button', { name });
  }

  /** Sidebar nav link by visible label (e.g. "Logs", "Discord", "Settings"). */
  sidebarLink(label: string): Locator {
    return this.page.getByRole('link', { name: label });
  }

  /**
   * Click a sidebar nav link and wait for the route to change to `expectedPath`.
   *
   * Matches on `url.hash`, not `url.pathname`: the app routes via
   * `HashRouter` (see `app.component.tsx`'s doc comment — `BrowserRouter`
   * breaks under the packaged renderer's `file://` origin on Windows, where
   * the drive letter in the path defeats absolute-path route matching), so
   * the active route lives after the `#` on both the chromium tier
   * (`http://localhost:4173/#/logs`) and the Electron tier
   * (`file:///.../index.html#/logs`) — `url.pathname` is just the static
   * served file/index path in both cases and never changes between routes.
   */
  async navigateTo(label: string, expectedPath: string): Promise<void> {
    await this.sidebarLink(label).click();
    await this.page.waitForURL((url) => url.hash === `#${expectedPath}`);
  }

  /** Main heading rendered by the Logs page (`/logs`). */
  logsPageHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Server Logs' });
  }

  /** A visible Sonner toast matched by its message text. */
  toastMessage(text: string | RegExp): import('@playwright/test').Locator {
    return this.page.locator('[data-sonner-toast]').filter({ hasText: text });
  }

  /** The Undo action button inside a Sonner toast. */
  toastUndoButton(): import('@playwright/test').Locator {
    return this.page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' });
  }
}
