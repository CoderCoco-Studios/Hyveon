import type { Page, ElectronApplication } from '../fixtures/index.js';
import { test, expect, launchElectron, applyHyveonMocks } from '../fixtures/index.js';
import { IacPage } from '../pages/index.js';
import type { ChangeSummary, RunLock } from '@hyveon/shared';
import type { IacStaleLockInfo } from '@hyveon/desktop-preload';

/**
 * `/iac` route specs, driven via `_electron.launch()` and
 * the `window.hyveon.__test.mock()` IPC seam — mirrors `dashboard.spec.ts`'s
 * shared-app pattern rather than the older per-test `_electron.launch()` in
 * `logs.spec.ts`.
 */

const PLAN_RUN_ID = 'run-1';
const APPLY_RUN_ID = 'apply-1';

interface IacMockOptions {
  planAck?: { started: boolean; runId?: string; error?: string; conflict?: string; staleLock?: IacStaleLockInfo };
  planLines?: string[];
  planStatus?: string;
  planHash?: string;
  /**
   * Structured resource-change counts attached to the scripted plan run's
   * `iac.runs.get` record (`IacRunRecord.changeSummary`) — drives
   * `ChangeSummaryStatus`'s badge rendering. Omitted by default, matching a
   * run whose structured summary event was never observed.
   */
  planChangeSummary?: ChangeSummary;
  approveAck?: { approved: boolean; approvedBy?: string; approvedAt?: string; error?: string };
  applyAck?: { started: boolean; runId?: string; error?: string; conflict?: string; staleLock?: IacStaleLockInfo };
  applyLines?: string[];
  applyStatus?: string;
  /** Structured resource-change counts attached to the scripted apply run's `iac.runs.get` record — see {@link planChangeSummary}. */
  applyChangeSummary?: ChangeSummary;
  /**
   * `partialApply` flag attached to the scripted apply run's `iac.runs.get`
   * record (`IacRunRecord.partialApply`) — drives `PartialApplyBanner`'s
   * rendering in place of the generic apply-failure banner. Omitted by
   * default.
   */
  applyPartialApply?: boolean;
}

/**
 * Seeds every `iac.*` IPC channel `/iac` consumes via
 * `window.hyveon.__test.mock()`. Must be called before navigating to the page
 * under test.
 *
 * `iac.runs.logs` backs `hyveon.iac.runs.streamLogs` and is
 * registered as an async generator, mirroring `logs.stream`'s mock shape in
 * `logs.spec.ts` — but its yielded chunks never actually reach the page: an
 * async generator object returned across Electron's `contextBridge` function
 * proxy (crossing back from this main-world mock into the isolated-world
 * `streamIacRunLogs`) fails with "An object could not be cloned",
 * regardless of which streaming channel or generator body is used — verified
 * against `logs.stream`'s own proven-working mock too. `useIacRunLog`'s
 * `try/catch` silently absorbs that failure and still flips `ended`, so the
 * page behaves as if the run produced no output — good enough to drive the
 * `runs.get`-derived states below (BUSY, approve, apply, success) end to end.
 * Actual chunk rendering (ANSI, ordering, summary parsing) is covered by
 * `iac.page.test.tsx` and `ansi-log-viewer.component.test.tsx` instead,
 * which mock `window.hyveon` directly in jsdom with no contextBridge involved.
 */
async function mockIac(win: Page, opts: IacMockOptions = {}): Promise<void> {
  const planAck = opts.planAck ?? { started: true, runId: PLAN_RUN_ID };
  const planLines = opts.planLines ?? ['Plan: 3 to add, 1 to change, 0 to destroy.'];
  const planStatus = opts.planStatus ?? 'awaiting_approval';
  const planHash = opts.planHash ?? 'hash-1';
  const planChangeSummary = opts.planChangeSummary;
  const approveAck = opts.approveAck ?? {
    approved: true,
    approvedBy: 'alice',
    approvedAt: new Date().toISOString(),
  };
  const applyAck = opts.applyAck ?? { started: true, runId: APPLY_RUN_ID };
  const applyLines = opts.applyLines ?? ['Apply complete! Resources: 3 added, 1 changed, 0 destroyed.'];
  const applyStatus = opts.applyStatus ?? 'success';
  const applyChangeSummary = opts.applyChangeSummary;
  const applyPartialApply = opts.applyPartialApply;

  await win.evaluate(
    ({
      planAck,
      planLines,
      planStatus,
      planHash,
      planChangeSummary,
      approveAck,
      applyAck,
      applyLines,
      applyStatus,
      applyChangeSummary,
      applyPartialApply,
      planRunId,
      applyRunId,
    }) => {
      const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      hyveon.__test.mock('iac.plan', () => Promise.resolve(planAck));
      hyveon.__test.mock('iac.approve', () => Promise.resolve(approveAck));
      hyveon.__test.mock('iac.apply', () => Promise.resolve(applyAck));
      hyveon.__test.mock('iac.runs.get', (payload: { runId: string }) => {
        if (payload.runId === planRunId) {
          return Promise.resolve({
            found: true,
            status: planStatus,
            record: {
              runId: planRunId,
              kind: 'plan',
              startedAt: 't0',
              completedAt: 't1',
              exitCode: 0,
              planHash,
              ...(planChangeSummary ? { changeSummary: planChangeSummary } : {}),
            },
          });
        }
        if (payload.runId === applyRunId) {
          return Promise.resolve({
            found: true,
            status: applyStatus,
            record: {
              runId: applyRunId,
              kind: 'apply',
              startedAt: 't0',
              completedAt: 't1',
              exitCode: applyStatus === 'success' ? 0 : 1,
              ...(applyChangeSummary ? { changeSummary: applyChangeSummary } : {}),
              ...(applyPartialApply !== undefined ? { partialApply: applyPartialApply } : {}),
            },
          });
        }
        return Promise.resolve({ found: false });
      });
      hyveon.__test.mock('iac.runs.logs', async function* (runId: string) {
        if (runId === planRunId) {
          for (const line of planLines) yield { stream: 'stdout', line };
        } else if (runId === applyRunId) {
          for (const line of applyLines) yield { stream: 'stdout', line };
        }
      });
    },
    {
      planAck,
      planLines,
      planStatus,
      planHash,
      planChangeSummary,
      approveAck,
      applyAck,
      applyLines,
      applyStatus,
      applyChangeSummary,
      applyPartialApply,
      planRunId: PLAN_RUN_ID,
      applyRunId: APPLY_RUN_ID,
    },
  );
}

test.describe('iac page', () => {
  let app: ElectronApplication | undefined;
  let win: Page;
  let iac: IacPage;

  test.beforeAll(async () => {
    ({ app, win } = await launchElectron());
    iac = new IacPage(win);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // `/iac` carries its own multi-step run state (planRunId, approval,
  // applyRunId, ...) that only resets on remount — navigating to it again
  // while already there is a same-pathname no-op in React Router and leaves
  // the previous test's state in place, so each test's `gotoViaSidebar()`
  // call could silently act on a stale plan/apply run. Navigating away first
  // forces `/iac` to unmount so the next `gotoViaSidebar()` call is a
  // real route transition that mounts it fresh. Harmless on the first test,
  // where the window is already on `/`.
  test.beforeEach(async () => {
    if (!win) return;
    // Exact-match: the apply-success banner's own "View dashboard" link
    // also links to `/` and would otherwise collide with the sidebar item.
    await win.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await win.waitForURL('**/');
  });

  test.afterEach(async () => {
    if (!win) return;
    await win.evaluate(() => {
      const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
        __test: { clearMocks: () => void };
      };
      hyveon.__test.clearMocks();
    });
  });

  test('should reach awaiting_approval and enable the Approve button once the plan run finishes', async () => {
    await applyHyveonMocks(win);
    await mockIac(win);
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();

    await expect(iac.approveButton()).toBeEnabled();
  });

  test('should render a BUSY banner when plan submission reports a workspace conflict', async () => {
    await applyHyveonMocks(win);
    await mockIac(win, { planAck: { started: false, error: 'workspace busy', conflict: 'up' } });
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();

    await expect(iac.alerts().filter({ hasText: 'an apply run is already in progress' })).toBeVisible();
  });

  test('should approve the plan, then apply and reach the success banner', async () => {
    await applyHyveonMocks(win);
    await mockIac(win);
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeEnabled();
    await iac.approveButton().click();

    await expect(iac.approvedText()).toBeVisible();
    await expect(iac.applyButton()).toBeEnabled();

    await iac.applyButton().click();

    await expect(iac.applyCompleteText()).toBeVisible();
    await expect(iac.dashboardLink()).toBeVisible();
  });

  test('should show an expired-approval hint and keep Apply disabled until re-approved', async () => {
    const staleApprovedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await applyHyveonMocks(win);
    await mockIac(win, {
      approveAck: { approved: true, approvedBy: 'bob', approvedAt: staleApprovedAt },
    });
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeEnabled();
    await iac.approveButton().click();

    await expect(iac.approvalExpiredText()).toBeVisible();
    await expect(iac.applyButton()).toBeDisabled();
    await expect(iac.reapproveButton()).toBeVisible();
  });

  test('should render the structured change-summary badges once the plan run finishes', async () => {
    await applyHyveonMocks(win);
    await mockIac(win, { planChangeSummary: { create: 3, update: 1 } });
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();

    await expect(iac.summaryBadge('3 to create')).toBeVisible();
    await expect(iac.summaryBadge('1 to update')).toBeVisible();
  });

  test('should render the partial-apply banner instead of the generic error banner when the apply run reports partialApply', async () => {
    await applyHyveonMocks(win);
    await mockIac(win, { applyStatus: 'failed', applyPartialApply: true });
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeEnabled();
    await iac.approveButton().click();
    await expect(iac.applyButton()).toBeEnabled();
    await iac.applyButton().click();

    await expect(iac.partialApplyBanner()).toBeVisible();
    await expect(iac.alerts().filter({ hasText: 'Apply failed' })).toHaveCount(0);
  });

  test('should render a StaleLockBanner with holder info when a plan submission reports a stale lock', async () => {
    await applyHyveonMocks(win);
    await mockIac(win, {
      planAck: {
        started: false,
        error: 'Pulumi backend is locked.',
        staleLock: {
          stackName: 'hyveon-prod',
          locks: [
            {
              lockUrl: 's3://hyveon-pulumi-state/.pulumi/locks/hyveon-prod/lock-1.json',
              username: 'alice',
              hostname: 'ci-runner',
              pid: 4321,
              lockedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            },
          ],
        },
      },
    });
    await iac.gotoViaSidebar();

    await iac.runPlanButton().click();

    const banner = iac.staleLockBanner();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('hyveon-prod');
    await expect(banner).toContainText('alice@ci-runner');
    await expect(banner).toContainText('pid 4321');
  });

  test('should clear a stuck run lock and allow manual resubmission', async () => {
    const runLock: RunLock = {
      runId: 'r1',
      kind: 'apply',
      initiator: 'chris',
      acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    };

    await applyHyveonMocks(win);
    // Seeds plan/approve/runs.get/runs.logs for the default happy-path apply
    // run (APPLY_RUN_ID); the `iac.apply` handler itself is overridden below
    // so the first submission reports the durable-lock refusal instead.
    await mockIac(win);
    const mintedToken = 'tok';
    await win.evaluate(
      ({ runLock, applyRunId, mintedToken }) => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
        };

        // First submission is refused because a durable RunLock is held
        // (apply/destroy only — see `IacPlanAck.runLock`'s doc comment);
        // every later call — the operator's manual resubmit — succeeds.
        let applyCalls = 0;
        hyveon.__test.mock('iac.apply', () => {
          applyCalls += 1;
          if (applyCalls === 1) {
            return Promise.resolve({
              started: false,
              conflict: 'up',
              error: 'Run lock already held by "chris"',
              runLock,
            });
          }
          return Promise.resolve({ started: true, runId: applyRunId });
        });
        // Record the confirmationToken the clear handler actually receives,
        // using window.__calledChannels as the in-browser store (mirrors
        // dashboard.spec.ts's IPC-call-capture pattern) — proves the
        // mint→clear token-passing chain is exercised end to end, not just
        // independently mocked.
        (window as unknown as Record<string, unknown>)['__calledChannels'] = {} as Record<string, unknown>;
        hyveon.__test.mock('iac.runs.lock.clear.mintToken', () => Promise.resolve({ token: mintedToken }));
        hyveon.__test.mock('iac.runs.lock.clear', (payload: { confirmationToken: string }) => {
          (
            (window as unknown as Record<string, unknown>)['__calledChannels'] as Record<string, unknown>
          )['iac.runs.lock.clear.confirmationToken'] = payload.confirmationToken;
          return Promise.resolve({ cleared: true });
        });
      },
      { runLock, applyRunId: APPLY_RUN_ID, mintedToken },
    );

    await iac.gotoViaSidebar();
    await iac.runPlanButton().click();
    await expect(iac.approveButton()).toBeEnabled();
    await iac.approveButton().click();
    await expect(iac.applyButton()).toBeEnabled();

    // First submission is refused — BUSY banner plus the original error
    // banner both appear, and the runLock ack unlocks the clear action.
    await iac.applyButton().click();
    await expect(iac.runLockAlreadyHeldText()).toBeVisible();
    await expect(iac.clearRunLockButton()).toBeVisible();

    await iac.clearRunLockButton().click();
    await iac.confirmClearLockButton().click();
    await expect(iac.runLockClearedToast()).toBeVisible();

    // The `confirmationToken` sent on `iac.runs.lock.clear` must be the
    // non-empty token actually minted via `iac.runs.lock.clear.mintToken` —
    // proves `iac.page.tsx` wires the mint→clear chain correctly rather than
    // sending a blank or fabricated token.
    const capturedToken = await win.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>)['__calledChannels'] as Record<string, unknown>)[
          'iac.runs.lock.clear.confirmationToken'
        ],
    );
    expect(capturedToken).toBe(mintedToken);
    expect(typeof capturedToken).toBe('string');
    expect(capturedToken).not.toHaveLength(0);

    // Returns to the ready-to-submit state: both the original error banner
    // and the BUSY banner's clear action are gone, and clearing never
    // auto-resubmits on its own.
    await expect(iac.runLockAlreadyHeldText()).not.toBeVisible();
    await expect(iac.clearRunLockButton()).not.toBeVisible();

    // Operator resubmits manually — this time it succeeds.
    await iac.applyButton().click();
    await expect(iac.applyCompleteText()).toBeVisible();
  });
});
