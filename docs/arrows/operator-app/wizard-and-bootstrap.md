# Arrow: wizard-and-bootstrap

First launch and Reconfigure: connect an AWS account (guided IAM or keys), pick a region, create the buckets and runs table, check permissions, and keep those credentials safe afterwards.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.

Feature-complete against its requirement sets, including in-app key rotation from Settings; the leaf also owns credential custody (`ElectronStoreService`, `SafeStorageService`, `awsCredentialSource.ts`, client caches) that every AWS-calling leaf depends on.

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
- `app/packages/web/src/components/rotate-access-key-row.component.test.tsx`
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
- `app/packages/shared/src/keyRotation.ts`
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
- `app/packages/web/src/components/first-run-wizard/guided-iam-keychain-unavailable-screen.component.tsx`
- `app/packages/web/src/components/first-run-wizard/reconfigure-cancel-dialog.component.tsx`
- `app/packages/web/src/components/first-run-wizard/use-reconfigure-cancel.hook.ts`
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
- `operator-app/ipc-bridge`: `app/packages/desktop-preload/src/hyveon-api.ts` (`window.hyveon.wizard.*`, `cloudHealth.*`, and the duplicate `GUIDED_PROFILE_NAME` at `:2107`), `app/packages/desktop-main/src/env.ts` (`isTestMode`), `app/packages/desktop-preload/src/preload.ts` (the test seam's default `wizard.state.get` mock).
- `deployment-config`: `shared` `DEPLOYMENT_CONFIG_DEFAULTS` / `resolveRunsTableName` (`wizard.controller.ts:3,310`), `DeploymentConfigModule` (imported by `wizard.module.ts:31` for `CloudHealthService`'s project name).
- `game-server`: `GameWizardDraftService.ts` uses the `addGameWizardDraft` slot that `ElectronStoreService` declares.
- Unassigned repo gates: `app/eslint.config.js:114-198` (renderer `@aws-sdk/*` import ban backing cloud-bootstrap), `docs/docs/setup.md` (the `HyveonDeployAll` oracle `iamPolicy.test.ts` checks against).

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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Launch gating and completion | `APP-WIZARD-GATE-001` to `APP-WIZARD-GATE-006` | 5 | 0 | 0 |
| Resumable progress | `APP-WIZARD-PROG-001` to `APP-WIZARD-PROG-008` | 8 | 0 | 0 |
| Pick-cloud step | `APP-WIZARD-CLOUD-001` to `APP-WIZARD-CLOUD-003` | 3 | 0 | 0 |
| Wizard shell layout and sidebar | `APP-WIZARD-SHELL-001` to `APP-WIZARD-SHELL-008` | 8 | 0 | 0 |
| Start over (first-run reset) | `APP-WIZARD-RESET-001` to `APP-WIZARD-RESET-003` | 3 | 0 | 0 |
| Reconfigure | `APP-WIZARD-RECONF-001` to `APP-WIZARD-RECONF-009` | 9 | 0 | 0 |
| Stack initialization step (code owned by iac/engine) | `APP-WIZARD-STACK-001` to `APP-WIZARD-STACK-004` | 4 | 0 | 0 |
| Guided IAM step in the wizard | `APP-WIZARD-GSTEP-001` to `APP-WIZARD-GSTEP-006` | 6 | 0 | 0 |
| Guided IAM CloudFormation template | `APP-WIZARD-TMPL-001` to `APP-WIZARD-TMPL-011` | 11 | 0 | 0 |
| Guided IAM console handoff | `APP-WIZARD-CONSOLE-001` to `APP-WIZARD-CONSOLE-006` | 5 | 1 | 0 |
| Guided IAM bootstrap key intake | `APP-WIZARD-INTAKE-001` to `APP-WIZARD-INTAKE-006` | 6 | 0 | 0 |
| Guided IAM mandatory rotation | `APP-WIZARD-ROTATE-001` to `APP-WIZARD-ROTATE-008` | 8 | 0 | 0 |
| Keychain requirement for guided and pasted credentials | `APP-WIZARD-KEYCH-001` to `APP-WIZARD-KEYCH-003` | 3 | 0 | 0 |
| Region selection (guided IAM) | `APP-WIZARD-REGION-001` to `APP-WIZARD-REGION-005` | 5 | 0 | 0 |
| One region per install | `APP-WIZARD-REGLOCK-001` | 1 | 0 | 0 |
| AWS credentials step | `APP-WIZARD-CREDS-001` to `APP-WIZARD-CREDS-011` | 11 | 0 | 0 |
| In-app access key rotation (non-guided) | `APP-WIZARD-ROTKEY-001` to `APP-WIZARD-ROTKEY-005` | 5 | 0 | 0 |
| Backend bootstrap | `APP-WIZARD-BOOT-001` to `APP-WIZARD-BOOT-016` | 16 | 0 | 0 |
| IAM permission check | `APP-WIZARD-IAMCHK-001` to `APP-WIZARD-IAMCHK-009` | 9 | 0 | 0 |
| HyveonDeployAll policy generator | `APP-WIZARD-POLICY-001` to `APP-WIZARD-POLICY-004` | 4 | 0 | 0 |
| Cloud Health (Settings) | `APP-WIZARD-HEALTH-001` to `APP-WIZARD-HEALTH-011` | 11 | 0 | 0 |
| Credential custody | `APP-WIZARD-CUSTODY-001` to `APP-WIZARD-CUSTODY-008` | 8 | 0 | 0 |

**Summary:** 149 of 150 active specs implemented; 1 deferred; 0 gaps.

## Key Findings

1. **Test-mode default lived in production code** — **CLOSED** by APP-WIZARD-GATE-003: `readState()` returns `false` when the store key is unset in every build, and the e2e dashboard bypass is the preload test seam's default `wizard.state.get` mock.
2. **First-run gate fails open** — `app.component.tsx:40-54` (desktop-shell) sets `wizardCompleted=true` when `window.hyveon.wizard` is missing or `getState()` rejects, so an IPC failure drops a fresh install straight into the dashboard.
3. **Key rotation has no caller** — **CLOSED** by APP-WIZARD-ROTKEY-005: Settings offers a "Rotate key" action over `wizard.aws.rotateKey`, which maps every outcome to a modeled result.
4. **Bootstrap secret is a CloudFormation stack output** — `iam-bootstrap.yaml:87-89` publishes `SecretAccessKey` via `!GetAtt`, readable by anyone with `cloudformation:DescribeStacks` for as long as the stack exists. Guided rotation deletes that key once the new one verifies (`GuidedIamService.rotate`, `:414`), so exposure is the window before rotation plus any run where rotation fails before deletion (verification-failed, or a throw such as a denied `iam:CreateAccessKey`) or deletion itself fails (the "delete failed" screen path). The access key resource uses `DeletionPolicy: RetainExceptOnCreate` (`:73`). This exposure is the accepted design (APP-WIZARD-TMPL-008): the published key is a temporary credential pending rotation, active until `iam:DeleteAccessKey` succeeds.
5. **Keychain degrade path returns ciphertext as plaintext** — **CLOSED** by APP-WIZARD-CUSTODY-007: `SafeStorageService.decrypt` and `encrypt` throw inside Electron when the keychain is unavailable; outside Electron they pass the value through.
6. **Bootstrap credential error escapes the result model** — **CLOSED** by APP-WIZARD-BOOT-004: `BootstrapService.buildClient` converts client-construction failures into `{ status: 'failed', message }`.
7. **Runs table name ignores the operator's project name** — resolved by APP-WIZARD-BOOT-012: the table follows the project name of the configuration document already in the bucket and falls back to the default only on a fresh install.
8. **Duplicated client cache** — `app/packages/desktop-main/src/services/awsClientCache.ts` and `cloud-aws/src/cachedClient.ts` are code-identical (`diff` shows only doc-comment differences); `CloudHealthService.ts:193-212,240-291` carries several "Mirrors GuidedIamService exactly" helpers; `GUIDED_PROFILE_NAME` is declared in both `GuidedIamService.ts:94` and `app/packages/desktop-preload/src/hyveon-api.ts:2107`. All three trip `.claude/rules/duplication.md` rule 4.
9. **State-file name and step order are fixed by the code**: the progress file is `userData/wizard-state.json` (`FirstRunWizardService.ts:33-41`) and the step order is `pick-cloud, guided-iam, credentials, bootstrap, stack-init` (`wizardSteps.ts:9`); the legacy text named `userData/state.json` and a different Reconfigure order. `APP-WIZARD-PROG-005` and `APP-WIZARD-RECONF-001` state the code's values.
10. **Reset leaves non-wizard state behind** — `FirstRunWizardService.reset()` (`:200-208`) clears `wizardCompleted`, `activeCloud`, `aws`, `bootstrap`, `creds` and the progress file, but not `addGameWizardDraft` or folder-upload state, and deliberately not `pulumi.*` (documented `:189-198`).
11. **Cloud Health was all-or-nothing and misfiled** — the all-or-nothing half is **CLOSED** by APP-WIZARD-HEALTH-011 (`cloudHealth.list` isolates a throwing check; `writePolicyToDisk` logs and throws a plain error); `CloudHealthService` is still a Settings feature provided by `WizardModule` (`wizard.module.ts:37`) because it shares IAM helpers.
12. **IAM check suggests an over-broad policy** — `IamCheckService.buildPolicyJson` emits `Resource: '*'` for every missing action (`IamCheckService.ts:306-315`), unlike the scoped statements in `iamPolicy.ts:79`.
13. **Credential signature embeds the access key id** — `resolveAwsClientCredentialsWithSignature` returns `pasted:<profile>:<accessKeyId>` (`awsCredentialSource.ts:185`); not a secret, but it travels into every cache comparison. `awsClientCache.ts` has no tests.
14. **Template placeholder substitution is single-shot** — `GuidedIamService.renderTemplate` uses `String.replace` (first occurrence only, `:210-212`); safe today because each placeholder occurs once in `iam-bootstrap.yaml:38,55`, but latent.
15. **Reconfigure commit vs guided credentials** `[inferred]` — `commitReconfigureAnswers` sends `credentials.toStatePayload()` whenever `credentials` is not pre-completed (`use-reconfigure-answers.hook.ts:222-224`) without the `!guidedCredentials` guard the first-run path has (`first-run-wizard.component.tsx:307`), so a Reconfigure that re-runs guided IAM may overwrite the guided profile with the untouched form. Not reproduced. **CLOSED** by APP-WIZARD-RECONF-009 (the commit omits `aws` when the form yields no profile), and the related `hyveon-guided` overwrite-before-verify hazard by APP-WIZARD-ROTATE-008.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md`; items with no matching gap spec carry none.

### Nice to Have
9. Collapse `awsClientCache.ts` into `cloud-aws/src/cachedClient.ts`; share `GUIDED_PROFILE_NAME` and the Cloud Health/Guided IAM helpers (finding 8).
10. Scope the IAM-check suggested policy using `HYVEON_DEPLOY_ALL_STATEMENTS` (finding 12).
11. Clear the add-game draft and folder-upload state on wizard reset, or document why not (finding 10).
12. Use `replaceAll` for template placeholders; add tests for `awsClientCache.ts` (findings 13, 14).
13. Consider moving `CloudHealthService` to its own module owned by the Settings surface.
