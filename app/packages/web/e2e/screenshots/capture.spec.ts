/**
 * Docs-site screenshot harness — captures the REAL packaged Electron app
 * (`out/main/index.js`, built by `desktop:build`) at a fixed 1200×800 size
 * with a frozen clock and animations disabled, writing PNGs to
 * `docs/static/img/app/`. Run via `npm run docs:screenshots` from the repo
 * root (chains `desktop:build` first — this spec does not build anything
 * itself).
 *
 * Each test launches its own `ElectronApplication` (see `launchSeeded`
 * below) rather than sharing one across the file: mock registration timing
 * matters (several IPC channels are read exactly once, synchronously, above
 * the router or before the first-run wizard's gate resolves — see
 * `demo-data.ts`'s `seedDemo`/`seedWizard` TSDoc), and a fresh launch per
 * test is the simplest way to guarantee zero mock bleed between shots
 * without reasoning about `addInitScript` stacking order.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright-core';
import { launchElectron } from '../fixtures/index.js';
import { GamesPage, IacHistoryPage, IacPage } from '../pages/index.js';
import { DEMO_LOG_STREAM_LINES, DEMO_NOW, seedDemo, seedWizard } from './demo-data.js';

/** Repo root, five directories above this file (`app/packages/web/e2e/screenshots/`). */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Fixed output directory — filenames here are a contract with the docs site; do not rename. */
const SCREENSHOT_DIR = join(REPO_ROOT, 'docs', 'static', 'img', 'app');

/** Matches `electron-entry.ts`'s default `BrowserWindow` size. */
const VIEWPORT = { width: 1200, height: 800 };

/** Every screenshot is captured with the clock frozen here — keep in sync with `demo-data.ts`'s `DEMO_NOW`. */
const FROZEN_TIME = new Date(DEMO_NOW);

test.beforeAll(() => {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

/**
 * Launches a fresh packaged Electron app, sizes its window to
 * {@link VIEWPORT}, freezes the clock to {@link FROZEN_TIME}, runs `seed`
 * (expected to call `seedDemo`/`seedWizard`, which register mocks via
 * `win.addInitScript` rather than `win.evaluate` — see their TSDoc), then
 * reloads the same `file://` URL so those mocks are in place *before* the
 * renderer's bundle mounts. `win.reload()` throws `net::ERR_ABORTED` on a
 * `file://` origin, so the reload is a same-URL `goto` instead.
 */
async function launchSeeded(seed: (win: Page) => Promise<void>): Promise<{ app: ElectronApplication; win: Page }> {
  const { app, win } = await launchElectron();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, VIEWPORT);
  await win.clock.install({ time: FROZEN_TIME });
  await seed(win);
  await win.goto(win.url(), { waitUntil: 'domcontentloaded' });
  return { app, win };
}

/**
 * Navigates the mounted SPA to `path` via `location.hash` (see
 * `e2e/pages/index.ts`), used for every top-level target route instead of
 * `AppLayout.navigateTo`'s sidebar-link click: on the dashboard, each
 * `GameCard` renders a "View logs for \{game\}" / etc. link whose accessible
 * name contains the sidebar item's label as a substring (Playwright's
 * `getByRole(..., { name })` matches substrings by default), so a sidebar
 * click from the dashboard is a real, intermittent strict-mode collision —
 * observed directly while stabilising this spec.
 */
async function gotoRoute(win: Page, path: string): Promise<void> {
  await win.evaluate((p) => {
    window.location.hash = p;
  }, path);
}

/**
 * Injects a stylesheet that kills CSS transitions/animations and caret
 * blinking, so no screenshot risks landing mid-transition. Combined with
 * `win.screenshot({ animations: 'disabled' })`'s own (JS Web Animations
 * API-only) handling for full coverage.
 */
async function disableMotion(win: Page): Promise<void> {
  await win.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }',
  });
}

/** Captures `win` to `docs/static/img/app/<filename>` with animations disabled. */
async function shot(win: Page, filename: string): Promise<void> {
  await win.screenshot({ path: join(SCREENSHOT_DIR, filename), animations: 'disabled' });
}

// Dashboard / Games / Discord / Logs / Costs / Audit / Settings

test('dashboard.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'minecraft' })).toBeVisible();
    await expect(win.getByText('RUNNING', { exact: true }).first()).toBeVisible();
    await shot(win, 'dashboard.png');
  } finally {
    await app.close();
  }
});

test('games.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/games');
    await disableMotion(win);
    await expect(new GamesPage(win).heading()).toBeVisible();
    await expect(win.getByRole('cell', { name: 'itzg/minecraft-server:latest' })).toBeVisible();
    await shot(win, 'games.png');
  } finally {
    await app.close();
  }
});

test('games-detail.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/games');
    const games = new GamesPage(win);
    await games.openGame('minecraft');
    await disableMotion(win);
    await expect(games.detailHeading('minecraft')).toBeVisible();
    await expect(games.panelTitle('Container')).toBeVisible();
    await shot(win, 'games-detail.png');
  } finally {
    await app.close();
  }
});

test('games-add-wizard.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/games');
    await disableMotion(win);
    // Two `AddGameWizard` mounts exist (header action + empty-state CTA);
    // with a populated games list only the header one renders, but `.first()`
    // keeps this robust either way.
    await win.getByRole('button', { name: 'Add game' }).first().click();
    await expect(win.getByRole('heading', { name: 'Add a game server' })).toBeVisible();
    // A freshly-opened wizard re-validates on every render and shows two
    // inline "required" errors for a blank draft — fill the Identity step so
    // the screenshot shows a populated, error-free form.
    await win.locator('#wizard-identity-name').fill('terraria');
    await win.locator('#wizard-identity-image').fill('ryshe/terraria');
    await win.locator('#wizard-identity-connect-message').fill('Connect at {ip}:7777');
    await expect(win.getByRole('button', { name: 'Next' })).toBeEnabled();
    await shot(win, 'games-add-wizard.png');
  } finally {
    await app.close();
  }
});

test('discord.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/discord');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'Discord' })).toBeVisible();
    await expect(win.getByRole('tab', { name: 'Credentials' })).toBeVisible();
    await shot(win, 'discord.png');
  } finally {
    await app.close();
  }
});

test('logs.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/logs');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'Server Logs' })).toBeVisible();
    // Seeded snapshot line, via `logs.get` (a plain invoke).
    await expect(win.getByText('Starting minecraft server version 1.21.1')).toBeVisible();
    // The live tail itself (`logs.stream`, now bridged as a `HyveonStreamHandle`
    // — see `preload.ts`) delivers real chunks: wait for the last streamed
    // line so the screenshot captures the tail mid-flow, with no error banner
    // and the "Live" badge active.
    await expect(win.getByText(DEMO_LOG_STREAM_LINES[DEMO_LOG_STREAM_LINES.length - 1]!)).toBeVisible();
    await expect(win.getByText('Stream ended with error')).toHaveCount(0);
    await shot(win, 'logs.png');
  } finally {
    await app.close();
  }
});

test('costs.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/costs');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'Cost Analysis' })).toBeVisible();
    await expect(win.getByRole('link', { name: /Open AWS Cost Explorer/i })).toBeVisible();
    await shot(win, 'costs.png');
  } finally {
    await app.close();
  }
});

test('audit.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/audit');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'Audit Log', level: 2 })).toBeVisible();
    await expect(win.getByRole('cell', { name: 'palworld' }).first()).toBeVisible();
    await shot(win, 'audit.png');
  } finally {
    await app.close();
  }
});

test('settings.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/settings');
    await disableMotion(win);
    await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(win.getByText('Watchdog Settings')).toBeVisible();
    await shot(win, 'settings.png');
  } finally {
    await app.close();
  }
});

// Infrastructure (IaC)

test('iac.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/iac');
    await disableMotion(win);
    await expect(new IacPage(win).heading()).toBeVisible();
    await expect(win.getByRole('button', { name: /Run plan/ })).toBeVisible();
    await shot(win, 'iac.png');
  } finally {
    await app.close();
  }
});

test('iac-awaiting-approval.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/iac');
    const iac = new IacPage(win);
    // Drives the page into the approval-gate state: `iac.plan()`
    // resolves `{started:true, runId:'run-plan-demo'}` (mocked), the plan
    // run's log stream attaches and delivers `DEMO_IAC_PLAN_CHUNKS`
    // (see `demo-data.ts`) through the real `HyveonStreamHandle`, which flips
    // `useIacRunLog`'s `ended` flag once the iterable completes and
    // triggers the one-shot `iac.runs.get(runId)` follow-up (mocked to
    // `awaiting_approval`, with a `changeSummary` of `{ create: 1, update: 1 }`).
    // The resource-change summary badges ("N to create" / "N to update") are
    // rendered by `ChangeSummaryStatus` in `iac.page.tsx` straight off that
    // structured `changeSummary` — never by parsing the streamed ANSI log —
    // so this screenshot shows both the populated log and the badges
    // alongside the Approve gate. `delete`/`replace`/`other` are absent from
    // the mock, so no badge renders for them (`ChangeSummaryStatus` only
    // renders a badge for counts > 0).
    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeVisible();
    await expect(iac.summaryBadge('1 to create')).toBeVisible();
    await expect(iac.summaryBadge('1 to update')).toBeVisible();
    await disableMotion(win);
    await shot(win, 'iac-awaiting-approval.png');
  } finally {
    await app.close();
  }
});

test('iac-apply.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/iac');
    const iac = new IacPage(win);
    // Carries the plan from `iac-awaiting-approval.png` one step
    // further: approve, then apply. `iac.apply()` resolves
    // `{started:true, runId:'run-apply-demo'}` (mocked), whose log stream
    // delivers `DEMO_IAC_APPLY_CHUNKS` (see `demo-data.ts`) — the same
    // `{ create: 1, update: 1 }` changeSummary shape as the plan, so the two
    // screenshots tell one consistent story.
    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeVisible();
    await iac.approveButton().click();
    await expect(iac.approvedText()).toBeVisible();
    await iac.applyButton().click();
    await expect(iac.applyCompleteText()).toBeVisible();
    // The Plan section (with its own "1 to create" badge) stays mounted above
    // the Apply section, so `.last()` targets the Apply section's copy.
    await expect(iac.summaryBadge('1 to create').last()).toBeVisible();
    // `toast.success('Apply complete')` fires a Sonner toast that
    // would otherwise sit on top of the Apply section for its full 4s
    // duration — the frozen clock never advances on its own, so nothing ever
    // dismisses it. Fast-forward past that duration (this also fires the
    // toast's own exit-animation timers) so the shot shows the settled page,
    // not a toast overlapping the result.
    await win.clock.fastForward(5000);
    await iac.applyCompleteText().scrollIntoViewIfNeeded();
    await disableMotion(win);
    await shot(win, 'iac-apply.png');
  } finally {
    await app.close();
  }
});

test('iac-history.png', async () => {
  const { app, win } = await launchSeeded((w) => seedDemo(w));
  try {
    await gotoRoute(win, '/iac');
    await IacHistoryPage.historyLinkOn(win).click();
    await disableMotion(win);
    await expect(new IacHistoryPage(win).heading()).toBeVisible();
    // Rows render `record.kind` (plan/apply/destroy), not the raw `runId`.
    await expect(win.getByRole('cell', { name: 'chris@hyveon.example.com' })).toBeVisible();
    await shot(win, 'iac-history.png');
  } finally {
    await app.close();
  }
});

// First-run wizard

test('wizard-pick-cloud.png', async () => {
  const { app, win } = await launchSeeded((w) => seedWizard(w, 'pick-cloud'));
  try {
    await expect(win.getByRole('heading', { name: 'Welcome to Hyveon' })).toBeVisible();
    await expect(win.getByRole('radiogroup', { name: 'Cloud provider' })).toBeVisible();
    await disableMotion(win);
    await shot(win, 'wizard-pick-cloud.png');
  } finally {
    await app.close();
  }
});

test('wizard-guided-iam.png', async () => {
  const { app, win } = await launchSeeded((w) => seedWizard(w, 'guided-iam'));
  try {
    await win.locator('#wizard-guided-iam-region').fill('us-east-1');
    await win.getByRole('button', { name: 'Continue with guided setup' }).click();
    // `GuidedIamStep` moves `region` -> `template` and fires
    // `wizard.guidedIam.prepareTemplate()` (mocked in `demo-data.ts`'s
    // `seedWizard`), which resolves with a template path — this is the
    // template-and-console-handoff screen, the most illustrative single
    // frame for this step (region input and key-intake are plain forms;
    // this one shows the template path, copy button, and console link).
    await expect(win.getByRole('button', { name: 'Continue to key entry' })).toBeVisible();
    await disableMotion(win);
    await shot(win, 'wizard-guided-iam.png');
  } finally {
    await app.close();
  }
});

test('wizard-credentials.png', async () => {
  const { app, win } = await launchSeeded((w) => seedWizard(w, 'credentials'));
  try {
    await expect(win.locator('#wizard-credentials-profile')).toBeVisible();
    await win.locator('#wizard-credentials-profile').selectOption('hyveon-deploy');
    await expect(win.locator('#wizard-credentials-profile-region')).toHaveValue('eu-west-2');
    await disableMotion(win);
    await shot(win, 'wizard-credentials.png');
  } finally {
    await app.close();
  }
});

test('wizard-bootstrap.png', async () => {
  const { app, win } = await launchSeeded((w) => seedWizard(w, 'bootstrap'));
  try {
    await expect(win.getByRole('button', { name: 'Bootstrap AWS resources' })).toBeVisible();
    await win.getByRole('button', { name: 'Bootstrap AWS resources' }).click();
    await win.getByRole('button', { name: 'Check permissions' }).click();
    await expect(win.getByText('All required permissions are present.')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Next' })).toBeEnabled();
    await disableMotion(win);
    await shot(win, 'wizard-bootstrap.png');
  } finally {
    await app.close();
  }
});

test('wizard-stack-init.png', async () => {
  const { app, win } = await launchSeeded((w) => seedWizard(w, 'bootstrap'));
  try {
    // `stack-init` (step 5) can only be reached by advancing from a
    // bootstrap-complete state — the wizard's own resume-on-mount logic
    // deliberately clamps a direct resume jump at `bootstrap` (see
    // `first-run-wizard.component.tsx`), so this always takes one real
    // `Next` click rather than seeding the target step directly.
    await win.getByRole('button', { name: 'Bootstrap AWS resources' }).click();
    await win.getByRole('button', { name: 'Check permissions' }).click();
    await expect(win.getByRole('button', { name: 'Next' })).toBeEnabled();
    await win.getByRole('button', { name: 'Next' }).click();

    // `StackInitializationStep` calls `window.hyveon.iac.stack.initialize()`,
    // bridged as a `HyveonStreamHandle` (see `preload.ts`), and streams
    // `DEMO_STACK_INIT_EVENTS` (see `demo-data.ts`'s `seedWizard`) to
    // completion — the step reaches its `'success'` state once the iteration
    // finishes without throwing, showing "Stack initialization complete."
    // and enabling "Finish setup".
    await expect(win.getByText('Stack initialization complete.')).toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
    await disableMotion(win);
    await shot(win, 'wizard-stack-init.png');
  } finally {
    await app.close();
  }
});
