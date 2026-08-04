import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the settings route (`/settings`). Wraps the Watchdog
 * Configuration panel and any other controls on the page.
 */
export class SettingsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the settings route. */
  async goto(): Promise<void> {
    await this.page.goto('/settings');
  }

  /**
   * The Watchdog Configuration panel's pointer to the General section's
   * "Watchdog tuning" fields — the panel itself is read-only (#348).
   */
  watchdogGeneralPointer(): Locator {
    return this.page.getByText(/configured in the/i);
  }
}
