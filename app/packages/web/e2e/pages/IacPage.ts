import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the `/iac` route added in issue #110 — plan trigger,
 * live ANSI log viewer, resource-change summary, approve gate, and
 * plan-hash-gated apply.
 */
export class IacPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/iac` directly via URL. */
  async goto(): Promise<void> {
    await this.page.goto('/iac');
  }

  /**
   * Navigate to `/iac` by clicking the sidebar link and waiting for the
   * URL to settle. Exact-match, since Playwright's default name match is a
   * case-insensitive substring and other pages link out to
   * "Edit terraform.tfvars" (a GitHub help link), which would otherwise
   * collide with the sidebar's "Terraform" nav item.
   */
  async gotoViaSidebar(): Promise<void> {
    await this.page.getByRole('link', { name: 'Terraform', exact: true }).click();
    await this.page.waitForURL('**/iac');
  }

  // ── Plan ─────────────────────────────────────────────────────────────

  /** "Terraform" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Terraform' });
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

  /** Partial-apply banner (task 9.3) — shown instead of the generic apply-failure banner when `applyRecord.partialApply` is `true`. */
  partialApplyBanner(): Locator {
    return this.page.getByRole('alert').filter({ hasText: 'Apply stopped partway through' });
  }

  /** Stale-lock recovery banner (task 9.4) — shown instead of the BUSY/error banner when a plan/apply/destroy submission reports `ack.staleLock`. */
  staleLockBanner(): Locator {
    return this.page.getByRole('alert').filter({ hasText: 'Backend lock in the way' });
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
