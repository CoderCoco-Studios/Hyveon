import { test, expect, stubApis } from '../fixtures/index.js';

test.describe('settings', () => {
  test('should show the Watchdog Configuration panel pointing at the General section, with no Save button', async ({
    settings,
  }) => {
    await stubApis(settings.page, {});
    await settings.goto();

    await expect(settings.watchdogGeneralPointer()).toBeVisible();
    // Exact match: the General section below has its own "Save settings"
    // button, which must stay untouched by this assertion.
    await expect(settings.page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  });
});
