import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the first-run wizard's guided-IAM step
 * (`guided-iam-step.component.tsx`, `add-one-click-aws-bootstrap`). The
 * wizard itself renders in place of the whole app when `wizard.state.get`
 * reports `wizardCompleted: false` — there is no route to navigate to, a
 * spec just launches the app with that mock in place and the wizard is
 * already mounted at `/`.
 *
 * Scope: every locator this step's own screens need (region/choice,
 * template, key intake/rotation, verification-failed, delete-failed), plus a
 * handful of minimal locators on the shared wizard shell (`first-run-wizard.component.tsx`)
 * needed only to get from the wizard's start into this step and to confirm
 * it hands off correctly to the credentials step afterwards. It deliberately
 * does NOT wrap the `pick-cloud`/`credentials`/`bootstrap`/`stack-init`
 * steps' own internals — those have never had Electron e2e coverage and
 * building it out is out of scope for this change (see
 * `docs/superpowers/plans/bootstrap-8-e2e-coverage.md`'s Global Constraints).
 */
export class GuidedIamWizardPage {
  constructor(public readonly page: Page) {}

  // ── Shared wizard shell (minimal navigation only) ────────────────────

  /**
   * The shell's "Step X of Y: \{label\}" progress text for a given step label
   * (e.g. `'Provision AWS access'` for this step, `'AWS credentials'` for
   * the step it hands off to) — the cheapest way to confirm which step is
   * currently mounted without a dedicated page object for every step.
   */
  stepProgressText(label: string): Locator {
    return this.page.getByText(new RegExp(`Step \\d+ of \\d+: ${label}`));
  }

  /** The pick-cloud step's "Amazon Web Services (AWS)" radio option — the only choice in v1, selected by default. */
  awsCloudOption(): Locator {
    return this.page.getByRole('radio', { name: /Amazon Web Services \(AWS\)/i });
  }

  /** The shared wizard footer's "Next" button, used to advance past `pick-cloud` into this step. */
  nextButton(): Locator {
    return this.page.getByRole('button', { name: 'Next' });
  }

  /**
   * The credentials step's "satisfied by guided provisioning" summary text,
   * rendered in place of the normal profile-picker/paste form once
   * `wizard.state.get()`'s `aws.profile` equals `GUIDED_PROFILE_NAME` — this
   * is the direct downstream effect of completing this step's rotation, so
   * it lives here rather than in a dedicated credentials-step page object.
   */
  satisfiedByGuidedProvisioningSummary(): Locator {
    return this.page.getByText(/already provisioned and activated AWS credentials during guided setup/i);
  }

  // ── Region / choice screen ────────────────────────────────────────────

  /**
   * The "AWS region" labelled input. Shared by both the region/choice
   * screen (`id="wizard-guided-iam-region"`) and the key-intake screen
   * (`id="wizard-guided-iam-intake-region"`) — only one is ever mounted at
   * a time, so a single label-based locator covers both.
   */
  regionInput(): Locator {
    return this.page.getByLabel('AWS region');
  }

  /** "Continue with guided setup" button — commits the region and moves to the template screen. */
  continueWithGuidedSetupButton(): Locator {
    return this.page.getByRole('button', { name: 'Continue with guided setup' });
  }

  /** "I already have credentials" button — skips guided provisioning entirely and advances straight to the credentials step. */
  alreadyHaveCredentialsButton(): Locator {
    return this.page.getByRole('button', { name: 'I already have credentials' });
  }

  /**
   * Explanatory note shown when a resume attempt (`template-written` or
   * `awaiting-key-intake` sub-state) found no recoverable region and fell
   * back to this screen instead of the template/intake screen it resumed
   * toward.
   */
  resumedWithoutRegionNote(): Locator {
    return this.page.getByText(/Resuming a previous session — re-enter your AWS region/i);
  }

  // ── Template screen ───────────────────────────────────────────────────

  /** Spinner + "Rendering the CloudFormation template…" shown while `guidedIamPrepareTemplate()` is in flight. */
  preparingTemplateIndicator(): Locator {
    return this.page.getByText(/Rendering the CloudFormation template/i);
  }

  /** The template screen's "Retry" button, shown when `guidedIamPrepareTemplate()` fails. */
  retryTemplateButton(): Locator {
    return this.page.getByRole('button', { name: 'Retry' });
  }

  /** The read-only "Template path" input showing the rendered `iam-bootstrap.yaml` path. */
  templatePathInput(): Locator {
    return this.page.getByLabel('Template path');
  }

  /** The icon-only "Copy template path" button (identified by its `aria-label`) next to the template path input. */
  copyPathButton(): Locator {
    return this.page.getByRole('button', { name: 'Copy template path' });
  }

  /** Confirmation text ("Path copied.") shown after a successful clipboard write. */
  pathCopiedConfirmation(): Locator {
    return this.page.getByText('Path copied.');
  }

  /** "Open AWS Console" button — calls `guidedIamOpenConsole()` for the entered region. */
  openConsoleButton(): Locator {
    return this.page.getByRole('button', { name: 'Open AWS Console' });
  }

  /** Confirmation text shown when `guidedIamOpenConsole()` resolves `{ opened: true }`. */
  consoleOpenedConfirmation(): Locator {
    return this.page.getByText('Opened in your default browser.');
  }

  /** Fallback explanatory text shown when `guidedIamOpenConsole()` resolves `{ opened: false, url }` instead of actually opening a browser. */
  consoleUrlFallbackNote(): Locator {
    return this.page.getByText(/Could not open a browser automatically/i);
  }

  /**
   * The read-only fallback input displaying the console URL as selectable
   * text when `guidedIamOpenConsole()` could not open a browser. Has no
   * accessible label of its own (unlike the template path input above), so
   * this is scoped by its known ordering: it is the second `readonly`
   * input on the template screen, always rendered after the template path
   * input once `consoleUrl` is set.
   */
  consoleUrlFallbackInput(): Locator {
    return this.page.locator('input[readonly]').nth(1);
  }

  /** "Continue to key entry" button — moves from the template screen to the key-intake screen. */
  continueToKeyEntryButton(): Locator {
    return this.page.getByRole('button', { name: 'Continue to key entry' });
  }

  // ── Key intake / rotation screen ──────────────────────────────────────

  /**
   * Resume banner shown only when this mount resumed directly onto the
   * intake screen via `subState: 'rotation-pending'` — "A bootstrap key was
   * previously submitted, but rotation didn't finish before Hyveon closed."
   */
  resumedRotationPendingBanner(): Locator {
    return this.page.getByText(/previously submitted, but rotation didn't finish/i);
  }

  /** The "Access key ID" labelled input on the key-intake form. */
  accessKeyIdInput(): Locator {
    return this.page.getByLabel('Access key ID');
  }

  /** The "Secret access key" labelled (password) input on the key-intake form. */
  secretAccessKeyInput(): Locator {
    return this.page.getByLabel('Secret access key');
  }

  /** "Validate and rotate key" submit button — kicks off `guidedIamSubmitBootstrapKey()` then `guidedIamRotate()`. */
  submitBootstrapKeyButton(): Locator {
    return this.page.getByRole('button', { name: 'Validate and rotate key' });
  }

  /** Spinner + "Rotating your AWS credentials…" shown while `guidedIamRotate()` is in flight. */
  rotatingIndicator(): Locator {
    return this.page.getByText(/Rotating your AWS credentials/i);
  }

  // ── Verification-failed screen ────────────────────────────────────────

  /** "Retry rotation" button — reruns `guidedIamRotate()` with the same in-memory bootstrap key. */
  retryRotationButton(): Locator {
    return this.page.getByRole('button', { name: 'Retry rotation' });
  }

  // ── Delete-failed screen ──────────────────────────────────────────────

  /** The amber "new key is active, but the bootstrap key is still active too" warning text. */
  deleteFailedWarning(): Locator {
    return this.page.getByText(/new key is active, but the bootstrap key is still active too/i);
  }

  /** The IAM console link for manually revoking the still-live bootstrap key, matched by its `consoleUrl` text (the link's `href` and visible text are the same string). */
  revokeConsoleLink(consoleUrl: string): Locator {
    return this.page.getByRole('link', { name: consoleUrl });
  }

  /** "Revoke now" button — calls `guidedIamRevokeBootstrapKey()` for the in-memory bootstrap key. */
  revokeNowButton(): Locator {
    return this.page.getByRole('button', { name: 'Revoke now' });
  }

  // ── Errors (shared across screens) ────────────────────────────────────

  /**
   * The single `role="alert"` error message for whichever screen is
   * currently showing one (region validation, template render failure,
   * console-open failure, key-intake validation, rotation/verification
   * failure, or revoke failure) — each screen renders at most one `alert`
   * at a time, so this stays unambiguous without a locator per error site.
   */
  errorAlert(): Locator {
    return this.page.getByRole('alert');
  }
}
