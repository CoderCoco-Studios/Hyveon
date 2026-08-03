/**
 * Electron e2e coverage for the first-run wizard's guided-IAM step
 * (`guided-iam-step.component.tsx`, `add-one-click-aws-bootstrap`). Tasks 8.2
 * and 8.3 of `docs/superpowers/plans/bootstrap-8-e2e-coverage.md` — the
 * happy-path guided-setup flow and the rotation-pending resume flow,
 * launched against the REAL packaged Electron app (not a jsdom/component-test
 * shortcut).
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
 * `wizard.aws.listProfiles`) plus the four `wizard.guidedIam.*` channels this
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
    // Channel is `wizard.aws.listProfiles` (see `preload.ts`'s `wizard.listAwsProfiles()`
    // binding) — the shell's own profile-list fetch fires unconditionally on
    // `FirstRunWizard` mount regardless of which step it resumes to, so this
    // must be mocked even though this step never renders the profile picker.
    hyveon.__test.mock('wizard.aws.listProfiles', () => Promise.resolve([]));

    hyveon.__test.mock('wizard.guidedIam.prepareTemplate', () => Promise.resolve({ path: templatePath }));
    hyveon.__test.mock('wizard.guidedIam.openConsole', () => Promise.resolve({ opened: true }));
    hyveon.__test.mock('wizard.guidedIam.submitBootstrapKey', () => Promise.resolve({ accountId }));
    hyveon.__test.mock('wizard.guidedIam.rotate', () => {
      rotated = true;
      return Promise.resolve({ status: 'complete' });
    });
  }, opts);
}

/** Region filled into the resume test's intake screen — deliberately distinct from {@link TEST_REGION} so the two tests' fixtures can never be mistaken for shared state. */
const RESUMED_REGION = 'eu-west-1';

/**
 * Seeds the IPC channels the rotation-pending RESUME flow drives: the same
 * wizard-shell channels as {@link seedGuidedIamHappyPathMocks} above, but
 * `wizard.progress.get` returns a persisted `rotation-pending` sub-state
 * (`{ step: 'guided-iam', guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true } }`)
 * instead of a bare `{ step: 'guided-iam' }` — exactly what a real relaunch
 * would read back from `wizard-state.json` after a prior session's
 * `submitBootstrapKey` succeeded but quit before rotation settled.
 *
 * `wizard.state.get` deliberately omits `aws.region` before rotation
 * completes: `guided-iam-step.component.tsx`'s own resume-effect comment
 * notes a `rotation-pending` resume's region is "almost always still unset"
 * (rotation never reached the step that persists it), so this mirrors that
 * and lets the spec also exercise re-filling the intake screen's inline
 * region field by hand.
 *
 * `wizard.guidedIam.prepareTemplate`/`openConsole` are mocked to reject
 * rather than left unmocked. Per the plan's Global Constraints, an unmocked
 * channel falls through to the real IPC transport and could reach the real
 * `GuidedIamService`. Neither call should ever fire on this resume path — the
 * template screen must never mount — so rejecting closes that hole even
 * though it is not, by itself, a loud failure: the component catches the
 * rejection and renders it as inline `templateError` UI
 * (`guided-iam-step.component.tsx`'s `template`-phase branch), the same as a
 * real failed render would. The rejection's only job is to guarantee no real
 * IPC call is possible; the test's own assertions (see the spec below) are
 * what actually prove the template phase never mounted.
 */
async function seedGuidedIamRotationPendingResumeMocks(
  win: Page,
  opts: { region: string; guidedProfileName: string; accountId: string },
): Promise<void> {
  await win.evaluate(({ region, guidedProfileName, accountId }) => {
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
    hyveon.__test.mock('wizard.progress.get', () =>
      Promise.resolve({ step: 'guided-iam', guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true } }),
    );
    hyveon.__test.mock('wizard.progress.save', () => Promise.resolve());
    hyveon.__test.mock('wizard.aws.listProfiles', () => Promise.resolve([]));

    hyveon.__test.mock('wizard.guidedIam.prepareTemplate', () =>
      Promise.reject(new Error('prepareTemplate must not be called when resuming a rotation-pending session')),
    );
    hyveon.__test.mock('wizard.guidedIam.openConsole', () =>
      Promise.reject(new Error('openConsole must not be called when resuming a rotation-pending session')),
    );
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

  test('should resume directly onto the key-intake screen for a persisted rotation-pending session', async () => {
    await seedGuidedIamRotationPendingResumeMocks(win, {
      region: RESUMED_REGION,
      guidedProfileName: GUIDED_PROFILE_NAME,
      accountId: FAKE_ACCOUNT_ID,
    });

    const wizard = new GuidedIamWizardPage(win);

    // The resumed mount jumps straight to the key-intake-and-rotate screen —
    // this is the e2e-level proof of Group 7's fix round. The core guarantee
    // comes from `guidedIamStep`'s render being a mutually-exclusive
    // `if (phase === X) return (...)` chain: only one phase's markup can ever
    // be in the DOM at a time, so the positive assertions just below
    // (`resumedRotationPendingBanner`/`accessKeyIdInput`/`secretAccessKeyInput`,
    // all `intake`-only) already fail on their own if any other phase
    // rendered instead. The negative checks add specific, independent proof
    // for the two phases a regressed resume could plausibly land on instead:
    // - `region` phase renders `continueWithGuidedSetupButton`/
    //   `alreadyHaveCredentialsButton` unconditionally (no `templatePath`
    //   gating), so their absence is a direct, reliable negative.
    // - `template` phase, if reached, would call the mocked (rejecting)
    //   `prepareTemplate` and settle into its `templateError` branch, which
    //   renders `retryTemplateButton` and an `errorAlert` — NOT
    //   `templatePathInput`/`openConsoleButton`/`continueToKeyEntryButton`,
    //   which are gated on `templatePath` and can never appear given this
    //   test's mocks regardless of which phase is mounted. Asserting those
    //   three would prove nothing; `retryTemplateButton`/`errorAlert` are the
    //   elements that actually distinguish "template phase, errored" from
    //   this test's expected clean intake state.
    await expect(wizard.resumedRotationPendingBanner()).toBeVisible();
    await expect(wizard.accessKeyIdInput()).toBeVisible();
    await expect(wizard.secretAccessKeyInput()).toBeVisible();

    await expect(wizard.continueWithGuidedSetupButton()).toHaveCount(0);
    await expect(wizard.alreadyHaveCredentialsButton()).toHaveCount(0);
    await expect(wizard.retryTemplateButton()).toHaveCount(0);
    await expect(wizard.errorAlert()).toHaveCount(0);

    // The intake screen's inline region field starts blank on this path —
    // the mocked `wizard.state.get()` has no recoverable `aws.region` before
    // rotation completes (see the helper's own doc comment) — so fill it
    // before submitting, exercising the resume-path's own region field
    // rather than the region/choice screen's.
    await wizard.regionInput().fill(RESUMED_REGION);
    await wizard.accessKeyIdInput().fill('AKIAFAKERESUMEDKEY');
    await wizard.secretAccessKeyInput().fill('fake-secret-resumed-key-value');
    await wizard.submitBootstrapKeyButton().click();

    // Rotation resolves `{ status: 'complete' }` (mocked above), which
    // advances the resumed session past guided-iam onto the credentials
    // step, exactly like the happy path — confirming the persisted
    // sub-state survives a relaunch all the way to a successful finish.
    await expect(wizard.satisfiedByGuidedProvisioningSummary()).toBeVisible();
    await expect(wizard.stepProgressText('AWS credentials')).toBeVisible();
  });
});
