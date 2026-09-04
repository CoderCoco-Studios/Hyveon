import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/**
 * Page object for the settings route (`/settings`). Wraps the Watchdog
 * Configuration panel and any other controls on the page.
 */
export class SettingsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the settings route. */
  async goto(): Promise<void> {
    await gotoHashRoute(this.page, '/settings');
  }

  /**
   * The Watchdog Configuration panel's pointer to the General section's
   * "Watchdog tuning" fields — the panel itself is read-only.
   */
  watchdogGeneralPointer(): Locator {
    return this.page.getByText(/configured in the/i);
  }
}
