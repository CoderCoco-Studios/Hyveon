# Arrow: wizard-and-bootstrap

First launch and Reconfigure: connect an AWS account (guided IAM or keys), pick a region, create the buckets and runs table, check permissions, and keep those credentials safe afterwards.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.

Feature-complete against its six OpenSpec capabilities except the in-app key rotation path, which exists in the service layer with no caller; the leaf also owns credential custody (`ElectronStoreService`, `SafeStorageService`, `awsCredentialSource.ts`, client caches) that every AWS-calling leaf depends on.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`

### EARS
- `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md` (150 specs)

### Tests
- `app/packages/desktop-main/src/cloudformationTemplate.test.ts`
- `app/packages/desktop-main/src/controllers/cloud-health.controller.test.ts`
- `app/packages/desktop-main/src/controllers/wizard.controller.test.ts`
- `app/packages/desktop-main/src/services/AwsProfileService.test.ts`
- `app/packages/desktop-main/src/services/BootstrapService.test.ts`
- `app/packages/desktop-main/src/services/CloudHealthService.test.ts`
- `app/packages/desktop-main/src/services/ElectronStoreService.test.ts`
- `app/packages/desktop-main/src/services/FirstRunWizardService.test.ts`
- `app/packages/desktop-main/src/services/GuidedIamService.test.ts`
- `app/packages/desktop-main/src/services/IamCheckService.test.ts`
- `app/packages/desktop-main/src/services/SafeStorageService.test.ts`
- `app/packages/desktop-main/src/services/awsCredentialSource.test.ts`
- `app/packages/desktop-main/src/services/guided-iam-rotation-integration.test.ts`
- `app/packages/desktop-main/src/services/verifyAccessKeyWithRetry.test.ts`
- `app/packages/desktop-main/src/services/__fixtures__/aws-profile/.aws/config` (fixture)
- `app/packages/desktop-main/src/services/__fixtures__/aws-profile/.aws/credentials` (fixture)
- `app/packages/shared/src/iamPolicy.test.ts`
- `app/packages/web/e2e/integration-specs/guided-iam.spec.ts`
- `app/packages/web/e2e/specs/guided-iam-wizard.spec.ts`
- `app/packages/web/e2e/pages/GuidedIamWizardPage.ts` (page object)
- `app/packages/web/src/components/cloud-health-section.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/bootstrap-step.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/credentials-step.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/first-run-wizard.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-step.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/pick-cloud-step.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx`
- `app/packages/web/src/components/first-run-wizard/wizard.utils.test.ts`

### Code

**@hyveon/desktop-main**
- `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`
- `app/packages/desktop-main/src/cloudformationTemplate.ts`
- `app/packages/desktop-main/src/controllers/wizard.controller.ts`
- `app/packages/desktop-main/src/controllers/cloud-health.controller.ts`
- `app/packages/desktop-main/src/modules/wizard.module.ts`
- `app/packages/desktop-main/src/modules/electron-store.module.ts`
- `app/packages/desktop-main/src/services/FirstRunWizardService.ts`
- `app/packages/desktop-main/src/services/GuidedIamService.ts`
- `app/packages/desktop-main/src/services/verifyAccessKeyWithRetry.ts`
- `app/packages/desktop-main/src/services/sleep.ts`
- `app/packages/desktop-main/src/services/AwsProfileService.ts`
- `app/packages/desktop-main/src/services/BootstrapService.ts`
- `app/packages/desktop-main/src/services/IamCheckService.ts`
- `app/packages/desktop-main/src/services/CloudHealthService.ts`
- `app/packages/desktop-main/src/services/ElectronStoreService.ts`
- `app/packages/desktop-main/src/services/SafeStorageService.ts`
- `app/packages/desktop-main/src/services/awsCredentialSource.ts`
- `app/packages/desktop-main/src/services/awsClientCache.ts`

**@hyveon/cloud-aws**
- `app/packages/cloud-aws/src/cachedClient.ts`
- `app/packages/cloud-aws/src/awsRegionEnv.ts`

**@hyveon/shared**
- `app/packages/shared/src/wizardSteps.ts`
- `app/packages/shared/src/iamPolicy.ts`
- `app/packages/shared/src/awsRegions.ts` (generated)

**@hyveon/web**
- `app/packages/web/src/components/first-run-wizard/first-run-wizard.component.tsx`
- `app/packages/web/src/components/first-run-wizard/use-wizard-progress.hook.ts`
- `app/packages/web/src/components/first-run-wizard/use-reconfigure-answers.hook.ts`
- `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx`
- `app/packages/web/src/components/first-run-wizard/wizard.utils.ts`
- `app/packages/web/src/components/first-run-wizard/pick-cloud-step.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-region-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-template-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-intake-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-verification-failed-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/guided-iam-delete-failed-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/use-guided-iam.hook.ts`
- `app/packages/web/src/components/first-run-wizard/credentials-step.component.tsx`
- `app/packages/web/src/components/first-run-wizard/use-aws-credentials-form.hook.ts`
- `app/packages/web/src/components/first-run-wizard/bootstrap-step.component.tsx`
- `app/packages/web/src/components/first-run-wizard/use-bootstrap-resources.hook.ts`
- `app/packages/web/src/components/first-run-wizard/iam-check-panel.component.tsx`
- `app/packages/web/src/components/cloud-health-section.component.tsx`

**Outside `app/packages`**
- `build/generate-aws-regions.mjs` (regenerates `awsRegions.ts`)

### Cited from other leaves
- `iac/engine`: `app/packages/web/src/components/first-run-wizard/stack-init-step.component.tsx` (the wizard's final step, `iac.stack.initialize` then `wizard.complete`), `app/packages/desktop-main/src/services/PulumiService.ts` (`initializeStack`), `app/packages/desktop-main/src/services/ConfigService.ts` (`getRegion()` used by `CloudHealthService`), `app/packages/desktop-main/src/services/electronRuntime.ts` (`readIsPackaged`, imported at `GuidedIamService.ts:12` and `CloudHealthService.ts:12`).
- `operator-app/desktop-shell`: `app/packages/web/src/app.component.tsx` (first-run gate on `wizard.state.get`, `:40-60`), `app/packages/web/src/pages/settings.page.tsx` (Reconfigure button and Cloud Health section host), `app/packages/desktop-main/src/app.module.ts` (registers `WizardController`/`CloudHealthController`), `app/packages/desktop-main/src/modules/cloud-provider.module.ts` (store factories that consume `awsCredentialSource`).
- `operator-app/ipc-bridge`: `app/packages/desktop-preload/src/hyveon-api.ts` (`window.hyveon.wizard.*`, `cloudHealth.*`, and the duplicate `GUIDED_PROFILE_NAME` at `:2107`), `app/packages/desktop-main/src/env.ts` (`isTestMode`).
- `deployment-config`: `shared` `DEPLOYMENT_CONFIG_DEFAULTS` / `resolveRunsTableName` (`wizard.controller.ts:3,310`), `DeploymentConfigModule` (imported by `wizard.module.ts:31` for `CloudHealthService`'s project name).
- `game-server`: `GameWizardDraftService.ts` uses the `addGameWizardDraft` slot that `ElectronStoreService` declares.
- Unassigned repo gates: `app/eslint.config.js:114-198` (renderer `@aws-sdk/*` import ban backing cloud-bootstrap), `docs/docs/setup.md` (the `HyveonDeployAll` oracle `iamPolicy.test.ts` checks against).

### OpenSpec sources
- `openspec/specs/wizard-flow/spec.md` (synced main spec)
- `openspec/specs/guided-iam-provisioning/spec.md` (synced main spec)
- `openspec/specs/guided-region-selection/spec.md` (synced main spec)
- `openspec/specs/aws-credentials/spec.md` (synced main spec)
- `openspec/specs/cloud-bootstrap/spec.md` (synced main spec)
- `openspec/specs/aws-cloud-health/spec.md` (synced main spec; Purpose still TBD)
- Active changes: none mapped to this leaf in §7. Source changes are archived (`archive/2026-08-10-add-one-click-aws-bootstrap`, `2026-08-05-first-run-wizard-region-dropdown`, `2026-08-11-aws-cloud-health-checks`).

## Architecture

**Purpose:** Take a fresh install to a usable, credentialed AWS account (guided IAM via CloudFormation or an existing profile or pasted keys, a region, the state bucket, configuration bucket, seeded `deployment-config.json` and runs table, an advisory IAM simulation), hand off to stack init, and then hold the resulting credentials so every AWS caller in the main process resolves them the same way.

**Key Components:**
1. `FirstRunWizard` (`app/packages/web/.../first-run-wizard.component.tsx:69`) — five-step shell over `WIZARD_STEPS` (`app/packages/shared/src/wizardSteps.ts:9`: pick-cloud, guided-iam, credentials, bootstrap, stack-init), first-run and Reconfigure modes, resume via `use-wizard-progress.hook.ts`, edit-only commits via `use-reconfigure-answers.hook.ts`.
2. `WizardController` (`app/packages/desktop-main/src/controllers/wizard.controller.ts:122`) — 18 `wizard.*` `@MessagePattern` channels: state, progress, profiles/paste, guided IAM, bootstrap resources, IAM check, complete/reset.
3. `FirstRunWizardService` (`services/FirstRunWizardService.ts:57`) — resumable progress in `userData/wizard-state.json`, `complete()`, operator `reset()` (`:200-208`).
4. `GuidedIamService` (`services/GuidedIamService.ts:165`) — renders `iam-bootstrap.yaml` with `generateHyveonDeployAllPolicy()` (`:200-215`), builds the CloudFormation console URL (`:238`), validates the bootstrap key (`:325`), then mint, verify, store as `hyveon-guided`, delete old (`rotate`, `:414`), plus manual revoke (`:567`).
5. `app/packages/shared/src/iamPolicy.ts` — `HYVEON_DEPLOY_ALL_ACTIONS` (`:9`) and `HYVEON_DEPLOY_ALL_STATEMENTS` (`:79`), the generators (`:200`, `:243`), test-locked to `docs/docs/setup.md`.
6. `AwsProfileService` (`services/AwsProfileService.ts:135`) — lists `~/.aws` profiles, saves pasted keys as `hyveon-pasted` (keychain-gated, `:183`), `rotateActiveCredentials()` (`:267`).
7. `BootstrapService` (`services/BootstrapService.ts:105`) — SDK-direct, idempotent `ensureStateBucket` (`:123`), `ensureConfigurationBucket` (`:185`), `ensureDeploymentConfig` (`:313`), `ensureRunsTable` (`:408`).
8. `IamCheckService.checkPermissions` (`services/IamCheckService.ts:125`) — STS identity plus batched `SimulatePrincipalPolicy` over the deploy action set; blocking only on the guided path.
9. `CloudHealthService` (`services/CloudHealthService.ts:63`) + `CloudHealthController` (`controllers/cloud-health.controller.ts:21`) + `cloud-health-section.component.tsx` — Settings-page ECS service-linked-role check with Fix and policy-JSON fallback.
10. Credential custody: `ElectronStoreService` (`services/ElectronStoreService.ts:304`, typed electron-store), `SafeStorageService` (`services/SafeStorageService.ts:24`, OS keychain), `awsCredentialSource.ts` (`resolveAwsCredentialSource` `:93`, `resolveAwsClientCredentialsWithSignature` `:177`), and the signature-keyed client caches `awsClientCache.ts:35` / `cloud-aws/src/cachedClient.ts:35`.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `wizard-flow` | 10 | 26 | State-file name and step order inconsistent inside the spec (finding 9); Purpose omits guided IAM, engine version and layout. Stack-init requirement is satisfied by `iac/engine`'s `stack-init-step`. |
| `guided-iam-provisioning` | 5 | 14 | Implemented in `GuidedIamService` + guided-IAM screens; rotation-pending resume overlaps `wizard-flow` (`:65-73`). |
| `guided-region-selection` | 3 | 6 | `app/packages/shared/src/awsRegions.ts` + `guided-iam-region-screen`; sweep reports sovereign/local-zone entries contrary to the exclusion rule `[unverified]`. |
| `aws-credentials` | 4 | 12 | "In-app access key rotation" (`:47-59`) is implemented in `AwsProfileService` but unreachable from any IPC channel (finding 3). Header lacks the "Specification" suffix. |
| `cloud-bootstrap` | 8 | 21 | ECS service-linked-role policy requirement (`:134-157`) is the policy half of `aws-cloud-health`. |
| `aws-cloud-health` | 3 | 10 | Purpose is still TBD. Only the ECS SLR check exists. |

**OpenSpec summary:** 33 requirements and 89 scenarios across six synced OpenSpec capabilities; no active changes.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Launch gating and completion | `APP-WIZARD-GATE-001` to `APP-WIZARD-GATE-006` | 4 | 0 | 1 |
| Resumable progress | `APP-WIZARD-PROG-001` to `APP-WIZARD-PROG-008` | 8 | 0 | 0 |
| Pick-cloud step | `APP-WIZARD-CLOUD-001` to `APP-WIZARD-CLOUD-003` | 3 | 0 | 0 |
| Wizard shell layout and sidebar | `APP-WIZARD-SHELL-001` to `APP-WIZARD-SHELL-008` | 8 | 0 | 0 |
| Start over (first-run reset) | `APP-WIZARD-RESET-001` to `APP-WIZARD-RESET-003` | 3 | 0 | 0 |
| Reconfigure | `APP-WIZARD-RECONF-001` to `APP-WIZARD-RECONF-009` | 6 | 0 | 3 |
| Stack initialization step (code owned by iac/engine) | `APP-WIZARD-STACK-001` to `APP-WIZARD-STACK-004` | 4 | 0 | 0 |
| Guided IAM step in the wizard | `APP-WIZARD-GSTEP-001` to `APP-WIZARD-GSTEP-006` | 5 | 0 | 1 |
| Guided IAM CloudFormation template | `APP-WIZARD-TMPL-001` to `APP-WIZARD-TMPL-011` | 10 | 0 | 1 |
| Guided IAM console handoff | `APP-WIZARD-CONSOLE-001` to `APP-WIZARD-CONSOLE-006` | 5 | 1 | 0 |
| Guided IAM bootstrap key intake | `APP-WIZARD-INTAKE-001` to `APP-WIZARD-INTAKE-006` | 5 | 0 | 1 |
| Guided IAM mandatory rotation | `APP-WIZARD-ROTATE-001` to `APP-WIZARD-ROTATE-008` | 7 | 0 | 1 |
| Keychain requirement for guided and pasted credentials | `APP-WIZARD-KEYCH-001` to `APP-WIZARD-KEYCH-003` | 2 | 0 | 1 |
| Region selection (guided IAM) | `APP-WIZARD-REGION-001` to `APP-WIZARD-REGION-005` | 5 | 0 | 0 |
| One region per install | `APP-WIZARD-REGLOCK-001` | 0 | 0 | 1 |
| AWS credentials step | `APP-WIZARD-CREDS-001` to `APP-WIZARD-CREDS-011` | 9 | 0 | 2 |
| In-app access key rotation (non-guided) | `APP-WIZARD-ROTKEY-001` to `APP-WIZARD-ROTKEY-005` | 4 | 0 | 1 |
| Backend bootstrap | `APP-WIZARD-BOOT-001` to `APP-WIZARD-BOOT-016` | 14 | 0 | 2 |
| IAM permission check | `APP-WIZARD-IAMCHK-001` to `APP-WIZARD-IAMCHK-009` | 7 | 0 | 2 |
| HyveonDeployAll policy generator | `APP-WIZARD-POLICY-001` to `APP-WIZARD-POLICY-004` | 4 | 0 | 0 |
| Cloud Health (Settings) | `APP-WIZARD-HEALTH-001` to `APP-WIZARD-HEALTH-011` | 9 | 0 | 2 |
| Credential custody | `APP-WIZARD-CUSTODY-001` to `APP-WIZARD-CUSTODY-008` | 7 | 0 | 1 |

**Summary:** 129 of 150 active specs implemented; 1 deferred; 20 gaps.

## Key Findings

1. **Test-mode default lives in production code** — `WizardController.readState()` returns `wizardCompleted = this.isTestMode()` when the store key is unset (`wizard.controller.ts:166-168`), so `HYVEON_TEST_MODE=1` in a packaged build skips the first-run wizard. `isTestMode()` (`:217-219`) also re-implements `app/packages/desktop-main/src/env.ts:12`.
2. **First-run gate fails open** — `app.component.tsx:40-54` (desktop-shell) sets `wizardCompleted=true` when `window.hyveon.wizard` is missing or `getState()` rejects, so an IPC failure drops a fresh install straight into the dashboard.
3. **Key rotation has no caller** — `AwsProfileService.rotateActiveCredentials()` (`AwsProfileService.ts:267`) is referenced only by docs and tests; no controller exposes it, so the `aws-credentials` "In-app access key rotation" requirement is service-only.
4. **Bootstrap secret is a CloudFormation stack output** — `iam-bootstrap.yaml:87-89` publishes `SecretAccessKey` via `!GetAtt`, readable by anyone with `cloudformation:DescribeStacks` for as long as the stack exists. Guided rotation deletes that key once the new one verifies (`GuidedIamService.rotate`, `:414`), so exposure is the window before rotation plus any run where rotation fails before deletion (verification-failed, or a throw such as a denied `iam:CreateAccessKey`) or deletion itself fails (the "delete failed" screen path). The access key resource uses `DeletionPolicy: RetainExceptOnCreate` (`:73`). This exposure is the accepted design (APP-WIZARD-TMPL-008): the published key is a temporary credential pending rotation, active until `iam:DeleteAccessKey` succeeds.
5. **Keychain degrade path returns ciphertext as plaintext** — `SafeStorageService.decrypt` returns the input unchanged when `isAvailable()` is false (`SafeStorageService.ts:88-93`), and `encrypt` returns plaintext (`:51-54`). Writers guard with `SafeStorageUnavailableError` (`AwsProfileService.ts:183,270`, `GuidedIamService.ts:417`), but a keychain that is locked at read time would hand base64 ciphertext to `awsCredentialSource` as the secret key. `[inferred]` consequence; the doc comment at `:78-79` acknowledges it.
6. **Bootstrap credential error escapes the result model** — `createS3Client()` throws `BootstrapCredentialsNotConfiguredError` (`BootstrapService.ts:701-708`) and is called outside the `try` in every `ensure*` method (`:125,187,315,410`), so the controller rejects instead of returning `{ status: 'failed' }`, against `.claude/rules/logging.md` rule 2.
7. **Runs table name ignores the operator's project name** — `wizard.controller.ts:310` always passes `DEPLOYMENT_CONFIG_DEFAULTS.projectName` to `resolveRunsTableName`, while buckets take operator-edited names.
8. **Duplicated client cache** — `app/packages/desktop-main/src/services/awsClientCache.ts` and `cloud-aws/src/cachedClient.ts` are code-identical (`diff` shows only doc-comment differences); `CloudHealthService.ts:193-212,240-291` carries several "Mirrors GuidedIamService exactly" helpers; `GUIDED_PROFILE_NAME` is declared in both `GuidedIamService.ts:94` and `app/packages/desktop-preload/src/hyveon-api.ts:2107`. All three trip `.claude/rules/duplication.md` rule 4.
9. **`wizard-flow` spec contradicts itself and the code** — requirement says `userData/wizard-state.json` (`wizard-flow/spec.md:25`) but the scenario says `userData/state.json` (`:34`); Reconfigure lists step order "cloud, credentials, bootstrap, guided-IAM, stack-init" (`:100`) while code is `pick-cloud, guided-iam, credentials, bootstrap, stack-init` (`wizardSteps.ts:9`). Code matches the requirement text, not the scenario.
10. **Reset leaves non-wizard state behind** — `FirstRunWizardService.reset()` (`:200-208`) clears `wizardCompleted`, `activeCloud`, `aws`, `bootstrap`, `creds` and the progress file, but not `addGameWizardDraft` or folder-upload state, and deliberately not `pulumi.*` (documented `:189-198`).
11. **Cloud Health is all-or-nothing and misfiled** — `CloudHealthController.list` wraps checks in a bare `Promise.all` (`cloud-health.controller.ts:28-33`), so one throwing check rejects the whole list; `CloudHealthService` is a Settings feature but is provided by `WizardModule` (`wizard.module.ts:37`) because it shares IAM helpers. `writePolicyToDisk` has no try/catch (`CloudHealthService.ts:200-204`).
12. **IAM check suggests an over-broad policy** — `IamCheckService.buildPolicyJson` emits `Resource: '*'` for every missing action (`IamCheckService.ts:306-315`), unlike the scoped statements in `iamPolicy.ts:79`.
13. **Credential signature embeds the access key id** — `resolveAwsClientCredentialsWithSignature` returns `pasted:<profile>:<accessKeyId>` (`awsCredentialSource.ts:185`); not a secret, but it travels into every cache comparison. `awsClientCache.ts` has no tests.
14. **Template placeholder substitution is single-shot** — `GuidedIamService.renderTemplate` uses `String.replace` (first occurrence only, `:210-212`); safe today because each placeholder occurs once in `iam-bootstrap.yaml:38,55`, but latent.
15. **Reconfigure commit vs guided credentials** `[inferred]` — `commitReconfigureAnswers` sends `credentials.toStatePayload()` whenever `credentials` is not pre-completed (`use-reconfigure-answers.hook.ts:222-224`) without the `!guidedCredentials` guard the first-run path has (`first-run-wizard.component.tsx:307`), so a Reconfigure that re-runs guided IAM may overwrite the guided profile with the untouched form. Not reproduced.
16. **Nothing stops a region change after bootstrap**: `wizard.state.save` merges any `aws.region` (`wizard.controller.ts:202-205`) and guided rotation stores `input.region` (`GuidedIamService.ts:491`), with no check for a completed bootstrap. The wizard region is the install's one region (`docs/high-level-design.md`, decision 10): it names the state backend and every client's region, and once the program takes its region from it (`IAC-ENGINE-REGION-001`) a Reconfigure that changes it would replace the whole stack on the next apply, EFS world saves included.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Make `SafeStorageService.decrypt` fail loudly when the keychain is unavailable for an encrypted value instead of passing ciphertext through (finding 5). (specs: `APP-WIZARD-CUSTODY-007`)
2. Move the `HYVEON_TEST_MODE` `wizardCompleted` default out of the production read path, (finding 1). The gate itself fails open by design and is specified by `desktop-shell` (`APP-SHELL-GATE-004` to `-006`). (specs: `APP-WIZARD-GATE-003`)
3. Refuse a different `aws.region` in the wizard once bootstrap has completed, and tell the operator that moving regions means destroying the stack, deleting the bootstrap resources and resetting the app (finding 16). Lands no later than `iac/engine`'s `IAC-ENGINE-REGION-001`, which makes the wizard region the program's region. (specs: `APP-WIZARD-REGLOCK-001`)

### Should Fix
4. Wrap client creation inside each `BootstrapService.ensure*` try so credential errors return `{ status: 'failed' }` (finding 6). (specs: `APP-WIZARD-BOOT-004`)
5. Resolve the runs table name from the operator's project name (finding 7). (specs: `APP-WIZARD-BOOT-012`)
6. Either wire `rotateActiveCredentials` to an IPC channel and UI, or drop the requirement from `aws-credentials` (finding 3). (specs: `APP-WIZARD-ROTKEY-005`)
7. Fix the `wizard-flow` spec's state-file name and Reconfigure step order (finding 9).
8. Use `Promise.allSettled` in `cloudHealth.list`; guard `writePolicyToDisk` (finding 11). (specs: `APP-WIZARD-HEALTH-011`)
9. Verify and, if real, fix the Reconfigure guided-credentials overwrite (finding 15). (specs: `APP-WIZARD-RECONF-009`)

### Nice to Have
10. Collapse `awsClientCache.ts` into `cloud-aws/src/cachedClient.ts`; share `GUIDED_PROFILE_NAME` and the Cloud Health/Guided IAM helpers (finding 8).
11. Scope the IAM-check suggested policy using `HYVEON_DEPLOY_ALL_STATEMENTS` (finding 12).
12. Clear the add-game draft and folder-upload state on wizard reset, or document why not (finding 10).
13. Use `replaceAll` for template placeholders; add tests for `awsClientCache.ts` (findings 13, 14).
14. Consider moving `CloudHealthService` to its own module owned by the Settings surface.
