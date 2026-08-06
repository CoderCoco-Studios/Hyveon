import { test, expect, _electron, COST_DATA, MULTI_GAME_COST_DATA, STOPPED_GAME } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
import { CostsPage } from '../pages/index.js';
import type { CostEstimates, GameStatus } from '../fixtures/index.js';

/**
 * Specs for the `/costs` route. Each test launches its own Electron shell,
 * mocks the two IPC channels consumed by the Costs page (`costs.estimate`,
 * `games.status`) via `window.hyveon.__test.mock`, then navigates to `/costs`
 * via history injection (`CostsPage.gotoElectron`).
 *
 * The app makes no AWS Cost Explorer API calls — there is no `costs.actual`
 * channel any more (see `openspec/changes/remove-cost-explorer-calls`).
 *
 * Filter / sort exercises pass `MULTI_GAME_COST_DATA` so the table has more
 * than one row to interact with; the default `COST_DATA` only contains
 * `minecraft`.
 */
test.describe('costs page', () => {
  test('should render the cost analysis heading', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      await expect(costs.heading()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should link out to the AWS Cost Explorer console', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      await expect(costs.costExplorerLink()).toBeVisible();
      await expect(costs.costExplorerLink()).toHaveAttribute(
        'href',
        'https://console.aws.amazon.com/cost-management/home#/cost-explorer',
      );
    } finally {
      await app.close();
    }
  });

  test('should sort estimates by $/hour descending by default', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      const rows = costs.tableRows();
      // Row 0 is the header; rows 1..3 are the games sorted $/hr desc:
      // palworld ($0.32) > valheim ($0.16) > minecraft ($0.08).
      await expect(rows.nth(1)).toContainText('palworld');
      await expect(rows.nth(2)).toContainText('valheim');
      await expect(rows.nth(3)).toContainText('minecraft');
    } finally {
      await app.close();
    }
  });

  test('should re-sort estimates by game name when the Game header is clicked', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();
      await costs.clickSort('Game');

      const rows = costs.tableRows();
      // After clicking Game, default direction is ascending alphabetical.
      await expect(rows.nth(1)).toContainText('minecraft');
      await expect(rows.nth(2)).toContainText('palworld');
      await expect(rows.nth(3)).toContainText('valheim');
    } finally {
      await app.close();
    }
  });

  test('should filter estimates via the search input', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();
      await costs.filter('val');

      await expect(costs.tableCell(/valheim/)).toBeVisible();
      await expect(costs.tableCell(/minecraft/)).toHaveCount(0);
      await expect(costs.tableCell(/palworld/)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
