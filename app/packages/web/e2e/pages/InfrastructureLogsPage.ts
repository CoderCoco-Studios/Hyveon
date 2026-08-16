import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/** Page object for the `/logs/infrastructure` route (Lambda log viewer). */
export class InfrastructureLogsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/logs/infrastructure` directly via URL. */
  async goto(): Promise<void> {
    await gotoHashRoute(this.page, '/logs/infrastructure');
  }

  /** "Infrastructure Logs" heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Infrastructure Logs' });
  }

  /** Function picker button by `LambdaFunctionKey`, e.g. `'watchdog'`, `'health-check'`. */
  functionButton(functionKey: string): Locator {
    return this.page.getByRole('button', { name: functionKey, exact: true });
  }

  /** Click the function picker button for `functionKey`. */
  async selectFunction(functionKey: string): Promise<void> {
    await this.functionButton(functionKey).click();
  }
}
