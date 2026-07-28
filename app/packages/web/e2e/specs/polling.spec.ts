import { test, expect, stubApis, STOPPED_GAME } from '../fixtures/index.js';

/**
 * Specs for the polling indicator + top-bar Refresh introduced in #65. The
 * shared {@link PollingProvider} runs the status poll above the router, so
 * every primary route should display "Updated …" and the top-bar Refresh
 * button should trigger a fresh `/api/status` call on demand.
 */

test.describe('polling indicator', () => {
  test('should render the "Updated …" label on the dashboard', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await expect(dashboard.page.getByText(/updated\s+\S+\s+ago/i).first()).toBeVisible();
  });

  test('should keep the indicator visible after navigating to /logs', async ({ dashboard, layout }) => {
    // Use an empty statuses list so the GameCard's per-card Logs link doesn't
    // collide with the sidebar's "Logs" nav link (Playwright strict mode).
    await stubApis(dashboard.page, { statuses: [] });
    await dashboard.goto();
    await expect(dashboard.page.getByText(/updated\s+\S+\s+ago/i).first()).toBeVisible();

    await layout.navigateTo('Logs', '/logs');
    await expect(dashboard.page.getByText(/updated\s+\S+\s+ago/i).first()).toBeVisible();
  });

  test('should keep the indicator visible after navigating to /discord', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await layout.navigateTo('Discord', '/discord');
    await expect(dashboard.page.getByText(/updated\s+\S+\s+ago/i).first()).toBeVisible();
  });

  test('should keep the indicator visible after navigating to /settings', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await layout.navigateTo('Settings', '/settings');
    await expect(dashboard.page.getByText(/updated\s+\S+\s+ago/i).first()).toBeVisible();
  });

  test('should navigate to /costs via the sidebar Costs link', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await layout.navigateTo('Costs', '/costs');
    await expect(dashboard.page.getByRole('heading', { name: 'Cost Analysis' })).toBeVisible();
  });
});

test.describe('top-bar refresh', () => {
  test('should re-fetch /api/status when the Refresh button is clicked', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });

    // stubApis already registered a catch-all for /api/status; this later
    // registration wins (Playwright matches routes in REVERSE order) and lets
    // us count GETs against the endpoint.
    let statusGetCount = 0;
    await dashboard.page.route('**/api/status', (route) => {
      if (route.request().method() === 'GET') statusGetCount += 1;
      return route.fulfill({ json: [STOPPED_GAME] });
    });

    await dashboard.goto();
    // Wait for the initial mount + first poll to settle so we can compare.
    await expect(dashboard.statusBadge('STOPPED')).toBeVisible();
    const before = statusGetCount;

    await dashboard.page.getByRole('button', { name: 'Refresh all' }).click();

    await expect.poll(() => statusGetCount).toBeGreaterThan(before);
  });
});
