import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

/**
 * Stub for `window.hyveon.iac` — `plan`/`approve`/`apply` are plain
 * `vi.fn()`s resolved per-test; `runs.streamLogs` and `runs.get` are keyed
 * off the run id so the plan and apply runs (started sequentially in the
 * same test) can be driven independently.
 */
const hyveonMock = {
  iac: {
    plan: vi.fn(),
    approve: vi.fn(),
    apply: vi.fn(),
    mintDestroyToken: vi.fn(),
    destroy: vi.fn(),
    output: vi.fn(),
    runs: {
      get: vi.fn(),
      streamLogs: vi.fn(),
      lock: {
        mintToken: vi.fn(),
        clear: vi.fn(),
      },
    },
    lock: {
      mintToken: vi.fn(),
      clear: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { IacPage } from './iac.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const PLAN_RUN_ID = 'run-1';
const APPLY_RUN_ID = 'apply-1';
const DESTROY_RUN_ID = 'destroy-1';
const DESTROY_CONFIRM_PHRASE = 'destroy infrastructure';

/**
 * Seeds a plan run that streams a raw log line then finishes
 * `awaiting_approval` with `planHash` and a structured `changeSummary` — the
 * page reads the summary off the persisted record, not by scraping the
 * streamed log text, so the log content here is just pass-through display
 * data for `AnsiLogViewer`.
 */
function seedSuccessfulPlan() {
  hyveonMock.iac.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
  hyveonMock.iac.runs.streamLogs.mockImplementation(
    toStreamHandleMock(async function* (runId: string) {
      if (runId === PLAN_RUN_ID) {
        yield { stream: 'stdout', line: 'Previewing update (hyveon-dev)' };
      } else if (runId === APPLY_RUN_ID) {
        yield { stream: 'stdout', line: 'Updating (hyveon-dev)' };
      }
    }),
  );
  hyveonMock.iac.runs.get.mockImplementation(async (runId: string) => {
    if (runId === PLAN_RUN_ID) {
      return {
        found: true,
        status: 'awaiting_approval',
        record: {
          runId: PLAN_RUN_ID,
          kind: 'plan',
          startedAt: 't0',
          completedAt: 't1',
          exitCode: 0,
          planHash: 'hash-1',
          changeSummary: { create: 3, update: 1 },
        },
      };
    }
    if (runId === APPLY_RUN_ID) {
      return {
        found: true,
        status: 'success',
        record: {
          runId: APPLY_RUN_ID,
          kind: 'apply',
          startedAt: 't0',
          completedAt: 't1',
          exitCode: 0,
          changeSummary: { create: 3, update: 1 },
        },
      };
    }
    return { found: false };
  });
}

/** A `IacStaleLockInfo`-shaped fixture for one lock holder, "started" 5 minutes before `now`. */
function makeStaleLockInfo() {
  return {
    stackName: 'production',
    locks: [
      {
        lockUrl: 's3://hyveon-state/.pulumi/locks/production/lock-1.json',
        username: 'alice',
        hostname: 'alice-laptop',
        pid: 4242,
        lockedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ],
  };
}

describe('IacPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.iac.plan.mockReset();
    hyveonMock.iac.approve.mockReset();
    hyveonMock.iac.apply.mockReset();
    hyveonMock.iac.mintDestroyToken.mockReset();
    hyveonMock.iac.destroy.mockReset();
    hyveonMock.iac.runs.get.mockReset();
    hyveonMock.iac.runs.streamLogs.mockReset();
    hyveonMock.iac.lock.mintToken.mockReset();
    hyveonMock.iac.lock.clear.mockReset();
    hyveonMock.iac.runs.lock.mintToken.mockReset().mockResolvedValue({ token: 'test-token' });
    hyveonMock.iac.runs.lock.clear.mockReset().mockResolvedValue({ cleared: true });
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Run plan trigger in the idle state', () => {
    renderPage(<IacPage />);
    expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
  });

  it('should link to the run-history route', () => {
    renderPage(<IacPage />);
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute('href', '/iac/history');
  });

  it('should stream plan output and render the structured resource-change summary once the plan finishes', async () => {
    seedSuccessfulPlan();
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    expect(await screen.findByText('Previewing update (hyveon-dev)')).toBeInTheDocument();
    expect(await screen.findByText('3 to create')).toBeInTheDocument();
    expect(screen.getByText('1 to update')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
  });

  it('should render an explicit "summary unavailable" state when the plan record has no changeSummary', async () => {
    hyveonMock.iac.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
    hyveonMock.iac.runs.streamLogs.mockImplementation(toStreamHandleMock(async function* () {}));
    hyveonMock.iac.runs.get.mockResolvedValue({
      found: true,
      status: 'awaiting_approval',
      record: { runId: PLAN_RUN_ID, kind: 'plan', startedAt: 't0', completedAt: 't1', exitCode: 0, planHash: 'hash-1' },
    });
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    expect(await screen.findByText('Change summary unavailable')).toBeInTheDocument();
  });

  it('should render a distinct "no changes" state when the plan record reports only unchanged resources', async () => {
    hyveonMock.iac.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
    hyveonMock.iac.runs.streamLogs.mockImplementation(toStreamHandleMock(async function* () {}));
    hyveonMock.iac.runs.get.mockResolvedValue({
      found: true,
      status: 'awaiting_approval',
      record: {
        runId: PLAN_RUN_ID,
        kind: 'plan',
        startedAt: 't0',
        completedAt: 't1',
        exitCode: 0,
        planHash: 'hash-1',
        changeSummary: { same: 5 },
      },
    });
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    expect(await screen.findByText('No changes — 5 unchanged')).toBeInTheDocument();
    expect(screen.queryByText('Change summary unavailable')).not.toBeInTheDocument();
  });

  it('should render a BUSY banner when plan submission reports a workspace conflict', async () => {
    hyveonMock.iac.plan.mockResolvedValue({ started: false, error: 'workspace busy', conflict: 'up' });
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('an apply run is already in progress'))).toBe(true);
  });

  describe('BusyBanner run-lock clear action', () => {
    it('should show no clear action on BusyBanner when the busy ack has no runLock (workspace busy, not a durable lock)', async () => {
      // plan/preview never acquires the durable RunLock, so its only busy refusal is
      // PulumiOperationInFlightError — always conflict: 'preview', never a runLock.
      hyveonMock.iac.plan.mockResolvedValue({ started: false, conflict: 'preview', error: 'preview is already in flight' });
      renderPage(<IacPage />);
      await userEvent.click(screen.getByRole('button', { name: /Run plan/i }));
      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.match(/workspace busy/i))).toBe(true);
      expect(screen.queryByRole('button', { name: /clear lock and retry/i })).not.toBeInTheDocument();
    });

    it('should show a clear action on BusyBanner when the busy ack carries runLock, clear it on confirm, and return to ready state for manual resubmission', async () => {
      // Only apply/destroy can be refused with a durable RunLockHeldError (and thus
      // carry runLock) — plan/preview structurally cannot, see the test above.
      const heldLock = { runId: 'r1', kind: 'apply', initiator: 'chris', acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z' };
      hyveonMock.iac.apply.mockResolvedValueOnce({
        started: false,
        conflict: 'up',
        error: 'Run lock already held by "chris"',
        runLock: heldLock,
      });
      hyveonMock.iac.apply.mockResolvedValueOnce({ started: true, runId: APPLY_RUN_ID });
      seedSuccessfulPlan();
      hyveonMock.iac.approve.mockResolvedValue({
        approved: true,
        approvedBy: 'alice',
        approvedAt: new Date().toISOString(),
      });

      renderPage(<IacPage />);
      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
      const applyBtn = await screen.findByRole('button', { name: /^Apply$/ });

      await userEvent.click(applyBtn);
      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.match(/run lock already held/i))).toBe(true); // original ErrorBanner
      await userEvent.click(await screen.findByRole('button', { name: /clear lock and retry/i }));
      await userEvent.click(screen.getByRole('button', { name: /^clear lock$/i })); // confirm dialog

      expect(hyveonMock.iac.runs.lock.clear).toHaveBeenCalledWith({ confirmationToken: 'test-token' });
      await waitFor(() =>
        expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/run lock cleared/i)),
      );
      // returns to ready state: both the BUSY banner and the original ErrorBanner are gone
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /clear lock and retry/i })).not.toBeInTheDocument();

      // clearing does not auto-resubmit; the operator retries manually
      expect(hyveonMock.iac.apply).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
      expect(hyveonMock.iac.apply).toHaveBeenCalledTimes(2);
    });
  });

  describe('stale-lock recovery', () => {
    it('should render the stale-lock banner (naming the stack and every holder) instead of a busy/error banner when plan submission reports staleLock', async () => {
      hyveonMock.iac.plan.mockResolvedValue({
        started: false,
        error: 'the stack is currently locked by 1 lock(s)',
        staleLock: makeStaleLockInfo(),
      });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

      expect(await screen.findByText(/production/)).toBeInTheDocument();
      expect(screen.getByText(/alice@alice-laptop/)).toBeInTheDocument();
      expect(screen.getByText(/pid 4242/)).toBeInTheDocument();
      // formatLockAge's rendered wording — makeStaleLockInfo's fixture sets
      // lockedAt 5 minutes before "now".
      expect(screen.getByText(/started 5 minutes ago/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Clear lock and retry/ })).toBeInTheDocument();
      // The raw ack.error prose must not ALSO render via the generic ErrorBanner —
      // staleLock replaces it, per the controller's own mutually-exclusive branches.
      expect(screen.queryByText('the stack is currently locked by 1 lock(s)')).not.toBeInTheDocument();
    });

    it('should open a confirmation dialog on "Clear lock and retry", without calling hyveon.iac.lock.clear() until confirmed', async () => {
      hyveonMock.iac.plan.mockResolvedValue({ started: false, error: 'locked', staleLock: makeStaleLockInfo() });
      renderPage(<IacPage />);
      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await screen.findByRole('button', { name: /Clear lock and retry/ });

      await userEvent.click(screen.getByRole('button', { name: /Clear lock and retry/ }));

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(hyveonMock.iac.lock.clear).not.toHaveBeenCalled();
    });

    it('should call hyveon.iac.lock.clear() and return to the idle Run plan state — WITHOUT the stale rejection\'s error banner reappearing — once the operator confirms and the clear succeeds', async () => {
      // A successful clear must reset both xStaleLock and xSubmitError —
      // resetting only xStaleLock leaves xSubmitError still holding the
      // original rejection's error text, which reappears via the generic
      // ErrorBanner the instant the ternary falls through. The exact error
      // text below must be gone from the document after a successful clear,
      // not just the "Clear lock and retry" button.
      const REJECTION_ERROR_TEXT = 'the stack is currently locked by 1 lock(s)';
      hyveonMock.iac.plan.mockResolvedValue({
        started: false,
        error: REJECTION_ERROR_TEXT,
        staleLock: makeStaleLockInfo(),
      });
      hyveonMock.iac.lock.mintToken.mockResolvedValue({ token: 'test-token' });
      hyveonMock.iac.lock.clear.mockResolvedValue({ cleared: true });
      renderPage(<IacPage />);
      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Clear lock and retry/ }));
      await screen.findByRole('alertdialog');

      await userEvent.click(screen.getByRole('button', { name: 'Clear lock' }));

      await waitFor(() => expect(hyveonMock.iac.lock.clear).toHaveBeenCalledTimes(1));
      expect(hyveonMock.iac.lock.clear).toHaveBeenCalledWith({ confirmationToken: 'test-token' });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(/Clear lock and retry/)).not.toBeInTheDocument());
      // Back to the ordinary idle state — Run plan is submittable again, matching
      // PulumiService.clearStaleLock's "does not retry" design — and the stale
      // rejection's error text must NOT have reappeared underneath.
      expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
      expect(screen.queryByText(REJECTION_ERROR_TEXT)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('should surface the failure via an error banner and keep the stale-lock banner in place when the clear itself fails', async () => {
      hyveonMock.iac.plan.mockResolvedValue({ started: false, error: 'locked', staleLock: makeStaleLockInfo() });
      hyveonMock.iac.lock.mintToken.mockResolvedValue({ token: 'test-token' });
      hyveonMock.iac.lock.clear.mockResolvedValue({ cleared: false, error: 'pulumi stack.cancel() failed: boom' });
      renderPage(<IacPage />);
      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Clear lock and retry/ }));
      await screen.findByRole('alertdialog');

      await userEvent.click(screen.getByRole('button', { name: 'Clear lock' }));

      expect(await screen.findByText('pulumi stack.cancel() failed: boom')).toBeInTheDocument();
      // The stale-lock evidence stays on screen — nothing was actually cleared.
      expect(screen.getByText(/alice@alice-laptop/)).toBeInTheDocument();
    });
  });

  it('should enable Apply only after the plan is approved, then stream apply output to completion', async () => {
    seedSuccessfulPlan();
    hyveonMock.iac.approve.mockResolvedValue({
      approved: true,
      approvedBy: 'alice',
      approvedAt: new Date().toISOString(),
    });
    hyveonMock.iac.apply.mockResolvedValue({ started: true, runId: APPLY_RUN_ID });
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());

    // Apply isn't reachable yet — approval hasn't happened.
    expect(screen.queryByRole('button', { name: /^Apply$/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));

    expect(await screen.findByText(/Approved by/)).toBeInTheDocument();
    const applyBtn = await screen.findByRole('button', { name: /^Apply$/ });
    expect(applyBtn).toBeEnabled();

    await userEvent.click(applyBtn);

    expect(hyveonMock.iac.apply).toHaveBeenCalledWith({ planRunId: PLAN_RUN_ID, planHash: 'hash-1' });
    expect(await screen.findByText(/Apply complete\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View dashboard' })).toHaveAttribute('href', '/');
  });

  it('should show an expired-approval message and disable Apply until re-approved', async () => {
    seedSuccessfulPlan();
    const staleApprovedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 minutes ago > 15-minute window
    hyveonMock.iac.approve.mockResolvedValue({ approved: true, approvedBy: 'bob', approvedAt: staleApprovedAt });
    renderPage(<IacPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));

    expect(await screen.findByText(/approval expired, re-approve to apply/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Apply$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Re-approve/ })).toBeInTheDocument();
  });

  describe('destroy flow (#307)', () => {
    it('should render the Destroy infrastructure trigger in the idle state', () => {
      renderPage(<IacPage />);
      expect(screen.getByRole('button', { name: /Destroy infrastructure/ })).toBeInTheDocument();
    });

    it('should open a confirmation dialog on click, without minting a token until the exact phrase is typed and confirmed', async () => {
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toBeInTheDocument();
      expect(hyveonMock.iac.mintDestroyToken).not.toHaveBeenCalled();

      // The dialog's own confirm button stays disabled until the exact phrase is typed.
      expect(screen.getByRole('button', { name: 'Destroy' })).toBeDisabled();

      await userEvent.type(screen.getByLabelText('Type to confirm'), 'wrong phrase');
      expect(screen.getByRole('button', { name: 'Destroy' })).toBeDisabled();
      expect(hyveonMock.iac.mintDestroyToken).not.toHaveBeenCalled();
    });

    it('should mint a token, submit destroy with it, and stream output through the log viewer once the exact phrase is confirmed', async () => {
      hyveonMock.iac.mintDestroyToken.mockResolvedValue({ token: 'destroy-token-1' });
      hyveonMock.iac.destroy.mockResolvedValue({ started: true, runId: DESTROY_RUN_ID });
      hyveonMock.iac.runs.streamLogs.mockImplementation(
        toStreamHandleMock(async function* (runId: string) {
          if (runId === DESTROY_RUN_ID) {
            yield { stream: 'stdout', line: 'Destroying (hyveon-dev)' };
          }
        }),
      );
      hyveonMock.iac.runs.get.mockResolvedValue({
        found: true,
        status: 'success',
        record: {
          runId: DESTROY_RUN_ID,
          kind: 'destroy',
          startedAt: 't0',
          completedAt: 't1',
          exitCode: 0,
          changeSummary: { delete: 4 },
        },
      });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));

      await waitFor(() => expect(hyveonMock.iac.mintDestroyToken).toHaveBeenCalledTimes(1));
      expect(hyveonMock.iac.destroy).toHaveBeenCalledWith({ confirmationToken: 'destroy-token-1' });

      expect(await screen.findByText('Destroying (hyveon-dev)')).toBeInTheDocument();
      expect(await screen.findByText('4 to delete')).toBeInTheDocument();
      expect(await screen.findByText('Destroy complete.')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should render a BUSY banner when destroy submission reports a workspace conflict, without opening the log view', async () => {
      hyveonMock.iac.mintDestroyToken.mockResolvedValue({ token: 'destroy-token-1' });
      hyveonMock.iac.destroy.mockResolvedValue({
        started: false,
        error: 'pulumi destroy refused: apply is already in flight',
        conflict: 'up',
      });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));

      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.includes('an apply run is already in progress'))).toBe(true);
      expect(screen.queryByRole('heading', { name: 'Destroy run' })).not.toBeInTheDocument();
    });

    it('should mint a fresh token on every attempt', async () => {
      hyveonMock.iac.mintDestroyToken
        .mockResolvedValueOnce({ token: 'destroy-token-1' })
        .mockResolvedValueOnce({ token: 'destroy-token-2' });
      hyveonMock.iac.destroy
        .mockResolvedValueOnce({ started: false, error: 'workspace busy', conflict: 'up' })
        .mockResolvedValueOnce({ started: true, runId: DESTROY_RUN_ID });
      hyveonMock.iac.runs.streamLogs.mockImplementation(
        toStreamHandleMock(async function* () { /* no chunks needed */ }),
      );
      hyveonMock.iac.runs.get.mockResolvedValue({ found: true, status: 'success' });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));
      await waitFor(() => expect(hyveonMock.iac.destroy).toHaveBeenCalledTimes(1));

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));
      await waitFor(() => expect(hyveonMock.iac.destroy).toHaveBeenCalledTimes(2));

      expect(hyveonMock.iac.mintDestroyToken).toHaveBeenCalledTimes(2);
      expect(hyveonMock.iac.destroy).toHaveBeenNthCalledWith(1, { confirmationToken: 'destroy-token-1' });
      expect(hyveonMock.iac.destroy).toHaveBeenNthCalledWith(2, { confirmationToken: 'destroy-token-2' });
    });
  });

  describe('partial-apply flow', () => {
    /** Drives a plan through approval and into a submitted apply, seeded to end with the given terminal `applyStatus`/`partialApply` flag. */
    async function runApplyToPartialFailure(applyStatus: 'failed' | 'aborted') {
      seedSuccessfulPlan();
      hyveonMock.iac.approve.mockResolvedValue({
        approved: true,
        approvedBy: 'alice',
        approvedAt: new Date().toISOString(),
      });
      hyveonMock.iac.apply.mockResolvedValue({ started: true, runId: APPLY_RUN_ID });
      hyveonMock.iac.runs.get.mockImplementation(async (runId: string) => {
        if (runId === PLAN_RUN_ID) {
          return {
            found: true,
            status: 'awaiting_approval',
            record: {
              runId: PLAN_RUN_ID,
              kind: 'plan',
              startedAt: 't0',
              completedAt: 't1',
              exitCode: 0,
              planHash: 'hash-1',
              changeSummary: { create: 3, update: 1 },
            },
          };
        }
        if (runId === APPLY_RUN_ID) {
          return {
            found: true,
            status: applyStatus,
            record: {
              runId: APPLY_RUN_ID,
              kind: 'apply',
              startedAt: 't0',
              completedAt: 't1',
              exitCode: 1,
              partialApply: true,
            },
          };
        }
        return { found: false };
      });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
      const applyBtn = await screen.findByRole('button', { name: /^Apply$/ });
      await userEvent.click(applyBtn);
    }

    it('should surface the partial-apply banner with re-plan guidance when a failed apply reports partialApply', async () => {
      await runApplyToPartialFailure('failed');

      expect(await screen.findByText(/Apply stopped partway through\./)).toBeInTheDocument();
      expect(screen.getByText(/run a fresh plan against the current state/i)).toBeInTheDocument();
    });

    it('should surface the partial-apply banner when an aborted (not just failed) apply reports partialApply', async () => {
      // Task 9.3's explicit requirement: the signal is `partialApply`, checked
      // independent of which terminal status fired — `aborted` must trigger
      // the same banner as `failed`.
      await runApplyToPartialFailure('aborted');

      expect(await screen.findByText(/Apply stopped partway through\./)).toBeInTheDocument();
    });

    it('should show exactly one "Start over" action, embedded in the partial-apply banner, not a duplicate generic one', async () => {
      await runApplyToPartialFailure('failed');

      await screen.findByText(/Apply stopped partway through\./);
      const startOverButtons = screen.getAllByRole('button', { name: /Start over/ });
      expect(startOverButtons).toHaveLength(1);

      await userEvent.click(startOverButtons[0]);
      expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
    });

    it('should render the generic failure banner (not the partial-apply banner) when the apply fails without partialApply', async () => {
      seedSuccessfulPlan();
      hyveonMock.iac.approve.mockResolvedValue({
        approved: true,
        approvedBy: 'alice',
        approvedAt: new Date().toISOString(),
      });
      hyveonMock.iac.apply.mockResolvedValue({ started: true, runId: APPLY_RUN_ID });
      hyveonMock.iac.runs.get.mockImplementation(async (runId: string) => {
        if (runId === PLAN_RUN_ID) {
          return {
            found: true,
            status: 'awaiting_approval',
            record: { runId: PLAN_RUN_ID, kind: 'plan', startedAt: 't0', completedAt: 't1', exitCode: 0, planHash: 'hash-1' },
          };
        }
        if (runId === APPLY_RUN_ID) {
          return {
            found: true,
            status: 'failed',
            record: { runId: APPLY_RUN_ID, kind: 'apply', startedAt: 't0', completedAt: 't1', exitCode: 1 },
          };
        }
        return { found: false };
      });
      renderPage(<IacPage />);

      await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
      const applyBtn = await screen.findByRole('button', { name: /^Apply$/ });
      await userEvent.click(applyBtn);

      expect(await screen.findByText(/Apply failed — see the log above/)).toBeInTheDocument();
      expect(screen.queryByText(/Apply stopped partway through\./)).not.toBeInTheDocument();
    });
  });

  describe('rollback flow (#112)', () => {
    it('should auto-submit a tagged plan with the rollback location.state, without requiring a Run plan click', async () => {
      hyveonMock.iac.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
      hyveonMock.iac.runs.streamLogs.mockImplementation(
        toStreamHandleMock(async function* () {
          /* no chunks needed for this assertion */
        }),
      );
      hyveonMock.iac.runs.get.mockResolvedValue({ found: false });

      renderPage(<IacPage />, {
        initialEntries: [
          { pathname: '/iac', state: { configVersionId: 'v-new-head', rolledBackFrom: 'apply-1' } },
        ],
      });

      await waitFor(() =>
        expect(hyveonMock.iac.plan).toHaveBeenCalledWith({
          configVersionId: 'v-new-head',
          rolledBackFrom: 'apply-1',
        }),
      );
      expect(screen.queryByRole('button', { name: /Run plan/ })).not.toBeInTheDocument();
    });

    it('should render a link to the rolled-back apply run once the plan record carries rolledBackFrom', async () => {
      hyveonMock.iac.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
      hyveonMock.iac.runs.streamLogs.mockImplementation(
        toStreamHandleMock(async function* () {
          /* no chunks needed for this assertion */
        }),
      );
      hyveonMock.iac.runs.get.mockResolvedValue({
        found: true,
        status: 'awaiting_approval',
        record: {
          runId: PLAN_RUN_ID,
          kind: 'plan',
          startedAt: 't0',
          completedAt: 't1',
          exitCode: 0,
          planHash: 'hash-1',
          rolledBackFrom: 'apply-1',
        },
      });

      renderPage(<IacPage />, {
        initialEntries: [
          { pathname: '/iac', state: { configVersionId: 'v-new-head', rolledBackFrom: 'apply-1' } },
        ],
      });

      const link = await screen.findByRole('link', { name: /apply run apply-1/ });
      expect(link).toHaveAttribute('href', '/iac/history/apply-1');
    });

    it('should not auto-submit when there is no rollback location.state', () => {
      renderPage(<IacPage />);
      expect(hyveonMock.iac.plan).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
    });
  });
});
