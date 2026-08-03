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
import { GUIDED_PROFILE_NAME } from '@hyveon/desktop-preload';
import type { ElectronApplication, Page } from '../fixtures/index.js';
import { test, expect, _electron, GuidedIamWizardPage, clearElectronMocks } from '../fixtures/index.js';
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
  await clearElectronMocks(win);
});

/** Region entered in this spec's guided-IAM flow — reused for every region field and echoed back in the post-rotation `wizard.state.get` mock. */
const TEST_REGION = 'us-west-2';

/** Fake `iam-bootstrap.yaml` path `wizard.guidedIam.prepareTemplate` resolves with — never a real filesystem path, since the real service call is fully mocked away. */
const FAKE_TEMPLATE_PATH = '/fake/path/iam-bootstrap.yaml';

/** AWS account ID `wizard.guidedIam.submitBootstrapKey` resolves with — an obviously-fake `sts:GetCallerIdentity` result, never a real one. */
const FAKE_ACCOUNT_ID = '123456789012';

/**
 * Seeds every IPC channel the happy-path guided-IAM flow touches, in a single
 * `win.evaluate` call: the wizard-shell channels `FirstRunWizard` invokes on
 * every mount (`wizard.state.get`, `wizard.progress.get`, `wizard.progress.save`,
 * `wizard.listAwsProfiles`) plus the four `wizard.guidedIam.*` channels this
 * step's happy path drives.
 *
 * `wizard.state.get` starts by forcing the wizard to show (`wizardCompleted` `false`,
 * no `aws`) and becomes stateful once rotation completes: the wizard
 * shell re-reads `wizard.state.get()` from `first-run-wizard.component.tsx`'s
 * `refreshGuidedCredentials()` right after `GuidedIamStep`'s `onComplete`
 * fires, to decide whether the credentials step renders its "satisfied by
 * guided provisioning" summary. Since `wizard.guidedIam.rotate` is mocked
 * directly here, none of `GuidedIamService`'s real store-writing side effects
 * run — so the `rotate` mock flips a `rotated` flag itself, and `wizard.state.get`
 * reads that same flag, both declared in this one evaluate's closure so
 * nothing needs to be smuggled across separate `win.evaluate` calls.
 *
 * `wizard.progress.get` resolves `{ step: 'guided-iam' }` with no `guidedIam`
 * sub-state — this resumes the wizard shell directly onto the guided-IAM step
 * (skipping `pick-cloud`, out of scope for this group per the plan) while
 * leaving `GuidedIamStep` itself to start fresh at the region screen.
 */
async function seedGuidedIamHappyPathMocks(
  win: Page,
  opts: { region: string; guidedProfileName: string; templatePath: string; accountId: string },
): Promise<void> {
  await win.evaluate(({ region, guidedProfileName, templatePath, accountId }) => {
    const hyveon = window.hyveon;
    if (!hyveon?.__test) throw new Error('window.hyveon.__test unavailable — is HYVEON_TEST_MODE set?');

    let rotated = false;

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

    hyveon.__test.mock('wizard.guidedIam.prepareTemplate', () => Promise.resolve({ path: templatePath }));
    hyveon.__test.mock('wizard.guidedIam.openConsole', () => Promise.resolve({ opened: true }));
    hyveon.__test.mock('wizard.guidedIam.submitBootstrapKey', () => Promise.resolve({ accountId }));
    hyveon.__test.mock('wizard.guidedIam.rotate', () => {
      rotated = true;
      return Promise.resolve({ status: 'complete' });
    });
  }, opts);
}

// ── Specs ──────────────────────────────────────────────────────────────────────

test.describe('guided-IAM wizard step', () => {
  test('should complete the guided-setup happy path and hand off to the satisfied credentials step', async () => {
    await seedGuidedIamHappyPathMocks(win, {
      region: TEST_REGION,
      guidedProfileName: GUIDED_PROFILE_NAME,
      templatePath: FAKE_TEMPLATE_PATH,
      accountId: FAKE_ACCOUNT_ID,
    });

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
