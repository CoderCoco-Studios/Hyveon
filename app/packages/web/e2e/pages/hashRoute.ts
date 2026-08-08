import type { Page } from '@playwright/test';

/**
 * Navigate directly to a route via URL, targeting `/#${path}` rather than
 * `path` — the app routes via `HashRouter` (see `app.component.tsx`'s doc
 * comment), so a plain path with no hash resolves to the root route instead.
 *
 * @param page - The Playwright page to navigate.
 * @param path - The route path, including its leading slash (e.g. `/games`).
 */
export async function gotoHashRoute(page: Page, path: string): Promise<void> {
  await page.goto(`/#${path}`);
}
