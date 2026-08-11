import type { Page, Locator } from '@playwright/test';
import { gotoHashRoute } from './hashRoute.js';

/**
 * Page object for the `/iac` route added in issue #110 — plan trigger,
 * live ANSI log viewer, resource-change summary, approve gate, and
 * plan-hash-gated apply.
 */
export class IacPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/iac` directly via URL. */
  async goto(): Promise<void> {
    await gotoHashRoute(this.page, '/iac');
  }

  /**
   * Navigate to `/iac` by clicking the sidebar link and waiting for the URL
   * to settle. Scoped to the `<nav aria-label="Main navigation">` landmark
   * (`app-layout.component.tsx`) rather than an unscoped `getByRole('link')`
   * lookup: an exact-match name alone isn't enough to disambiguate — the
   * dashboard's `NoGamesCard` empty state (rendered by default in test
   * mode, which starts with no games configured) ALSO renders a link whose
   * text is the exact string "Infrastructure" (`dashboard.page.tsx`'s
   * `NoGamesCard`), so an unscoped exact-match lookup matches two elements
   * and Playwright throws a strict-mode violation. Scoping to the nav
   * landmark first is what disambiguates; the desktop sidebar's `<nav>` is
   * the only one visible in the accessibility tree in the default (mobile
   * drawer closed) state — `app-layout.component.tsx` renders a second,
   * identically-labeled `<nav>` for the mobile drawer, but it's
   * `aria-hidden`/`display: none` while closed, so
   * `getByRole('navigation', ...)` still resolves to exactly one match here.
   */
  async gotoViaSidebar(): Promise<void> {
    await this.page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Infrastructure', exact: true })
      .click();
    await this.page.waitForURL('**/iac');
  }

  // ── Plan ─────────────────────────────────────────────────────────────

  /**
   * "Infrastructure" page heading — used as a "the page mounted" smoke
   * check. `exact: true` disambiguates from the "Destroy infrastructure"
   * section heading, whose accessible name otherwise substring-matches
   * "Infrastructure" too.
   */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Infrastructure', exact: true });
  }

  /** Trigger that submits `hyveon.iac.plan()`. */
  runPlanButton(): Locator {
    return this.page.getByRole('button', { name: /Run plan/ });
  }

  /** Every alert banner currently rendered (BUSY lock banners and inline submission errors both use `role="alert"`). */
  alerts(): Locator {
    return this.page.getByRole('alert');
  }

  /** A single change-summary badge, e.g. "3 to create" / "1 to update" / "1 unchanged" — see `ChangeSummaryStatus`. */
  summaryBadge(text: string): Locator {
    return this.page.getByText(text, { exact: true });
  }

  /** Partial-apply banner — shown instead of the generic apply-failure banner when `applyRecord.partialApply` is `true`. */
  partialApplyBanner(): Locator {
    return this.page.getByRole('alert').filter({ hasText: 'Apply stopped partway through' });
  }

  /** Stale-lock recovery banner — shown instead of the BUSY/error banner when a plan/apply/destroy submission reports `ack.staleLock`. */
  staleLockBanner(): Locator {
    return this.page.getByRole('alert').filter({ hasText: 'Backend lock in the way' });
  }

  /**
   * "Clear lock and retry" action rendered inside the BUSY banner — only
   * present when a plan/apply/destroy submission's ack carries `runLock`
   * (a durable `RunLockHeldError`, apply/destroy only; `plan` never acquires
   * the durable lock). Opens a `ConfirmDialog`; the dialog's own confirm
   * button ("Clear lock") is not wrapped here since callers need direct
   * `page`/`win` access to scope it to the currently-open dialog.
   */
  clearRunLockButton(): Locator {
    return this.page.getByRole('button', { name: /clear lock and retry/i });
  }

  /**
   * The `ConfirmDialog`'s own confirm button ("Clear lock") — scoped by
   * exact match so it isn't confused with {@link clearRunLockButton}'s
   * "Clear lock and retry" trigger. Only meaningful once
   * {@link clearRunLockButton} has been clicked and the dialog is open.
   */
  confirmClearLockButton(): Locator {
    return this.page.getByRole('button', { name: 'Clear lock', exact: true });
  }

  /** Inline error/error-banner text shown when a submission was refused because the durable run lock is already held by another run. */
  runLockAlreadyHeldText(): Locator {
    return this.page.getByText(/Run lock already held/i);
  }

  /** Success toast shown once `hyveon.iac.runs.lock.clear()` reports `cleared: true`. */
  runLockClearedToast(): Locator {
    return this.page.getByText(/Run lock cleared/i);
  }

  // ── Approve ──────────────────────────────────────────────────────────

  /** Approve-plan button — enabled once the plan run reaches `awaiting_approval`. */
  approveButton(): Locator {
    return this.page.getByRole('button', { name: /Approve plan/ });
  }

  /** Re-approve button, shown only once an existing approval has expired. */
  reapproveButton(): Locator {
    return this.page.getByRole('button', { name: /Re-approve/ });
  }

  /** "Approved by <name> at <time>" text shown once the plan has been approved. */
  approvedText(): Locator {
    return this.page.getByText(/Approved by/);
  }

  /** Approval-expired staleness hint. */
  approvalExpiredText(): Locator {
    return this.page.getByText(/approval expired, re-approve to apply/);
  }

  // ── Apply ────────────────────────────────────────────────────────────

  /** Apply button — exact match so it isn't confused with "Run plan"/"Re-approve". */
  applyButton(): Locator {
    return this.page.getByRole('button', { name: 'Apply', exact: true });
  }

  /** Success banner shown once the apply run reaches a `success` status. */
  applyCompleteText(): Locator {
    return this.page.getByText('Apply complete.');
  }

  /** Link to the dashboard shown alongside the apply success banner. */
  dashboardLink(): Locator {
    return this.page.getByRole('link', { name: 'View dashboard' });
  }

  // ── Reset ────────────────────────────────────────────────────────────

  /** "Start over" button shown after a plan/apply run reaches a terminal state. */
  startOverButton(): Locator {
    return this.page.getByRole('button', { name: /Start over/ });
  }
}
