/**
 * Electron e2e coverage for the first-run wizard's guided-IAM step
 * (`guided-iam-step.component.tsx`, `add-one-click-aws-bootstrap`). Task 8.2
 * of `docs/superpowers/plans/bootstrap-8-e2e-coverage.md` — the happy-path
 * guided-setup flow, launched against the REAL packaged Electron app (not a
 * jsdom/component-test shortcut).
 *
 * Follows `discord.spec.ts`'s structural pattern: a single `ElectronApplication`
 * shared across the whole describe block (`beforeAll`/`afterAll`), with each
 * test seeding its own `window.hyveon.__test.mock()` handlers via
 * `win.evaluate(...)` and clearing them in `afterEach`.
 *
 * Every `wizard.guidedIam.*` channel that would otherwise reach the real
 * `GuidedIamService` (and, through it, real AWS SDK clients) is mocked before
 * it is ever invoked — see the Global Constraints section of the plan this
 * spec implements. No real AWS call is possible from this spec.
 */
import type { ElectronApplication, Page } from '../fixtures/index.js';
import { test, expect, _electron, GuidedIamWizardPage } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';

// ── Shared Electron application ──────────────────────────────────────────────
//
// A single ElectronApplication is launched once for the whole describe block,
// matching `discord.spec.ts`. Each test seeds its own IPC mocks, drives the
// wizard UI, then `clearElectronMocks` in `afterEach` resets the registry so
// stale handlers never bleed into the next test.

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await _electron.launch({ args: [electronMain], env: electronEnv });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test.afterEach(async () => {
  await win.evaluate(() => {
    const hyveon = window.hyveon;
    if (!hyveon?.__test) throw new Error('window.hyveon.__test unavailable — is HYVEON_TEST_MODE set?');
    hyveon.__test.clearMocks();
  });
});

/** Region entered in this spec's guided-IAM flow — reused for every region field and echoed back in the post-rotation `wizard.state.get` mock. */
const TEST_REGION = 'us-west-2';

/** Fake `iam-bootstrap.yaml` path `wizard.guidedIam.prepareTemplate` resolves with — never a real filesystem path, since the real service call is fully mocked away. */
const FAKE_TEMPLATE_PATH = '/fake/path/iam-bootstrap.yaml';

/** AWS account ID `wizard.guidedIam.submitBootstrapKey` resolves with — an obviously-fake `sts:GetCallerIdentity` result, never a real one. */
const FAKE_ACCOUNT_ID = '123456789012';

/**
 * The exact profile name `GuidedIamService.rotate()` stores once guided
 * provisioning's mint-then-revoke rotation completes (`GUIDED_PROFILE_NAME`
 * in `GuidedIamService.ts`). Duplicated here (rather than imported) because
 * this string only needs to reach `win.evaluate`'s browser-context closure as
 * plain data — the credentials step compares against this exact literal, not
 * against a shared constant, so a hardcoded copy is enough to exercise the
 * real comparison.
 */
const GUIDED_PROFILE_NAME = 'hyveon-guided';

/**
 * Seeds every IPC channel the wizard shell and the guided-IAM step touch
 * before the operator has done anything: forces the wizard to show
 * (`wizard.state.get` → `wizardCompleted: false`), resumes directly onto the
 * guided-IAM step's region screen (`wizard.progress.get` resolves a
 * `guided-iam` step name with no `guidedIam` sub-state, so `GuidedIamStep`
 * starts fresh rather than resuming into a later screen), and no-ops the two
 * channels `FirstRunWizard` calls on every mount regardless of which step it
 * lands on (`wizard.listAwsProfiles`, `wizard.progress.save`).
 *
 * `wizard.state.get` is intentionally stateful: after guided provisioning's
 * rotation completes, the wizard shell re-reads `wizard.state.get()` to
 * decide whether the credentials step should render its "satisfied by guided
 * provisioning" summary (see `first-run-wizard.component.tsx`'s
 * `refreshGuidedCredentials`). Since this spec mocks `wizard.guidedIam.rotate`
 * directly, none of `GuidedIamService`'s real side effects (which would
 * normally persist `aws.profile = GUIDED_PROFILE_NAME` to the store) actually
 * run — so this mock flips its own returned `aws` field to the guided
 * profile itself, the moment the `wizard.guidedIam.rotate` mock (registered
 * separately per test) is invoked with a successful outcome.
 */
async function seedWizardShellMocks(win: Page, region: string): Promise<void> {
  await win.evaluate(
    ({ region, guidedProfileName }) => {
      const hyveon = window.hyveon;
      if (!hyveon?.__test) throw new Error('window.hyveon.__test unavailable — is HYVEON_TEST_MODE set?');

      let rotated = false;
      // Exposed so a later `guidedIamRotate` mock (registered per test) can
      // flip this closure's state once rotation actually completes.
      (window as unknown as { __markGuidedRotated: () => void }).__markGuidedRotated = () => {
        rotated = true;
      };

      hyveon.__test.mock('wizard.state.get', () =>
        Promise.resolve(
          rotated
            ? {
                wizardCompleted: false,
                activeCloud: 'aws',
                aws: { profile: guidedProfileName, region },
                bootstrap: undefined,
              }
            : { wizardCompleted: false, activeCloud: undefined, aws: undefined, bootstrap: undefined },
        ),
      );
      hyveon.__test.mock('wizard.progress.get', () => Promise.resolve({ step: 'guided-iam' }));
      hyveon.__test.mock('wizard.progress.save', () => Promise.resolve());
      hyveon.__test.mock('wizard.listAwsProfiles', () => Promise.resolve([]));
    },
    { region, guidedProfileName: GUIDED_PROFILE_NAME },
  );
}

// ── Specs ──────────────────────────────────────────────────────────────────────

test.describe('guided-IAM wizard step', () => {
  test('should complete the guided-setup happy path and hand off to the satisfied credentials step', async () => {
    await seedWizardShellMocks(win, TEST_REGION);

    await win.evaluate(
      ({ path, accountId }) => {
        const hyveon = window.hyveon;
        if (!hyveon?.__test) throw new Error('window.hyveon.__test unavailable — is HYVEON_TEST_MODE set?');

        hyveon.__test.mock('wizard.guidedIam.prepareTemplate', () => Promise.resolve({ path }));
        hyveon.__test.mock('wizard.guidedIam.openConsole', () => Promise.resolve({ opened: true }));
        hyveon.__test.mock('wizard.guidedIam.submitBootstrapKey', () => Promise.resolve({ accountId }));
        hyveon.__test.mock('wizard.guidedIam.rotate', () => {
          (window as unknown as { __markGuidedRotated: () => void }).__markGuidedRotated();
          return Promise.resolve({ status: 'complete' });
        });
      },
      { path: FAKE_TEMPLATE_PATH, accountId: FAKE_ACCOUNT_ID },
    );

    const wizard = new GuidedIamWizardPage(win);

    // Region/choice screen — the wizard resumes directly here per the seeded
    // `wizard.progress.get` mock, skipping pick-cloud entirely (out of scope
    // for this group — see the plan's Global Constraints).
    await expect(wizard.regionInput()).toBeVisible();
    await wizard.regionInput().fill(TEST_REGION);
    await wizard.continueWithGuidedSetupButton().click();

    // Template screen — `wizard.guidedIam.prepareTemplate` resolves the fake
    // path automatically on entering this phase.
    await expect(wizard.templatePathInput()).toHaveValue(FAKE_TEMPLATE_PATH);

    await wizard.openConsoleButton().click();
    await expect(wizard.consoleOpenedConfirmation()).toBeVisible();

    await wizard.continueToKeyEntryButton().click();

    // Key-intake screen.
    await expect(wizard.accessKeyIdInput()).toBeVisible();
    await wizard.accessKeyIdInput().fill('AKIAFAKEBOOTSTRAPKEY');
    await wizard.secretAccessKeyInput().fill('fake-secret-access-key-value');
    await wizard.submitBootstrapKeyButton().click();

    // Rotation resolves `{ status: 'complete' }` (mocked above), which
    // advances the wizard past guided-iam onto the credentials step — assert
    // the real rendered "satisfied by guided provisioning" summary, not just
    // the absence of an error.
    await expect(wizard.satisfiedByGuidedProvisioningSummary()).toBeVisible();
    await expect(wizard.stepProgressText('AWS credentials')).toBeVisible();
  });
});
