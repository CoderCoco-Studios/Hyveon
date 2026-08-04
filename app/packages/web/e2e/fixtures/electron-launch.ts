/**
 * Reusable helpers for the Playwright `electron` project.
 *
 * Provides two exports:
 *
 * - `launchElectron()` — launches the packaged Electron app via
 *   `_electron.launch()` using the `electronMain` / `electronEnv` values
 *   from the playwright config, and returns `{ app, win }` where `win` is the
 *   first-opened `Page`.
 *
 * - `applyHyveonMocks(win, opts)` — seeds `window.hyveon.__test.mock()` for every
 *   IPC channel the dashboard and its shared provider stack consume, using the
 *   same `StubOptions` shape and `game-data` fixture constants that the
 *   Chromium tier uses for `page.route()` stubs. Designed to be called inside
 *   a `beforeEach` or at the top of a test body, before navigating to a page.
 */

import type { Page } from '@playwright/test';
import { _electron } from '@playwright/test';
import { electronMain, electronEnv } from '../../playwright.config.js';
import type { StubOptions } from './index.js';
import {
  ENV_DATA,
  STOPPED_GAME,
  COST_DATA,
  CONFIGURED_DISCORD_CONFIG,
  makeActualCosts,
} from './game-data.js';
import type {
  GameStatus,
  ActionResult,
  CostEstimates,
  ActualCosts,
  EnvInfo,
  DiscordConfigRedacted,
} from './index.js';
import type { ElectronApplication } from 'playwright-core';

// ---------------------------------------------------------------------------
// launchElectron
// ---------------------------------------------------------------------------

/** Return value of {@link launchElectron}. */
export interface ElectronHandle {
  /** The `ElectronApplication` instance — close it in the test's `finally` block. */
  app: ElectronApplication;
  /** The first opened `Page` (the renderer window). */
  win: Page;
}

/**
 * Launches the packaged Electron app and waits for the first `BrowserWindow`.
 *
 * Uses the `electronMain` entry-point and `electronEnv` (which includes
 * `HYVEON_TEST_MODE=1`) exported from the playwright config, so all Electron
 * e2e specs go through the same launch configuration without duplicating it.
 *
 * @example
 * ```ts
 * test('should show the dashboard', async () => {
 *   const { app, win } = await launchElectron();
 *   try {
 *     await applyHyveonMocks(win, { statuses: [RUNNING_GAME] });
 *     await win.goto('/');
 *     // ...assertions...
 *   } finally {
 *     await app.close();
 *   }
 * });
 * ```
 */
export async function launchElectron(): Promise<ElectronHandle> {
  const app = await _electron.launch({ args: [electronMain], env: electronEnv });
  const win = await app.firstWindow();
  return { app, win };
}

// ---------------------------------------------------------------------------
// applyHyveonMocks
// ---------------------------------------------------------------------------

/**
 * Seeds `window.hyveon.__test.mock()` for every IPC channel the dashboard and
 * its shared provider stack call at startup.
 *
 * Mirrors the defaults and per-spec overrides of `stubApis` so the same
 * `StubOptions` vocabulary works for both the Chromium and Electron tiers.
 * Must be called **before** the renderer navigates to the page under test
 * (i.e. before `win.goto()`), because the preload consults the mock registry
 * on each `invoke()` call.
 *
 * The following channels are mocked:
 * - `env.get`         → `EnvInfo`
 * - `games.status`    → `GameStatus[]`
 * - `games.list`      → `{ games: string[] }`
 * - `costs.estimate`  → `CostEstimates`
 * - `costs.actual`    → `ActualCosts` (receives the `days` argument)
 * - `games.start`     → `ActionResult`
 * - `games.stop`      → `ActionResult`
 * - `discord.getConfig` → `DiscordConfigRedacted`
 *
 * @param win  - The Playwright `Page` for the Electron renderer window.
 * @param opts - Per-spec overrides; uses the same defaults as `stubApis`.
 */
export async function applyHyveonMocks(win: Page, opts: StubOptions = {}): Promise<void> {
  const statuses: GameStatus[] = opts.statuses ?? [STOPPED_GAME];
  const costs: CostEstimates = opts.costs ?? COST_DATA;
  const env: EnvInfo = opts.env ?? ENV_DATA;
  const startResult: ActionResult = opts.startResult ?? { success: true, message: 'Started' };
  const discord: DiscordConfigRedacted = opts.discord ?? CONFIGURED_DISCORD_CONFIG;
  // `opts.games` (shared with the chromium-tier `stubApis`) may hold plain
  // names or full `GameListEntry` objects; this mock's `games.list` handler
  // always resolves `{ games: string[] }` (see the doc comment above), so
  // normalise either shape down to names.
  const games: string[] = (opts.games ?? statuses.map((s) => s.game)).map((g) =>
    typeof g === 'string' ? g : g.name,
  );
  const actualCostsFn: (days: number) => ActualCosts =
    typeof opts.actualCosts === 'function'
      ? opts.actualCosts
      : opts.actualCosts !== undefined
        ? () => opts.actualCosts as ActualCosts
        : (days) => makeActualCosts(days);

  // Playwright serialises the `evaluate` callback to source and re-evaluates
  // it in the browser context, so we snapshot all values into plain objects
  // and pass them as a single serialisable argument.
  await win.evaluate(
    ({
      envData,
      statusList,
      gameList,
      costEstimates,
      startRes,
      discordConfig,
      actualCostsMap,
    }: {
      envData: EnvInfo;
      statusList: GameStatus[];
      gameList: string[];
      costEstimates: CostEstimates;
      startRes: ActionResult;
      discordConfig: DiscordConfigRedacted;
      actualCostsMap: Record<string, ActualCosts>;
    }) => {
      const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      hyveon.__test.mock('env.get', () => Promise.resolve(envData));
      hyveon.__test.mock('games.status', () => Promise.resolve(statusList));
      hyveon.__test.mock('games.list', () => Promise.resolve({ games: gameList }));
      hyveon.__test.mock('costs.estimate', () => Promise.resolve(costEstimates));
      hyveon.__test.mock('costs.actual', (days: unknown) => {
        const d = typeof days === 'number' ? days : 7;
        const key = String(d);
        return Promise.resolve(actualCostsMap[key] ?? actualCostsMap['7']);
      });
      hyveon.__test.mock('games.start', () => Promise.resolve(startRes));
      hyveon.__test.mock('games.stop', () => Promise.resolve({ success: true, message: 'Stopped' }));
      hyveon.__test.mock('discord.getConfig', () => Promise.resolve(discordConfig));
    },
    {
      envData: env,
      statusList: statuses,
      gameList: games,
      costEstimates: costs,
      startRes: startResult,
      discordConfig: discord,
      // Pre-compute the costs.actual responses for the query windows the Costs
      // page uses (7 and 14 days) so the callback in the browser can do a
      // synchronous map lookup without calling back into Node.
      actualCostsMap: { '7': actualCostsFn(7), '14': actualCostsFn(14) },
    },
  );
}
