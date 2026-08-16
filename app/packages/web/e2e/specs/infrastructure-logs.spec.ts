import { test, expect, stubApis } from '../fixtures/index.js';

/**
 * `/logs/infrastructure` route specs (chromium project). Stub-based, mirroring
 * the pattern used by `games.spec.ts` and `settings.spec.ts`: `/api/*` is
 * stubbed over HTTP via `stubApis`, and `window.hyveon.logs.lambda` is
 * overridden via the same `addInitScript` merge that already backs
 * `window.hyveon.logs` for the Games logs page.
 *
 * The nested Logs sidebar group's child links are labelled `Game Logs` and
 * `Infra Logs` (not `Games`/`Infrastructure`) specifically to avoid colliding
 * with the accessible names of the pre-existing top-level Configuration
 * section's `Games` (`/games`) and `Infrastructure` (`/iac`) links — see
 * `openspec/changes/add-infra-log-viewer/design.md` D3.
 */
test.describe('infrastructure logs page', () => {
  test('should render Game Logs and Infra Logs links in the nested Logs sidebar group', async ({ page, layout }) => {
    await stubApis(page);
    await page.goto('/');

    await expect(layout.sidebarLink('Game Logs')).toBeVisible();
    await expect(layout.sidebarLink('Infra Logs')).toBeVisible();
  });

  test('should show the function picker and seeded logs on navigation', async ({ page, infraLogs }) => {
    await stubApis(page, { lambdaLogLines: { watchdog: ['watchdog seeded line'] } });
    await infraLogs.goto();

    await expect(infraLogs.heading()).toBeVisible();
    await expect(page.getByText('watchdog seeded line')).toBeVisible();
  });

  test('should show a different function\'s seeded lines after switching', async ({ page, infraLogs }) => {
    await stubApis(page, {
      lambdaLogLines: { watchdog: ['watchdog line'], 'health-check': ['health-check line'] },
    });
    await infraLogs.goto();

    await expect(page.getByText('watchdog line')).toBeVisible();

    await infraLogs.selectFunction('health-check');

    await expect(page.getByText('health-check line')).toBeVisible();
    // Switching functions resets the stream — the previous function's seeded
    // line must be gone, not just hidden.
    await expect(page.getByText('watchdog line')).not.toBeVisible();
  });
});
