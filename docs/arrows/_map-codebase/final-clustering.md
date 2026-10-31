# Final clustering — Hyveon (Phase 4 reconciliation)

Lens **C (domain concept)** with **Fine slicing: 16 leaves under 3 grouping nodes + 4 flat leaves** (15 at first reconciliation; `operator-app/desktop-shell` was then split into `desktop-shell` + `ipc-bridge` on user approval — see §5). Residue rule applied: `release-automation` and `install-and-signing-docs` fold into `operator-app/app-update-and-release`; `operator-documentation`, `docs-screenshot-capture` and `node-toolchain-version` go under index `unmapped.docs`.

Sources: `inventory.md` (row numbers below are its functional-unit rows), `lens-candidates.md` (Clustering C, D for sub-splits), `sweep-10.md` (OpenSpec state). Universe: `git ls-files app/packages` = **657** files (412 non-test, 245 `*.test.*`/`*.spec.*`). In §2 paths are relative to `app/packages/` unless they start with `.github/`, `app/` or a repo-root file.

Names changed from the provisional list: none of the 15 original leaf names changed; `operator-app/ipc-bridge` is new (split out of `desktop-shell`). Placement changes against the provisional brief are listed in §4 (marked **moved**).

## 1. Summary

| Segment | Parent | Purpose (non-engineer readable) | Files | Key paths | OpenSpec specs carried | Notes / conflicts |
|---|---|---|---|---|---|---|
| `iac/` | — | Everything involved in turning the operator's declared setup into real AWS resources, safely and with a record of every attempt. | 134 | — | 9 | Grouping node only. |
| `iac/run` | iac | Each plan / apply / destroy / rollback attempt as a durable record: who approved it, whether it was locked, what happened, and the history page that lists them. | 52 | `desktop-main/src/services/RunService.ts`, `RunRecordService.ts`, `LockClearConfirmationGate.ts`, `cloud-aws/src/AwsRunRecordStore.ts`, `shared/src/runs.ts`, `web/src/pages/iac.page.tsx` | iac-plan-apply-page, iac-destroy-flow, iac-run-history, iac-rollback (gates; restore half cited from `deployment-config`), orchestrator-integration-coverage | Its gate logic physically lives in `PulumiService.ts` (owned by `engine`). `partialApply` durability and pre-first-apply lock are open contradictions. |
| `iac/engine` | iac | The machinery that actually runs Pulumi inside the app: downloads the pinned engine, opens the stack, supplies credentials, cancels and recovers stuck operations, caches the resulting outputs. | 37 | `desktop-main/src/services/PulumiService.ts`, `PulumiEngineService.ts`, `PulumiWorkspaceService.ts`, `PulumiLockRecovery.ts`, `ConfigService.ts`, `web/src/components/first-run-wizard/stack-init-step.component.tsx` | pulumi-engine-runtime | `PulumiService.ts` (~5 k lines) is shared ground with `run`. Passphrase portability contradicts `pulumi-infra-program`. |
| `iac/program` | iac | The description of every AWS resource Hyveon creates (network, cluster, task definitions, Lambdas, tables, DNS for Discord) and the outputs it hands back to the app. | 45 | `infra/src/program.ts`, `infra/src/ecs.ts`, `infra/src/lambdas.ts`, `infra/src/securityGroups.ts`, `shared/src/stackOutputs.ts`, `lambda/buildLambda.mjs` | pulumi-infra-program (program half), lambda-runtime-currency, in-task-tls-termination (infra half) | Fan-out hub: every runtime leaf cites a block of `lambdas.ts`/`iam.ts`/`securityGroups.ts`. |
| `game-runtime/` | — | What happens to a game while it is deployed: starting, stopping, DNS, idle shutdown and liveness verdicts. | 55 | — | 2 | Grouping node only. |
| `game-runtime/task-and-dns` | game-runtime | Start and stop a game's container on demand, publish its address in DNS while it runs, show its live status and estimated cost on the dashboard. | 38 | `cloud-aws/src/AwsCloudProvider.ts`, `desktop-main/src/services/EcsService.ts`, `lambda/update-dns/src/handler.ts`, `web/src/pages/dashboard.page.tsx`, `web/src/components/game-card.component.tsx`, `web/src/polling/game-status-provider.component.tsx` | cost-visibility; cites in-task-tls-termination (DNS lifecycle requirement) | Region-of-truth ambiguity (`EcsService.ts:71` vs `:213`). Cost has no noun of its own; lives here because the estimate is derived from the task definition. |
| `game-runtime/watchdog` | game-runtime | Automatically stop a game nobody is playing, so the operator does not pay for an idle server. | 7 | `lambda/watchdog/src/handler.ts`, `web/src/components/watchdog-panel.component.tsx` | none (fragments in game-health-checks, in-task-tls-termination) | **Under 8 files.** Kept separate: own invariant ("watchdog state lives in ECS task tags"), own state machine. Its settings fields live in `deployment-settings-form` (`deployment-config`). |
| `game-runtime/health-check` | game-runtime | Optionally ask a game "are you actually serving players?" over HTTP, so the watchdog judges idleness by the game's own answer. | 10 | `lambda/health-check/src/handler.ts`, `lambda/health-check/src/engine.ts`, `web/src/components/add-game-wizard/health-check-fields.component.tsx`, `shared/src/secrets/secretsStore.ts` | game-health-checks | Sweep-8 says the Lambda cannot initialise on HEAD (no `ECS_CLUSTER`, no AWS-API egress); docs/spec say it works. |
| `operator-app/` | — | The desktop application itself and the operator-facing jobs that are about the app or the AWS account rather than a game. | 242 | 249 | 15 | Grouping node only. |
| `operator-app/wizard-and-bootstrap` | operator-app | First launch and Reconfigure: connect an AWS account (guided IAM or keys), pick a region, create the buckets and runs table, check permissions, and keep those credentials safe afterwards. | 70 | `web/src/components/first-run-wizard/first-run-wizard.component.tsx`, `desktop-main/src/controllers/wizard.controller.ts`, `services/GuidedIamService.ts`, `services/BootstrapService.ts`, `services/awsCredentialSource.ts`, `services/ElectronStoreService.ts` | wizard-flow, guided-iam-provisioning, guided-region-selection, aws-credentials, cloud-bootstrap, aws-cloud-health | Also owns credential custody (`ElectronStoreService`, `SafeStorageService`, client caches), which every AWS caller depends on. |
| `operator-app/diagnostics` | operator-app | The app's own log, the "export a support bundle" button, forwarding of renderer crashes, and the audit trail of who changed what. | 38 | `desktop-main/src/services/DiagnosticsService.ts`, `DiagnosticsBundleService.ts`, `AuditService.ts`, `desktop-main/src/logger.ts`, `web/src/components/DiagnosticsPanel.tsx`, `web/src/lib/report-renderer-error.utils.ts` | app-diagnostics-logging | Audit has no spec; rides here as "operator-visible record of app activity". |
| `operator-app/infra-logs` | operator-app | Read a game's or a Lambda's CloudWatch logs inside the app — live tail, pause, page back in history. | 27 | 25 | infra-log-viewer | "Five vs six Lambdas" wording conflict lives here. |
| `operator-app/app-update-and-release` | operator-app | How a new Hyveon version is cut, packaged, published, and offered to the operator to install. | 5 (+7 outside `app/packages`) | `desktop-main/src/updater.ts`, `updater-fallback.ts`, `shared/src/autoUpdateSetting.ts`, `.github/workflows/release.yml`, `.github/actions/publish-release/action.yml`, `electron-builder.yml` | auto-update-scaffold, release-automation, install-and-signing-docs | **Under 8 in-tree files** (12 with CI/packaging claims). `enableAutoUpdate` gate vs manual check is a spec contradiction. Its IPC channels live in `iac-settings.controller.ts` (`deployment-config`). |
| `operator-app/ipc-bridge` | operator-app | The typed, secret-free channel between the window and the back end: the `window.hyveon` surface the renderer calls, the main-process side that answers it, how errors cross it, and the test seam that fakes it. | 24 | 28 | preload-bridge-naming, desktop-only-operator-surface (no-HTTP-transport / mock-seam requirements; UI-integrity half cited from `desktop-shell`) | Two IPC facades in the renderer. Enforces "secrets never reach the renderer" at the boundary. |
| `operator-app/desktop-shell` | operator-app | The window the operator holds: title bar and navigation, app icon, shared UI building blocks, the settings host page and the polling heartbeat. | 78 (+8 outside) | 83 (+8 outside) | custom-title-bar, app-icon; cites desktop-only-operator-surface (UI-integrity requirements) | Still the largest leaf; scrutinised in §5. Composition root (`app.module`, `cloud-provider.module`) lives here. |
| `game-server` | — | What one game *is*: its declared shape (image, size, ports, HTTPS, environment, pinned hostname), the add/edit wizard that captures it, the draft that survives a restart, and the games list. | 47 | `shared/src/gameServerConfig.ts`, `shared/src/gameServerValidator.ts`, `web/src/components/add-game-wizard/add-game-wizard.component.tsx`, `desktop-main/src/services/GamesWriteService.ts`, `desktop-main/src/controllers/games.controller.ts`, `web/src/pages/games.page.tsx` | game-environment-variables, game-https-configuration, game-port-visibility, game-resource-picker, env-token-interpolation, game-draft-persistence (+ pending game-hostname-pinning) | Infra effects (`ecs.ts`, `envTokenWrapper.ts`, `hostnameShim.ts`) are owned by `iac/program` and cited. |
| `deployment-config` | — | The one stored document that says what should exist (`deployment-config.json`): reading and versioning it, editing its top-level settings, and showing what has changed since the last deploy. | 27 | `desktop-main/src/services/DeploymentConfigService.ts`, `DriftService.ts`, `cloud-aws/src/AwsRemoteFileStore.ts`, `shared/src/deploymentConfig.ts`, `web/src/components/deployment-settings-form.component.tsx`, `web/src/components/pending-changes-banner.component.tsx` | none of its own; cites pulumi-infra-program (config requirements) and iac-rollback (restore requirement) | First explicit home for the "single source of truth" invariant. `restoreRawConfig` is unconditional (no If-Match). |
| `discord-bot` | — | Let players start, stop and check games from Discord slash commands, under the operator's allowlists and per-game permissions, with no bot process running. | 59 | 58 | none (gap — no capability exists) | `discordDomain.ts` (owned by `iac/program`) is the documented exception to "no infra-managed DNS". Two event-receiver implementations, one dead. |
| `helper-task` | — | Put files onto a game's storage volume: the shared file-manager helper session, the in-app volume file browser, folder upload with progress, and seeding during deploy. | 113 | `desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts`, `services/FileManagerService.ts`, `services/FolderUploadService.ts`, `services/volumeFiles/VolumeFilesService.ts`, `web/src/pages/volume-files.page.tsx`, `lambda/efs-seeder/src/handler.ts` | game-volume-folder-upload, game-volume-file-browser | `embed-file-browser` merged and archived at `5c55a380` (wrong-volume upload fixed). Open: efs-seeder first-volume-only; auto-stop schedule failure never surfaced. |

Index `unmapped.docs` (no leaf): operator-documentation, docs-screenshot-capture, node-toolchain-version. Spec count check: 5 + 1 + 3 + 1 + 0 + 1 + 6 + 1 + 1 + 3 + 2 (`ipc-bridge`) + 2 (`desktop-shell`) + 6 + 0 + 0 + 2 (`helper-task`) + 3 (`unmapped.docs`) = 37 = `ls openspec/specs | wc -l` (helper-task re-counted at `5c55a380`; the 37th capability is `openspec/specs/game-volume-file-browser/spec.md`, 10 requirements / 39 scenarios, created when `embed-file-browser` was archived).

## 2. Per-leaf complete file list

Every path below is relative to `app/packages/` unless marked otherwise. Tests ride with the file they exercise (subject resolved by stripping `.test`/`.spec` and any extra dotted suffix such as `.integration`, `.freshInstall`, `.channels`); e2e specs and page objects are assigned by the page or channel they drive.

### `iac/run`

30 non-test + 22 test = **52** files under `app/packages`.

- **cloud-aws**: `cloud-aws/src/AwsRunRecordStore.ts`
- **desktop-main**: `desktop-main/src/controllers/iac-runs.controller.ts`, `desktop-main/src/controllers/iac.controller.ts`, `desktop-main/src/modules/run-record.module.ts`, `desktop-main/src/services/LockClearConfirmationGate.ts`, `desktop-main/src/services/RunRecordService.ts`, `desktop-main/src/services/RunService.ts`, `desktop-main/src/test-mocks/run-record-mock.ts`
- **shared**: `shared/src/changeSummary.ts`, `shared/src/errors.ts`, `shared/src/relativeTime.ts`, `shared/src/runs.ts`
- **web**: `web/e2e/integration-specs/support/iac-ctx.ts`, `web/e2e/pages/IacHistoryPage.ts`, `web/e2e/pages/IacPage.ts`, `web/src/components/ansi-log-viewer.component.tsx`, `web/src/components/change-summary-status.component.tsx`, `web/src/components/iac-destroy-section.component.tsx`, `web/src/components/partial-apply-badge.component.tsx`, `web/src/components/rollback-action.component.tsx`, `web/src/components/rolled-back-from-link.component.tsx`, `web/src/components/run-history-row.component.tsx`, `web/src/components/run-status-badge.component.tsx`, `web/src/components/submission-banners.component.tsx`, `web/src/hooks/use-iac-run.hook.ts`, `web/src/hooks/use-run-history.hook.ts`, `web/src/lib/rollback-diff.utils.ts`, `web/src/pages/iac-history.page.tsx`, `web/src/pages/iac-run-detail.page.tsx`, `web/src/pages/iac.page.tsx`
- **tests riding along (22)**: `cloud-aws/src/AwsRunRecordStore.test.ts`, `desktop-main/src/controllers/iac-runs.controller.test.ts`, `desktop-main/src/controllers/iac.controller.test.ts`, `desktop-main/src/services/RunRecordService.test.ts`, `desktop-main/src/services/RunService.test.ts`, `shared/src/errors.test.ts`, `shared/src/relativeTime.test.ts`, `shared/src/runs.test.ts`, `web/e2e/integration-specs/iac-apply-gates.spec.ts`, `web/e2e/integration-specs/iac-destroy-token.spec.ts`, `web/e2e/integration-specs/iac-plan.spec.ts`, `web/e2e/integration-specs/iac-run-records.spec.ts`, `web/e2e/integration-specs/iac-streaming-ansi.spec.ts`, `web/e2e/specs/iac.spec.ts`, `web/src/components/ansi-log-viewer.component.test.tsx`, `web/src/components/rollback-action.component.test.tsx`, `web/src/components/run-history-row.component.test.tsx`, `web/src/hooks/use-run-history.hook.test.ts`, `web/src/lib/rollback-diff.utils.test.ts`, `web/src/pages/iac-history.page.test.tsx`, `web/src/pages/iac-run-detail.page.test.tsx`, `web/src/pages/iac.page.test.tsx`

### `iac/engine`

18 non-test + 19 test = **37** files under `app/packages`.

- **desktop-main**: `desktop-main/src/controllers/env.controller.ts`, `desktop-main/src/modules/config.module.ts`, `desktop-main/src/modules/pulumi-engine.module.ts`, `desktop-main/src/modules/pulumi-service.module.ts`, `desktop-main/src/modules/pulumi-workspace.module.ts`, `desktop-main/src/services/ConfigService.ts`, `desktop-main/src/services/PulumiCancellation.ts`, `desktop-main/src/services/PulumiCredentialResolver.ts`, `desktop-main/src/services/PulumiEngineService.ts`, `desktop-main/src/services/PulumiLeakedPromise.ts`, `desktop-main/src/services/PulumiLockRecovery.ts`, `desktop-main/src/services/PulumiService.ts`, `desktop-main/src/services/PulumiWorkspaceService.ts`, `desktop-main/src/services/electronRuntime.ts`, `desktop-main/src/test-mocks/pulumi-mock.ts`, `desktop-main/src/testing/config-service.fixture.ts`
- **shared**: `shared/src/pulumiVersion.ts`
- **web**: `web/src/components/first-run-wizard/stack-init-step.component.tsx`
- **tests riding along (19)**: `desktop-main/src/controllers/env.controller.test.ts`, `desktop-main/src/services/ConfigService.test.ts`, `desktop-main/src/services/PulumiCancellation.test.ts`, `desktop-main/src/services/PulumiCredentialResolver.test.ts`, `desktop-main/src/services/PulumiEngineService.test.ts`, `desktop-main/src/services/PulumiLeakedPromise.test.ts`, `desktop-main/src/services/PulumiLockRecovery.test.ts`, `desktop-main/src/services/PulumiService.apply.test.ts`, `desktop-main/src/services/PulumiService.clearStaleLock.test.ts`, `desktop-main/src/services/PulumiService.destroy.test.ts`, `desktop-main/src/services/PulumiService.initializeStack.test.ts`, `desktop-main/src/services/PulumiService.preview.test.ts`, `desktop-main/src/services/PulumiService.rollback.test.ts`, `desktop-main/src/services/PulumiService.test.ts`, `desktop-main/src/services/PulumiWorkspaceService.test.ts`, `web/e2e/integration-specs/config-service.spec.ts`, `web/e2e/integration-specs/pulumi-di-seam.spec.ts`, `web/e2e/integration-specs/stack-outputs.spec.ts`, `web/src/components/first-run-wizard/stack-init-step.component.test.tsx`

### `iac/program`

27 non-test + 18 test = **45** files under `app/packages`.

- **desktop-main**: `desktop-main/src/testing/stack-outputs.fixture.ts`
- **infra**: `infra/package.json`, `infra/src/discordDomain.ts`, `infra/src/dynamodb.ts`, `infra/src/ecs.ts`, `infra/src/efs.ts`, `infra/src/envTokenWrapper.ts`, `infra/src/escapes.ts`, `infra/src/hostedZoneName.ts`, `infra/src/hostnameShim.ts`, `infra/src/iam.ts`, `infra/src/index.ts`, `infra/src/lambdas.ts`, `infra/src/logGroups.ts`, `infra/src/network.ts`, `infra/src/program.ts`, `infra/src/route53.ts`, `infra/src/secrets.ts`, `infra/src/securityGroups.ts`, `infra/src/testing/fixtures.ts`, `infra/src/testing/pulumiMocks.ts`, `infra/tsconfig.json`
- **lambda**: `lambda/buildLambda.mjs`, `lambda/tsconfig.lambda.json`
- **shared**: `shared/src/env.ts`, `shared/src/envJson.ts`, `shared/src/stackOutputs.ts`
- **tests riding along (18)**: `infra/src/discordDomain.test.ts`, `infra/src/dynamodb.test.ts`, `infra/src/ecs.test.ts`, `infra/src/efs.test.ts`, `infra/src/envTokenWrapper.test.ts`, `infra/src/escapes.test.ts`, `infra/src/hostedZoneName.test.ts`, `infra/src/hostnameShim.test.ts`, `infra/src/iam.test.ts`, `infra/src/index.test.ts`, `infra/src/lambdas.test.ts`, `infra/src/network.test.ts`, `infra/src/program.test.ts`, `infra/src/route53.test.ts`, `infra/src/secrets.test.ts`, `infra/src/securityGroups.test.ts`, `shared/src/env.test.ts`, `shared/src/envJson.test.ts`

### `game-runtime/task-and-dns`

21 non-test + 17 test = **38** files under `app/packages`.

- **cloud-aws**: `cloud-aws/src/AwsCloudProvider.ts`
- **desktop-main**: `desktop-main/src/controllers/costs.controller.ts`, `desktop-main/src/modules/aws.module.ts`, `desktop-main/src/services/CostService.ts`, `desktop-main/src/services/EcsService.ts`, `desktop-main/src/test-mocks/ecs-mock.ts`
- **lambda/update-dns**: `lambda/update-dns/esbuild.config.mjs`, `lambda/update-dns/package.json`, `lambda/update-dns/src/handler.ts`, `lambda/update-dns/tsconfig.json`
- **shared**: `shared/src/aws/ecsTask.ts`, `shared/src/cloud.ts`, `shared/src/types.ts`
- **web**: `web/e2e/pages/CostsPage.ts`, `web/e2e/pages/DashboardPage.ts`, `web/src/components/game-card.component.tsx`, `web/src/components/kpi-strip.component.tsx`, `web/src/hooks/use-game-actions.hook.ts`, `web/src/pages/costs.page.tsx`, `web/src/pages/dashboard.page.tsx`, `web/src/polling/game-status-provider.component.tsx`
- **tests riding along (17)**: `cloud-aws/src/AwsCloudProvider.test.ts`, `desktop-main/src/controllers/costs.controller.test.ts`, `desktop-main/src/services/CostService.test.ts`, `desktop-main/src/services/EcsService.test.ts`, `lambda/update-dns/src/handler.test.ts`, `shared/src/aws/ecsTask.test.ts`, `shared/src/cloud.test.ts`, `web/e2e/integration-specs/error-propagation.spec.ts`, `web/e2e/integration-specs/start-stop.spec.ts`, `web/e2e/integration-specs/status-polling.spec.ts`, `web/e2e/specs/costs.spec.ts`, `web/e2e/specs/dashboard.spec.ts`, `web/src/components/game-card.component.test.tsx`, `web/src/components/kpi-strip.component.test.tsx`, `web/src/pages/costs.page.test.tsx`, `web/src/pages/dashboard.page.test.tsx`, `web/src/polling/game-status-provider.component.test.tsx`

### `game-runtime/watchdog`

5 non-test + 2 test = **7** files under `app/packages`.

- **lambda/watchdog**: `lambda/watchdog/esbuild.config.mjs`, `lambda/watchdog/package.json`, `lambda/watchdog/src/handler.ts`, `lambda/watchdog/tsconfig.json`
- **web**: `web/src/components/watchdog-panel.component.tsx`
- **tests riding along (2)**: `lambda/watchdog/src/handler.test.ts`, `web/src/components/watchdog-panel.component.test.tsx`

### `game-runtime/health-check`

7 non-test + 3 test = **10** files under `app/packages`.

- **lambda/health-check**: `lambda/health-check/esbuild.config.mjs`, `lambda/health-check/package.json`, `lambda/health-check/src/engine.ts`, `lambda/health-check/src/handler.ts`, `lambda/health-check/tsconfig.json`
- **shared**: `shared/src/secrets/secretsStore.ts`
- **web**: `web/src/components/add-game-wizard/health-check-fields.component.tsx`
- **tests riding along (3)**: `lambda/health-check/src/engine.test.ts`, `lambda/health-check/src/handler.test.ts`, `shared/src/secrets/secretsStore.test.ts`

### `operator-app/wizard-and-bootstrap`

45 non-test + 25 test = **70** files under `app/packages`; plus 1 claimed outside `app/packages`.

- **cloud-aws**: `cloud-aws/src/awsRegionEnv.ts`, `cloud-aws/src/cachedClient.ts`
- **desktop-main**: `desktop-main/resources/cloudformation/iam-bootstrap.yaml`, `desktop-main/src/cloudformationTemplate.ts`, `desktop-main/src/controllers/cloud-health.controller.ts`, `desktop-main/src/controllers/wizard.controller.ts`, `desktop-main/src/modules/electron-store.module.ts`, `desktop-main/src/modules/wizard.module.ts`, `desktop-main/src/services/AwsProfileService.ts`, `desktop-main/src/services/BootstrapService.ts`, `desktop-main/src/services/CloudHealthService.ts`, `desktop-main/src/services/ElectronStoreService.ts`, `desktop-main/src/services/FirstRunWizardService.ts`, `desktop-main/src/services/GuidedIamService.ts`, `desktop-main/src/services/IamCheckService.ts`, `desktop-main/src/services/SafeStorageService.ts`, `desktop-main/src/services/__fixtures__/aws-profile/.aws/config`, `desktop-main/src/services/__fixtures__/aws-profile/.aws/credentials`, `desktop-main/src/services/awsClientCache.ts`, `desktop-main/src/services/awsCredentialSource.ts`, `desktop-main/src/services/sleep.ts`, `desktop-main/src/services/verifyAccessKeyWithRetry.ts`
- **shared**: `shared/src/awsRegions.ts`, `shared/src/iamPolicy.ts`, `shared/src/wizardSteps.ts`
- **web**: `web/e2e/pages/GuidedIamWizardPage.ts`, `web/src/components/cloud-health-section.component.tsx`, `web/src/components/first-run-wizard/bootstrap-step.component.tsx`, `web/src/components/first-run-wizard/credentials-step.component.tsx`, `web/src/components/first-run-wizard/first-run-wizard.component.tsx`, `web/src/components/first-run-wizard/guided-iam-delete-failed-screen.component.tsx`, `web/src/components/first-run-wizard/guided-iam-intake-screen.component.tsx`, `web/src/components/first-run-wizard/guided-iam-region-screen.component.tsx`, `web/src/components/first-run-wizard/guided-iam-step.component.tsx`, `web/src/components/first-run-wizard/guided-iam-template-screen.component.tsx`, `web/src/components/first-run-wizard/guided-iam-verification-failed-screen.component.tsx`, `web/src/components/first-run-wizard/iam-check-panel.component.tsx`, `web/src/components/first-run-wizard/pick-cloud-step.component.tsx`, `web/src/components/first-run-wizard/use-aws-credentials-form.hook.ts`, `web/src/components/first-run-wizard/use-bootstrap-resources.hook.ts`, `web/src/components/first-run-wizard/use-guided-iam.hook.ts`, `web/src/components/first-run-wizard/use-reconfigure-answers.hook.ts`, `web/src/components/first-run-wizard/use-wizard-progress.hook.ts`, `web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx`, `web/src/components/first-run-wizard/wizard.utils.ts`
- **tests riding along (25)**: `desktop-main/src/cloudformationTemplate.test.ts`, `desktop-main/src/controllers/cloud-health.controller.test.ts`, `desktop-main/src/controllers/wizard.controller.test.ts`, `desktop-main/src/services/AwsProfileService.test.ts`, `desktop-main/src/services/BootstrapService.test.ts`, `desktop-main/src/services/CloudHealthService.test.ts`, `desktop-main/src/services/ElectronStoreService.test.ts`, `desktop-main/src/services/FirstRunWizardService.test.ts`, `desktop-main/src/services/GuidedIamService.test.ts`, `desktop-main/src/services/IamCheckService.test.ts`, `desktop-main/src/services/SafeStorageService.test.ts`, `desktop-main/src/services/awsCredentialSource.test.ts`, `desktop-main/src/services/guided-iam-rotation-integration.test.ts`, `desktop-main/src/services/verifyAccessKeyWithRetry.test.ts`, `shared/src/iamPolicy.test.ts`, `web/e2e/integration-specs/guided-iam.spec.ts`, `web/e2e/specs/guided-iam-wizard.spec.ts`, `web/src/components/cloud-health-section.component.test.tsx`, `web/src/components/first-run-wizard/bootstrap-step.component.test.tsx`, `web/src/components/first-run-wizard/credentials-step.component.test.tsx`, `web/src/components/first-run-wizard/first-run-wizard.component.test.tsx`, `web/src/components/first-run-wizard/guided-iam-step.component.test.tsx`, `web/src/components/first-run-wizard/pick-cloud-step.component.test.tsx`, `web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx`, `web/src/components/first-run-wizard/wizard.utils.test.ts`
- **outside `app/packages`**: `build/generate-aws-regions.mjs`

### `operator-app/diagnostics`

20 non-test + 18 test = **38** files under `app/packages`.

- **cloud-aws**: `cloud-aws/src/AwsAuditLogStore.ts`
- **desktop-main**: `desktop-main/src/app-version.ts`, `desktop-main/src/controllers/audit.controller.ts`, `desktop-main/src/controllers/diagnostics.controller.ts`, `desktop-main/src/logger.ts`, `desktop-main/src/services/AuditService.ts`, `desktop-main/src/services/DiagnosticsBundleService.ts`, `desktop-main/src/services/DiagnosticsService.ts`, `desktop-main/src/services/diagnosticsBundleAllowlist.ts`, `desktop-main/src/services/diagnosticsLogScrubber.ts`
- **shared**: `shared/src/audit.ts`, `shared/src/diagnosticsBundle.ts`
- **web**: `web/e2e/pages/AuditPage.ts`, `web/src/components/DiagnosticsPanel.tsx`, `web/src/components/audit-entry-row.component.tsx`, `web/src/components/error-boundary.component.tsx`, `web/src/components/export-bundle-button.component.tsx`, `web/src/hooks/use-diagnostics-tail.hook.ts`, `web/src/lib/report-renderer-error.utils.ts`, `web/src/pages/audit.page.tsx`
- **tests riding along (18)**: `cloud-aws/src/AwsAuditLogStore.test.ts`, `desktop-main/src/app-version.test.ts`, `desktop-main/src/controllers/audit.controller.test.ts`, `desktop-main/src/controllers/diagnostics.controller.test.ts`, `desktop-main/src/logger.test.ts`, `desktop-main/src/services/AuditService.test.ts`, `desktop-main/src/services/DiagnosticsBundleService.test.ts`, `desktop-main/src/services/DiagnosticsService.test.ts`, `desktop-main/src/services/diagnosticsBundleAllowlist.test.ts`, `desktop-main/src/services/diagnosticsLogScrubber.test.ts`, `shared/src/audit.test.ts`, `web/e2e/integration-specs/diagnostics-export.spec.ts`, `web/e2e/specs/audit.spec.ts`, `web/src/components/DiagnosticsPanel.test.tsx`, `web/src/components/audit-entry-row.component.test.tsx`, `web/src/components/error-boundary.component.test.tsx`, `web/src/lib/report-renderer-error.utils.test.ts`, `web/src/pages/audit.page.test.tsx`

### `operator-app/infra-logs`

14 non-test + 11 test = **25** files under `app/packages`.

- **desktop-main**: `desktop-main/src/controllers/logs.controller.ts`, `desktop-main/src/services/LogsService.ts`
- **shared**: `shared/src/lambdaFunctionKey.ts`
- **web**: `web/e2e/pages/InfrastructureLogsPage.ts`, `web/e2e/pages/LogsPage.ts`, `web/src/components/game-combobox.component.tsx`, `web/src/components/jump-to-latest-button.component.tsx`, `web/src/components/live-badge.component.tsx`, `web/src/components/log-line-display.component.tsx`, `web/src/components/log-tail-view.component.tsx`, `web/src/hooks/use-log-tail.hook.ts`, `web/src/lib/ansi.utils.ts`, `web/src/pages/infrastructure-logs.page.tsx`, `web/src/pages/logs.page.tsx`
- **tests riding along (12)**: `desktop-main/src/controllers/logs.controller.test.ts`, `desktop-main/src/services/LogsService.test.ts`, `web/e2e/specs/infrastructure-logs.spec.ts`, `web/e2e/specs/logs.spec.ts`, `web/src/components/game-combobox.component.test.tsx`, `web/src/components/jump-to-latest-button.component.test.tsx`, `web/src/components/log-line-display.component.test.tsx`, `web/src/hooks/use-log-tail.hook.test.ts`, `web/src/lib/ansi.utils.test.ts`, `web/src/pages/infrastructure-logs.page.test.tsx`, `web/src/pages/logs.page.test.tsx`

### `operator-app/app-update-and-release`

3 non-test + 2 test = **5** files under `app/packages`; plus 7 claimed outside `app/packages`.

- **desktop-main**: `desktop-main/src/updater-fallback.ts`, `desktop-main/src/updater.ts`
- **shared**: `shared/src/autoUpdateSetting.ts`
- **tests riding along (2)**: `desktop-main/src/updater-fallback.test.ts`, `desktop-main/src/updater.test.ts`
- **outside `app/packages`**: `.github/workflows/release.yml`, `.github/workflows/package.yml`, `.github/actions/publish-release/action.yml`, `.github/actions/build-package/action.yml`, `cliff.toml`, `electron-builder.yml`, `app/test/packaging-manifest-pins.test.ts` (test)

### `operator-app/ipc-bridge`

18 non-test + 10 test = **28** files under `app/packages` (re-synced to `5c55a380`: +3 non-test / +2 test from the `embed-file-browser` merge).

- **desktop-main**: `desktop-main/src/controllers/validation.ts`, `desktop-main/src/ipc-broadcast.ts`, `desktop-main/src/ipc-main-bridge.ts`, `desktop-main/src/rpc-error-message.filter.ts`, `desktop-main/src/testing/message-pattern.test-utils.ts`, `desktop-main/src/testing/no-secret-fields.ts`
- **desktop-preload**: `desktop-preload/package.json`, `desktop-preload/src/hyveon-api.ts`, `desktop-preload/src/index.ts`, `desktop-preload/src/preload.ts`, `desktop-preload/src/stream-bridge.ts`, `desktop-preload/src/test-mock-registry.ts`, `desktop-preload/tsconfig.json`
- **shared**: `shared/src/testing/secretFields.ts` (deep-imported test support behind the secret-free-bridge invariant; not in the barrel)
- **web**: `web/src/api.service.ts`, `web/src/globals.d.ts`, `web/src/lib/bridge.utils.ts`, `web/src/window.d.ts`
- **tests riding along (10)**: `desktop-main/src/ipc-broadcast.test.ts`, `desktop-main/src/ipc-main-bridge.test.ts`, `desktop-main/src/rpc-error-message.filter.test.ts`, `desktop-preload/src/preload.test.ts`, `desktop-preload/src/test-mock-registry.test.ts`, `shared/src/testing/secretFields.test.ts`, `web/e2e/specs/electron-ipc-roundtrip.spec.ts`, `web/e2e/specs/ipc-mock.spec.ts`, `web/e2e/specs/streaming-handle-roundtrip.spec.ts`, `web/src/api.service.test.ts`

### `operator-app/desktop-shell`

62 non-test + 21 test = **83** files under `app/packages`; plus 8 claimed outside `app/packages` (re-synced to `5c55a380`: +2 non-test / +1 test from the `embed-file-browser` merge).

- **desktop-main**: `desktop-main/src/app.module.ts`, `desktop-main/src/controllers/window.controller.ts`, `desktop-main/src/electron-entry.ts`, `desktop-main/src/env.ts`, `desktop-main/src/fix-path-bootstrap.ts`, `desktop-main/src/main.ts`, `desktop-main/src/modules/cloud-provider.module.ts`, `desktop-main/src/modules/cloud-provider.tokens.ts`, `desktop-main/src/modules/native-dialog.module.ts`, `desktop-main/src/services/NativeDialogService.ts`, `desktop-main/src/services/WindowService.ts`
- **web**: `web/DESIGN.md`, `web/components.json`, `web/e2e/pages/AppLayout.ts`, `web/e2e/pages/SettingsPage.ts`, `web/index.html`, `web/public/apple-touch-icon.png`, `web/public/favicon-32.png`, `web/public/favicon.svg`, `web/src/app.component.tsx`, `web/src/components/app-layout.component.tsx`, `web/src/components/app-nav.component.tsx`, `web/src/components/app-topbar.component.tsx`, `web/src/components/async-content.component.tsx`, `web/src/components/confirm-dialog.component.tsx`, `web/src/components/empty-state-card.component.tsx`, `web/src/components/error-banner.component.tsx`, `web/src/components/inline-alert.component.tsx`, `web/src/components/loading-state.component.tsx`, `web/src/components/page-header.component.tsx`, `web/src/components/section-card.component.tsx`, `web/src/components/settings-row.component.tsx`, `web/src/components/ui/alert-dialog.component.tsx`, `web/src/components/ui/badge.component.tsx`, `web/src/components/ui/button.component.tsx`, `web/src/components/ui/card.component.tsx`, `web/src/components/ui/dialog.component.tsx`, `web/src/components/ui/dropdown-menu.component.tsx`, `web/src/components/ui/form-field.component.tsx`, `web/src/components/ui/input.component.tsx`, `web/src/components/ui/label.component.tsx`, `web/src/components/ui/native-select.component.tsx`, `web/src/components/ui/select.component.tsx`, `web/src/components/ui/sonner.component.tsx`, `web/src/components/ui/table.component.tsx`, `web/src/components/ui/tabs.component.tsx`, `web/src/components/ui/textarea.component.tsx`, `web/src/components/ui/tooltip.component.tsx`, `web/src/components/window-chrome.component.tsx`, `web/src/hooks/use-app-region-style.hook.ts`, `web/src/hooks/use-click-outside.hook.ts`, `web/src/hooks/use-copied-reset.hook.ts`, `web/src/hooks/use-now-tick.hook.ts`, `web/src/index.css`, `web/src/lib/confirm-skip.utils.ts`, `web/src/lib/format.utils.ts`, `web/src/lib/utils.utils.ts`, `web/src/main.tsx`, `web/src/pages/settings.page.tsx`, `web/src/polling/polling-indicator.component.tsx`, `web/src/polling/polling-provider.component.tsx`, `web/src/vite-env.d.ts`
- **tests riding along (21)**: `desktop-main/src/controllers/window.controller.test.ts`, `desktop-main/src/electron-entry.test.ts`, `desktop-main/src/fix-path-bootstrap.test.ts`, `desktop-main/src/main.test.ts`, `desktop-main/src/modules/cloud-provider.module.test.ts`, `desktop-main/src/services/NativeDialogService.test.ts`, `desktop-main/src/services/WindowService.test.ts`, `web/e2e/specs/electron-clean-quit.spec.ts`, `web/e2e/specs/electron-smoke.spec.ts`, `web/e2e/specs/polling.spec.ts`, `web/e2e/specs/settings.spec.ts`, `web/src/app.component.test.tsx`, `web/src/components/app-layout.component.test.tsx`, `web/src/components/confirm-dialog.component.test.tsx`, `web/src/components/ui/form-field.component.test.tsx`, `web/src/components/ui/native-select.component.test.tsx`, `web/src/components/ui/textarea.component.test.tsx`, `web/src/hooks/use-click-outside.hook.test.ts`, `web/src/pages/settings.page.test.tsx`, `web/src/polling/polling-indicator.component.test.tsx`, `web/src/polling/polling-provider.component.test.ts`
- **outside `app/packages`**: `electron.vite.config.ts`, `build/icon.svg`, `build/icon-small.svg`, `build/icon.icns`, `build/icon.ico`, `build/icon.png`, `build/generate-icons.mjs`, `build/verify-main-bundle-externals.mjs`

### `game-server`

25 non-test + 22 test = **47** files under `app/packages`.

- **desktop-main**: `desktop-main/src/controllers/games.controller.ts`, `desktop-main/src/services/GameWizardDraftService.ts`, `desktop-main/src/services/GamesWriteService.ts`, `desktop-main/src/services/mergeGameLists.ts`
- **shared**: `shared/src/addGameWizardSteps.ts`, `shared/src/envTokens.ts`, `shared/src/gameServerConfig.ts`, `shared/src/gameServerPorts.ts`, `shared/src/gameServerValidator.ts`, `shared/src/gamesWrite.ts`
- **web**: `web/e2e/pages/GamesPage.ts`, `web/src/components/add-game-wizard/add-game-wizard.component.tsx`, `web/src/components/add-game-wizard/environment-step.component.tsx`, `web/src/components/add-game-wizard/identity-step.component.tsx`, `web/src/components/add-game-wizard/networking-step.component.tsx`, `web/src/components/add-game-wizard/resources-step.component.tsx`, `web/src/components/add-game-wizard/review-step.component.tsx`, `web/src/components/add-game-wizard/storage-step.component.tsx`, `web/src/components/add-game-wizard/use-wizard-draft-autosave.hook.ts`, `web/src/components/add-game-wizard/wizard-form.utils.ts`, `web/src/components/edit-game-form/edit-game-form.component.tsx`, `web/src/components/game-status-badges.component.tsx`, `web/src/components/remove-game-button.component.tsx`, `web/src/pages/game-detail.page.tsx`, `web/src/pages/games.page.tsx`
- **tests riding along (22)**: `desktop-main/src/controllers/games.controller.integration.test.ts`, `desktop-main/src/controllers/games.controller.test.ts`, `desktop-main/src/services/GameWizardDraftService.test.ts`, `desktop-main/src/services/GamesWriteService.test.ts`, `desktop-main/src/services/mergeGameLists.test.ts`, `shared/src/envTokens.test.ts`, `shared/src/gameServerPorts.test.ts`, `shared/src/gameServerValidator.test.ts`, `web/e2e/specs/games.spec.ts`, `web/src/components/add-game-wizard/add-game-wizard.component.test.tsx`, `web/src/components/add-game-wizard/environment-step.component.test.tsx`, `web/src/components/add-game-wizard/identity-step.component.test.tsx`, `web/src/components/add-game-wizard/networking-step.component.test.tsx`, `web/src/components/add-game-wizard/resources-step.component.test.tsx`, `web/src/components/add-game-wizard/review-step.component.test.tsx`, `web/src/components/add-game-wizard/storage-step.component.test.tsx`, `web/src/components/add-game-wizard/wizard-form.utils.test.ts`, `web/src/components/edit-game-form/edit-game-form.component.test.tsx`, `web/src/components/game-status-badges.component.test.tsx`, `web/src/components/remove-game-button.component.test.tsx`, `web/src/pages/game-detail.page.test.tsx`, `web/src/pages/games.page.test.tsx`

### `deployment-config`

14 non-test + 13 test = **27** files under `app/packages`.

- **cloud-aws**: `cloud-aws/src/AwsRemoteFileStore.ts`
- **desktop-main**: `desktop-main/src/controllers/drift.controller.ts`, `desktop-main/src/controllers/iac-settings.controller.ts`, `desktop-main/src/modules/deployment-config.module.ts`, `desktop-main/src/services/DeploymentConfigService.ts`, `desktop-main/src/services/DriftService.ts`, `desktop-main/src/test-mocks/remote-file-store-mock.ts`, `desktop-main/src/testing/deployment-config.fixture.ts`
- **shared**: `shared/src/deploymentConfig.ts`, `shared/src/deploymentSettingsWrite.ts`, `shared/src/drift.ts`
- **web**: `web/src/components/deployment-settings-form.component.tsx`, `web/src/components/pending-changes-banner.component.tsx`, `web/src/hooks/use-deployment-settings.hook.ts`
- **tests riding along (13)**: `cloud-aws/src/AwsRemoteFileStore.test.ts`, `desktop-main/src/controllers/drift.controller.test.ts`, `desktop-main/src/controllers/iac-settings.controller.test.ts`, `desktop-main/src/services/DeploymentConfigService.freshInstall.test.ts`, `desktop-main/src/services/DeploymentConfigService.s3.test.ts`, `desktop-main/src/services/DeploymentConfigService.test.ts`, `desktop-main/src/services/DeploymentConfigService.write.test.ts`, `desktop-main/src/services/DriftService.test.ts`, `shared/src/deploymentConfig.test.ts`, `shared/src/deploymentSettingsWrite.test.ts`, `web/e2e/specs/pending-changes-banner.spec.ts`, `web/src/components/deployment-settings-form.component.test.tsx`, `web/src/components/pending-changes-banner.component.test.tsx`

### `discord-bot`

39 non-test + 19 test = **58** files under `app/packages`.

- **cloud-aws**: `cloud-aws/src/AwsDiscordConfigStore.ts`, `cloud-aws/src/AwsDiscordEventReceiver.ts`, `cloud-aws/src/AwsSecretsStore.ts`
- **desktop-main**: `desktop-main/src/controllers/discord.controller.ts`, `desktop-main/src/modules/discord.module.ts`, `desktop-main/src/services/DiscordCommandRegistrar.ts`, `desktop-main/src/services/DiscordConfigService.ts`
- **lambda/followup**: `lambda/followup/esbuild.config.mjs`, `lambda/followup/package.json`, `lambda/followup/src/handler.ts`, `lambda/followup/tsconfig.json`
- **lambda/interactions**: `lambda/interactions/esbuild.config.mjs`, `lambda/interactions/package.json`, `lambda/interactions/src/handler.ts`, `lambda/interactions/tsconfig.json`
- **shared**: `shared/src/canRun.ts`, `shared/src/commands.ts`, `shared/src/ddb/client.ts`, `shared/src/ddb/configStore.ts`, `shared/src/ddb/pendingStore.ts`, `shared/src/discord/awsLambdaDiscordReceiver.ts`, `shared/src/discord/patchOriginal.ts`, `shared/src/formatStatus.ts`, `shared/src/sanitize.ts`
- **web**: `web/e2e/pages/DiscordPage.ts`, `web/src/components/snowflake-chips-input.component.tsx`, `web/src/lib/snowflake.utils.ts`, `web/src/pages/discord/add-guild-form.component.tsx`, `web/src/pages/discord/admins-section.component.tsx`, `web/src/pages/discord/base-admins-panel.component.tsx`, `web/src/pages/discord/credentials-section.component.tsx`, `web/src/pages/discord/discord.page.tsx`, `web/src/pages/discord/guild-row.component.tsx`, `web/src/pages/discord/guilds-section.component.tsx`, `web/src/pages/discord/permissions-section.component.tsx`, `web/src/pages/discord/serverless-badge.component.tsx`, `web/src/pages/discord/setup-wizard.component.tsx`, `web/src/pages/discord/snowflake.utils.ts`, `web/src/pages/discord/use-discord-config.hook.ts`
- **tests riding along (19)**: `cloud-aws/src/AwsDiscordConfigStore.test.ts`, `cloud-aws/src/AwsDiscordEventReceiver.test.ts`, `cloud-aws/src/AwsSecretsStore.test.ts`, `desktop-main/src/controllers/discord.controller.test.ts`, `desktop-main/src/services/DiscordCommandRegistrar.test.ts`, `desktop-main/src/services/DiscordConfigService.test.ts`, `lambda/followup/src/handler.test.ts`, `lambda/interactions/src/handler.test.ts`, `shared/src/canRun.test.ts`, `shared/src/commands.test.ts`, `shared/src/ddb/configStore.test.ts`, `shared/src/ddb/pendingStore.test.ts`, `shared/src/discord/awsLambdaDiscordReceiver.test.ts`, `shared/src/formatStatus.test.ts`, `shared/src/sanitize.test.ts`, `web/e2e/integration-specs/can-run.spec.ts`, `web/e2e/integration-specs/discord-config.spec.ts`, `web/e2e/specs/discord.spec.ts`, `web/src/pages/discord/discord.page.test.tsx`

### `helper-task`

72 non-test + 41 test = **113** files under `app/packages` (re-synced to `5c55a380` after the `embed-file-browser` merge: +40 non-test / +20 test added, 4 non-test / 3 test deleted).

- **desktop-main**: `desktop-main/src/controllers/folder-upload.controller.ts`, `desktop-main/src/controllers/volume-files.controller.ts`, `desktop-main/src/helper-quit-hook.ts`, `desktop-main/src/modules/folder-upload.module.ts`, `desktop-main/src/modules/volume-files-api.module.ts`, `desktop-main/src/modules/volume-files.module.ts`, `desktop-main/src/services/Ec2Service.ts`, `desktop-main/src/services/FileManagerService.ts`, `desktop-main/src/services/FolderScanService.ts`, `desktop-main/src/services/FolderUploadService.ts`, `desktop-main/src/services/PublicIpService.ts`, `desktop-main/src/services/SchedulerService.ts`, `desktop-main/src/services/folderUpload/FileBrowserClient.ts`, `desktop-main/src/services/folderUpload/ProgressAggregator.ts`, `desktop-main/src/services/folderUpload/RegistryUploadBackend.ts`, `desktop-main/src/services/folderUpload/ephemeralCert.ts`, `desktop-main/src/services/folderUpload/tlsLaunch.ts`, `desktop-main/src/services/folderUpload/uploadEngine.ts`, `desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts`, `desktop-main/src/services/volumeFiles/VolumeFileBackend.ts`, `desktop-main/src/services/volumeFiles/VolumeFilesService.ts`, `desktop-main/src/services/volumeFiles/fileOps.ts`, `desktop-main/src/services/volumeFiles/helperVolumeLayout.ts`, `desktop-main/src/services/volumeFiles/localFiles.ts`, `desktop-main/src/services/volumeFiles/localNames.ts`, `desktop-main/src/services/volumeFiles/textFiles.ts`, `desktop-main/src/services/volumeFiles/transferOps.ts`, `desktop-main/src/services/volumeFiles/transfers.ts`, `desktop-main/src/services/volumeFiles/uploadReservations.ts`, `desktop-main/src/services/volumeFiles/volumeFileErrors.ts`, `desktop-main/src/testing/fake-filebrowser-server.ts`, `desktop-main/src/testing/fake-volume-backend.ts`, `desktop-main/src/test-mocks/ec2-mock.ts`, `desktop-main/src/test-mocks/scheduler-mock.ts`
- **lambda/efs-seeder**: `lambda/efs-seeder/esbuild.config.mjs`, `lambda/efs-seeder/package.json`, `lambda/efs-seeder/src/handler.ts`, `lambda/efs-seeder/tsconfig.json`
- **shared**: `shared/src/fileManagerLogGroup.ts`, `shared/src/folderUpload/index.ts`, `shared/src/folderUpload/paths.ts`, `shared/src/folderUpload/types.ts`, `shared/src/volumeFiles/index.ts`, `shared/src/volumeFiles/paths.ts`, `shared/src/volumeFiles/types.ts`
- **web**: `web/e2e/pages/VolumeFilesPage.ts`, `web/src/components/folder-upload/folder-include-tree.component.tsx`, `web/src/components/folder-upload/folder-seed-section.component.tsx`, `web/src/components/folder-upload/folder-seed.utils.ts`, `web/src/components/folder-upload/folder-upload-card.component.tsx`, `web/src/components/folder-upload/folder-upload-progress-meter.component.tsx`, `web/src/components/folder-upload/folder-upload.test-utils.ts`, `web/src/components/folder-upload/overwrite-confirmation.component.tsx`, `web/src/components/folder-upload/use-folder-seed.hook.ts`, `web/src/components/folder-upload/use-folder-upload-progress.hook.ts`, `web/src/components/stray-helpers-button.component.tsx`, `web/src/components/volume-files/drop-zone.component.tsx`, `web/src/components/volume-files/file-actions.component.tsx`, `web/src/components/volume-files/file-table.component.tsx`, `web/src/components/volume-files/name-dialog.component.tsx`, `web/src/components/volume-files/server-banner.component.tsx`, `web/src/components/volume-files/session-bar.component.tsx`, `web/src/components/volume-files/text-editor-dialog.component.tsx`, `web/src/components/volume-files/transfer-list.component.tsx`, `web/src/components/volume-files/use-server-guard.hook.ts`, `web/src/components/volume-files/use-volume-files.hook.ts`, `web/src/components/volume-files/use-volume-session.hook.ts`, `web/src/components/volume-files/use-volume-transfers.hook.ts`, `web/src/components/volume-files/volume-breadcrumb.component.tsx`, `web/src/components/volume-files/volume-browser.component.tsx`, `web/src/components/volume-files/volume-files.test-utils.ts`, `web/src/components/volume-files/volume-files.utils.ts`, `web/src/components/volume-files/volume-picker.component.tsx`, `web/src/pages/volume-files.page.tsx`
- **tests riding along (41)**: `desktop-main/src/controllers/folder-upload.controller.test.ts`, `desktop-main/src/controllers/volume-files.controller.test.ts`, `desktop-main/src/helper-quit-hook.test.ts`, `desktop-main/src/services/Ec2Service.test.ts`, `desktop-main/src/services/FileManagerService.test.ts`, `desktop-main/src/services/FolderScanService.test.ts`, `desktop-main/src/services/FolderUpload.integration.test.ts`, `desktop-main/src/services/FolderUploadService.test.ts`, `desktop-main/src/services/PublicIpService.test.ts`, `desktop-main/src/services/SchedulerService.test.ts`, `desktop-main/src/services/folderUpload/FileBrowserClient.test.ts`, `desktop-main/src/services/folderUpload/ProgressAggregator.test.ts`, `desktop-main/src/services/folderUpload/RegistryUploadBackend.test.ts`, `desktop-main/src/services/folderUpload/uploadEngine.test.ts`, `desktop-main/src/services/volumeFiles/HelperSessionRegistry.test.ts`, `desktop-main/src/services/volumeFiles/VolumeFilesService.test.ts`, `desktop-main/src/services/volumeFiles/helperVolumeLayout.test.ts`, `desktop-main/src/services/volumeFiles/localNames.test.ts`, `desktop-main/src/services/volumeFiles/transfers.test.ts`, `desktop-main/src/services/volumeFiles/uploadReservations.test.ts`, `lambda/efs-seeder/src/handler.test.ts`, `shared/src/fileManagerLogGroup.test.ts`, `shared/src/folderUpload/paths.test.ts`, `shared/src/volumeFiles/paths.test.ts`, `web/e2e/integration-specs/helper-session.spec.ts`, `web/e2e/integration-specs/volume-outputs.spec.ts`, `web/e2e/specs/volume-files-electron.spec.ts`, `web/e2e/specs/volume-files.spec.ts`, `web/src/components/folder-upload/folder-include-tree.component.test.tsx`, `web/src/components/folder-upload/folder-seed-section.component.test.tsx`, `web/src/components/folder-upload/folder-seed.utils.test.ts`, `web/src/components/folder-upload/folder-upload-card.component.test.tsx`, `web/src/components/folder-upload/folder-upload-progress-meter.component.test.tsx`, `web/src/components/folder-upload/overwrite-confirmation.component.test.tsx`, `web/src/components/stray-helpers-button.component.test.tsx`, `web/src/components/volume-files/session-bar.component.test.tsx`, `web/src/components/volume-files/use-volume-files.hook.test.tsx`, `web/src/components/volume-files/use-volume-session.hook.test.tsx`, `web/src/components/volume-files/use-volume-transfers.hook.test.tsx`, `web/src/components/volume-files/volume-files.utils.test.ts`, `web/src/pages/volume-files.page.test.tsx`

## Unassigned

35 files under `app/packages` (33 non-test, 2 test) plus repo-level config, each a pure carrier, harness or build config with no purpose of its own. None is claimed by two leaves; each leaf that depends on one cites it.

| File(s) | Reason |
|---|---|
| `cloud-aws/src/index.ts` (+ `index.test.ts`), `shared/src/index.ts` | Package barrels; re-export every leaf's symbols. `shared/src/index.ts` carries the CLAUDE.md "barrel stays free of new AWS SDK imports" invariant — cited by `desktop-shell` and `discord-bot` as a constraint, not owned. |
| `cloud-aws/package.json`, `cloud-aws/tsconfig.json`, `desktop-main/package.json`, `desktop-main/tsconfig.json`, `shared/package.json`, `shared/tsconfig.json`, `web/package.json`, `web/tsconfig.json`, `web/tsconfig.typecheck.json`, `web/vite.config.ts` | Workspace build config for packages that span several leaves. (Single-leaf packages — `infra/`, `desktop-preload/`, each `lambda/<fn>/` — have their manifests assigned to that leaf.) |
| `desktop-main/src/test-mocks/mock-store.ts` | SDK mock-response queue shared by `ecs-mock.ts` (task-and-dns) and `run-record-mock.ts` (run) and the Playwright `ServerMocks` fixture. Test infra. |
| `web/e2e/fixtures/{electron-launch,electron-mock,game-data,hyveon-http-bridge,index,ipc-harness,server-mocks,stack-outputs.fixture}.ts`, `web/e2e/integration-specs/{index.ts,tsconfig.json}`, `web/e2e/pages/{hashRoute,index}.ts`, `web/playwright.config.ts`, `web/playwright.integration.config.ts` | Three-tier test harness (chromium, electron, integration). `hyveon-http-bridge.ts` is the fictional `/api/*` shim that `ipc-bridge`'s no-HTTP invariant must cite (`electron-mock.ts` likewise backs its mock seam); `ipc-harness.ts` is the integration seam `iac/run`'s orchestrator-integration-coverage cites. |
| `web/src/test-utils/{render-page.utils.tsx,stream-handle.test-utils.ts}`, `web/src/{testing-matchers,vitest}.d.ts` | jsdom test helpers and duplicate matcher shims. |
| `web/e2e/screenshots/{capture.spec.ts,demo-data.ts}`, `web/playwright.screenshots.config.ts` | → index `unmapped.docs` (docs-screenshot-capture). |
| Outside `app/packages`: `app/eslint.config.js`, `app/package.json`, `app/tsconfig.base.json`, `app/tsconfig.json`, `app/vitest.config.ts`, `app/vitest.setup.ts`, `.github/workflows/{lint,test,integration,e2e}.yml`, `.github/actions/setup-app/action.yml`, `.coderabbit.yaml` | Repo-wide lint/typecheck/test gates. `setup-app` and the root `package.json` `engines` → `unmapped.docs` (node-toolchain-version). `app/eslint.config.js` carries cloud-bootstrap's SDK ban, cited by `wizard-and-bootstrap`. |
| Outside `app/packages`: `.github/workflows/{docs-build,docusaurus-gh-pages}.yml`, `docs/**` | → index `unmapped.docs` (operator-documentation). |

### Assignment verification

Generated from `git ls-files app/packages` on HEAD `2822efd1` by a rule table (explicit path rules for every non-test file; tests resolved to their subject). Result: 657 files, each mapped to exactly one bucket (a dict keyed by path, so no file can appear twice), 0 left unresolved.

Re-synced to `5c55a380` (the `embed-file-browser` merge: 70 added, 7 deleted, universe 720). The added files went to `helper-task`, `operator-app/ipc-bridge` (`ipc-broadcast.ts`, `testing/no-secret-fields.ts`, `shared/src/testing/secretFields.ts` and two tests) and `operator-app/desktop-shell` (`NativeDialogService.ts`, `native-dialog.module.ts` and one test); every deleted file was `helper-task`'s. `desktop-main/src/test-mocks/ec2-mock.ts` and `scheduler-mock.ts` (SDK mocks for `Ec2Service`/`SchedulerService`, both `helper-task` files) are counted under `helper-task`.

| Bucket | Non-test | Test | Total |
|---|---|---|---|
| iac/run | 30 | 22 | 52 |
| iac/engine | 18 | 19 | 37 |
| iac/program | 27 | 18 | 45 |
| game-runtime/task-and-dns | 21 | 17 | 38 |
| game-runtime/watchdog | 5 | 2 | 7 |
| game-runtime/health-check | 7 | 3 | 10 |
| operator-app/wizard-and-bootstrap | 45 | 25 | 70 |
| operator-app/diagnostics | 20 | 18 | 38 |
| operator-app/infra-logs | 14 | 11 | 25 |
| operator-app/app-update-and-release | 3 | 2 | 5 |
| operator-app/ipc-bridge | 18 | 10 | 28 |
| operator-app/desktop-shell | 62 | 21 | 83 |
| game-server | 25 | 22 | 47 |
| deployment-config | 14 | 13 | 27 |
| discord-bot | 39 | 19 | 58 |
| helper-task | 72 | 41 | 113 |
| **Assigned** | **420** | **263** | **683** |
| Unassigned | 33 | 2 | 35 |
| **Universe** | **455** | **265** | **720** |

## 3. EARS requirement prefixes

Path-concatenated from the tree. Collision check run on HEAD: `git grep -E '(^|[^A-Za-z0-9_-])<PREFIX>-[0-9]{1,4}([^0-9]|$)'` over the whole repo (excluding `docs/arrows/`) returns 0 hits for all 16 (re-run for `APP-IPC` after the split: 0 hits for `APP-IPC-<n>` and for bare `APP-IPC`); `git grep '@spec'` returns 0 hits (no annotation exists yet); a broader `\b<STEM>-[A-Z0-9]+` scan for `GAME`, `CONFIG`, `DISCORD`, `HELPER`, `IAC`, `RT`, `APP` also returns 0. Nearby identifiers use other separators and cannot collide: `GAME_PORTS`, `CONNECT_MESSAGES`, `HEALTH_CHECKS` (env vars), `CONFIG#discord`, `BASE#discord`, `PENDING#taskArn`, `LOCK/CURRENT` (DynamoDB keys).

| Leaf | Prefix | Example |
|---|---|---|
| iac/run | `IAC-RUN` | `IAC-RUN-001` |
| iac/engine | `IAC-ENGINE` | `IAC-ENGINE-001` |
| iac/program | `IAC-PROGRAM` | `IAC-PROGRAM-001` |
| game-runtime/task-and-dns | `RT-TASK` | `RT-TASK-001` |
| game-runtime/watchdog | `RT-WATCHDOG` | `RT-WATCHDOG-001` |
| game-runtime/health-check | `RT-HEALTH` | `RT-HEALTH-001` |
| operator-app/wizard-and-bootstrap | `APP-WIZARD` | `APP-WIZARD-001` |
| operator-app/diagnostics | `APP-DIAG` | `APP-DIAG-001` |
| operator-app/infra-logs | `APP-LOGS` | `APP-LOGS-001` |
| operator-app/app-update-and-release | `APP-UPDATE` | `APP-UPDATE-001` |
| operator-app/ipc-bridge | `APP-IPC` | `APP-IPC-001` |
| operator-app/desktop-shell | `APP-SHELL` | `APP-SHELL-001` |
| game-server | `GAME` | `GAME-001` |
| deployment-config | `CONFIG` | `CONFIG-001` |
| discord-bot | `DISCORD` | `DISCORD-001` |
| helper-task | `HELPER` | `HELPER-001` |

Prefix-of-prefix note: `IAC-RUN`/`IAC-ENGINE`/`IAC-PROGRAM` and the `RT-*`/`APP-*` families share stems but never a full prefix, so a grep for `IAC-RUN-` cannot match an `IAC-ENGINE-` id. Keep the number immediately after the prefix (`IAC-RUN-001`, not `IAC-RUN-LOCK-001`) to preserve that.

## 4. Awkward boundaries resolved

Each row: the file, who owns it, and the cross-reference the other leaf carries. **moved** = placement differs from the provisional brief or from lens C; reason given.

| File | Owner | Cited by (cross-reference) |
|---|---|---|
| `desktop-main/src/services/PulumiService.ts` (+ `modules/pulumi-service.module.ts`) | `iac/engine` | `iac/run` cites the 8-gate apply, pre-flight marker, partial-apply detection, destroy token, rollback resolve/confirm, stale-lock clear and env redaction it implements. Run's EARS will point at this file heavily; a later split of the 5 k-line orchestrator along the run/engine seam is recommended, not done here. |
| `desktop-main/src/controllers/games.controller.ts` | `game-server` (**moved** from task-and-dns) | `game-runtime/task-and-dns` cites `games.list/status/getStatus/start/stop`. Reason: 8 of its 13 channels are `games.create/update/delete/draft.*`, and the write path behind them (`GamesWriteService`, `GameWizardDraftService`) is game-server's. |
| `desktop-main/src/services/GamesWriteService.ts`, `mergeGameLists.ts`, `shared/src/gamesWrite.ts` | `game-server` | `deployment-config` cites the `DeploymentConfigService.addGameServer`/update/remove calls; `game-runtime/health-check` cites the app-owned health-check secret upsert/delete; `operator-app/diagnostics` cites the `AuditService.record` call. |
| `desktop-main/src/services/GameWizardDraftService.ts` | `game-server` (**moved** from lens C's deployment-config) | `deployment-config` none; `wizard-and-bootstrap` cites the `ElectronStoreService.addGameWizardDraft` slot. Reason: game-draft-persistence is about a game being declared, not the stored document. |
| `desktop-main/src/controllers/iac-settings.controller.ts` | `deployment-config` | `app-update-and-release` cites `iac.settings.autoUpdate.{get,update,check,download,install}` (5 of 8 channels); `iac/engine` cites `iac.settings.engineVersion`. Kept with config because the namespace and file name are the deployment-settings editor's; flag the auto-update channels as misplaced namespace (Open Question). |
| `infra/src/lambdas.ts` | `iac/program` | Per-function blocks cited by `task-and-dns` (update-dns rule), `watchdog` (rate rule, `IDLE_CHECKS`/`MIN_PACKETS` env), `health-check` (env, conditional role), `discord-bot` (interactions Function URL, `GAME_PORTS`/`CONNECT_MESSAGES`), `helper-task` (efs-seeder). |
| `infra/src/{discordDomain,dynamodb,secrets,escapes}.ts` | `iac/program` | `discord-bot` cites the CloudFront domain, tables, placeholder secrets with `ignoreChanges`, BASE#/CONFIG# seed rows; `helper-task` cites `escapes.ts` seeder invocations; `operator-app/diagnostics` cites the audit table. |
| `infra/src/{ecs,efs,envTokenWrapper,hostnameShim,securityGroups}.ts` | `iac/program` | `game-server` cites env-token substitution, ipv4 boot wrapper, pinned-hostname init container, Caddy sidecar for HTTPS, port-visibility SG rules; `helper-task` cites EFS access points and file-manager log group/SG; `health-check` cites its SG. |
| `shared/src/env.ts`, `envJson.ts` | `iac/program` | Lambda-side env parsing (`gameNamesFromEnv`, `parseGameMapEnv`, `familyToGameMap`) — the wire format of env the program bakes. Cited by every Lambda leaf. |
| `shared/src/pulumiVersion.ts` | `iac/engine` (**moved** from program) | `desktop-shell` (settings page shows it) and `app-update-and-release` (`packaging-manifest-pins.test.ts`) cite. Reason: the only runtime consumer is `PulumiEngineService.ts`; the infra program never imports it. |
| `shared/src/stackOutputs.ts`, `desktop-main/src/testing/stack-outputs.fixture.ts` | `iac/program` | `iac/engine` (`ConfigService` caches it) and every outputs reader cite. |
| `desktop-main/src/services/ConfigService.ts`, `modules/config.module.ts`, `controllers/env.controller.ts`, `services/electronRuntime.ts` | `iac/engine` | Every leaf reading stack outputs or region cites. `env.controller` (topbar env pill) cited by `desktop-shell`. `electronRuntime.ts` (userData path, Electron guard) cited by `wizard-and-bootstrap` (`GuidedIamService`, `CloudHealthService`). |
| `web/src/components/first-run-wizard/stack-init-step.component.tsx` | `iac/engine` | `wizard-and-bootstrap` cites it as its final step (`iac.stack.initialize` → `wizard.complete`). |
| `shared/src/relativeTime.ts` | `iac/run` | `iac/engine` cites (`PulumiLockRecovery` lock age). |
| `shared/src/errors.ts` | `iac/run` | `deployment-config` cites `OptimisticLockError`; `RunLockHeldError` has 10 consumers, all run/engine. |
| `shared/src/changeSummary.ts` | `iac/run` | `deployment-config` cites (`diffDeploymentConfig` returns it). |
| `web/src/components/ansi-log-viewer.component.tsx` | `iac/run` | — (uses `infra-logs`'s `ansi.utils.ts`). |
| `web/src/lib/ansi.utils.ts`, `components/log-line-display.component.tsx` | `operator-app/infra-logs` | `iac/run` (ansi-log-viewer) and `operator-app/diagnostics` (`DiagnosticsPanel`) cite. |
| `components/game-combobox.component.tsx` | `operator-app/infra-logs` | Sole consumer is the logs page. |
| `shared/src/secrets/secretsStore.ts` | `game-runtime/health-check` | `discord-bot` cites `getPublicKey` (used by interactions) and the dead `getBotToken/putBotToken/putPublicKey/invalidateSecretsCache`. Follows the brief; the file should be split (health-check helpers vs Discord helpers). |
| `web/src/components/add-game-wizard/health-check-fields.component.tsx` | `game-runtime/health-check` | `game-server` cites it as a section of the networking step. |
| `web/src/components/watchdog-panel.component.tsx` | `game-runtime/watchdog` | `desktop-shell` (settings page host) cites. Watchdog *settings fields* stay in `deployment-settings-form` (`deployment-config`), which watchdog cites. |
| `lambda/update-dns/src/handler.ts` | `game-runtime/task-and-dns` | `discord-bot` cites the `getPending` → `patchInteractionOriginal` → `deletePending` half. |
| `shared/src/formatStatus.ts` | `discord-bot` (**moved** from lens C's task-and-dns) | `task-and-dns` cites (update-dns uses `formatGameStatus`). Reason: both consumers render a Discord message; it's message formatting, not task state. |
| `shared/src/ddb/client.ts` | `discord-bot` | `ddb/client.ts`'s only consumers are Discord stores. |
| `web/src/components/snowflake-chips-input.component.tsx` | `discord-bot` | `deployment-config` cites (base allowlists in `deployment-settings-form`). Two of three consumers are Discord pages, and a snowflake is a Discord id. |
| `shared/src/cloud.ts` | `game-runtime/task-and-dns` | `CloudProvider`/`WorkloadStatus` are its own; `deployment-config` cites `RemoteFileStore`, `discord-bot` cites `SecretsStore`, `iac/run` cites the run-record store interface. |
| `desktop-main/src/modules/aws.module.ts` | `game-runtime/task-and-dns` | `infra-logs` (`LogsService`) and `helper-task` (`FileManagerService`, `SchedulerService`, `PublicIpService`) cite their providers there. |
| `desktop-main/src/modules/cloud-provider.module.ts`, `cloud-provider.tokens.ts` | `operator-app/desktop-shell` | Composition root binding seven cloud tokens. Every store-owning leaf cites its token; the region-resolver lines (`:80,109,131,180`) are cited by `task-and-dns`, `deployment-config`, `iac/run` for the region-of-truth question. |
| `desktop-main/src/controllers/validation.ts` | `operator-app/ipc-bridge` (**moved** from desktop-shell by the split) | IPC payload validation; `iac/run`, `discord-bot`, `helper-task` controllers cite. Reason: it shapes what a malformed payload crossing the bridge gets back, not anything about the window. |
| `desktop-preload/src/*` (incl. `hyveon-api.ts`, `stream-bridge.ts`, `test-mock-registry.ts`), `ipc-main-bridge.ts`, `rpc-error-message.filter.ts`, `web/src/api.service.ts`, `web/src/{globals,window}.d.ts`, `lib/bridge.utils.ts`, `desktop-main/src/testing/message-pattern.test-utils.ts` | `operator-app/ipc-bridge` | `desktop-shell` cites (`electron-entry.ts`/`main.ts` start the bridge; `app.component.tsx`'s chromium guard). Every leaf with a page or controller cites the channel it calls or serves; `test-mock-registry.ts` and `message-pattern.test-utils.ts` are the mock / channel-name seams every controller test and e2e spec uses. |
| `desktop-main/src/app.module.ts` | `operator-app/desktop-shell` | `ipc-bridge` cites (the Nest module tree the bridge dispatches into). Kept in the shell with `cloud-provider.module.ts` (own row) as composition root, not transport. |
| `web/e2e/specs/electron-smoke.spec.ts` | `operator-app/desktop-shell` | `ipc-bridge` cites (asserts `window.hyveon` is defined). Kept in the shell: most of its assertions are window chrome. |
| `desktop-main/src/services/{awsCredentialSource,awsClientCache,ElectronStoreService,SafeStorageService}.ts`, `cloud-aws/src/{cachedClient,awsRegionEnv}.ts` | `operator-app/wizard-and-bootstrap` | Credential custody. Every AWS-calling leaf cites. `ElectronStoreService` additionally cited by `game-server` (draft slot), `helper-task` (folder selection), `iac/engine` (lock-attempt records), `app-update-and-release` (`enableAutoUpdate`). |
| `desktop-main/src/services/CloudHealthService.ts`, `controllers/cloud-health.controller.ts`, `web/src/components/cloud-health-section.component.tsx` | `operator-app/wizard-and-bootstrap` | `desktop-shell` (settings host) cites. Lives in `WizardModule` and shares `iamPolicy.ts`/guided-IAM helpers. |
| `web/src/pages/settings.page.tsx`, `components/settings-row.component.tsx` | `operator-app/desktop-shell` | Host page only. Each section cites its owner: Reconfigure + cloud health (`wizard-and-bootstrap`), updates (`app-update-and-release`), deployment settings (`deployment-config`), watchdog panel (`watchdog`), diagnostics panel (`diagnostics`), engine version (`iac/engine`). |
| `web/src/components/error-boundary.component.tsx`, `lib/report-renderer-error.utils.ts` | `operator-app/diagnostics` | `desktop-shell` cites (`main.tsx` mounts the boundary and installs global reporting). |
| `web/src/components/stray-helpers-button.component.tsx` | `helper-task` | `diagnostics` cites (rendered in the diagnostics area). game-volume-folder-upload spec claims it. |
| `lambda/efs-seeder/**` | `helper-task` | `iac/program` cites (invoked synchronously from `escapes.ts` during apply). |
| `desktop-main/src/services/CostService.ts`, `controllers/costs.controller.ts`, `web/src/pages/costs.page.tsx`, `components/kpi-strip.component.tsx` | `game-runtime/task-and-dns` | `game-server` cites the Fargate pricing constants that live in `gameServerValidator.ts`. |
| `web/src/polling/game-status-provider.component.tsx` | `game-runtime/task-and-dns` | `desktop-shell` cites (registered in `polling-provider`). |
| `desktop-main/src/services/DriftService.ts`, `controllers/drift.controller.ts`, `shared/src/drift.ts`, `components/pending-changes-banner.component.tsx` | `deployment-config` | `game-server` cites (drift chips in `game-status-badges`, `games.page`). |
| `desktop-main/src/app-version.ts` | `operator-app/diagnostics` | `app-update-and-release` cites if version is shown with update status. |
| `.github/workflows/package.yml`, `.github/actions/build-package/action.yml` | `app-update-and-release` | PR-time packaging gate shares the build steps with `release.yml`; `desktop-shell` cites for app-icon packaging. |
| `electron-builder.yml` | `app-update-and-release` | `desktop-shell` cites (`files` closure, icons, preload/main outputs). |
| `app/test/packaging-manifest-pins.test.ts` | `app-update-and-release` | `iac/engine` cites (pins `@pulumi/*` and `PULUMI_ENGINE_VERSION`). |
| `web/src/hooks/use-click-outside.hook.ts` (+ `.test.ts`) | `operator-app/desktop-shell` (**moved** from `infra-logs`) | Generic click-away hook, not log-specific; `infra-logs` cites (`game-combobox.component.tsx` consumes it). |
| `shared/src/types.ts` | `game-runtime/task-and-dns` (**moved** from `discord-bot`) | Declares `GameStatus`/`StartResult`, the dashboard's own shapes; `discord-bot` cites (`formatStatus.ts` imports it); `diagnostics` cites `RendererLogEntry`. |
| `desktop-main/src/services/Ec2Service.ts` (+ `.test.ts`) | `helper-task` (**moved** from `task-and-dns`) | ENI/security-group ingress helper that `FileManagerService` (file-browser container) drives; `task-and-dns` cites (injected into `EcsService`, unused there). |
| `web/e2e/integration-specs/error-propagation.spec.ts` | `game-runtime/task-and-dns` (**moved** from `ipc-bridge`) | Exercises the `EcsService.start` refusal and RunTask error path end to end; `ipc-bridge` cites (asserts how those errors cross the bridge). |

## 5. Component-quality check

| Leaf | Independent system with an independent purpose? |
|---|---|
| `iac/run` | Yes — the run record + lock + approval window is a lifecycle with its own durable store (`AwsRunRecordStore`) and its own operator screen (IaC page, history); it can be specified as a transition table without describing Pulumi. |
| `iac/engine` | Yes — "make the Pulumi engine usable from a packaged desktop app" (download, workspace, passphrase, credentials, cancellation, lock recovery) is purpose-complete; it would be the same component for any program. |
| `iac/program` | Yes — a single inline Pulumi program whose output is a set of AWS resources plus `StackOutputs`; independent of how it is run. |
| `game-runtime/task-and-dns` | Yes — on-demand task start/stop plus the DNS shadow is the core cost model ("no persistent ECS Service", "DNS is Lambda-managed"). |
| `game-runtime/watchdog` | Yes — an autonomous scheduled stopper with its own state (task tags); thin but has an invariant of its own. |
| `game-runtime/health-check` | Yes — a self-contained verdict function (`engine.ts` is pure) with its own credentials model and spec. |
| `operator-app/wizard-and-bootstrap` | Yes — "get from a fresh install to a usable, credentialed AWS account" is one job; credential custody is included because it is the durable product of that job. |
| `operator-app/diagnostics` | Yes, with a caveat — app log, bundle and renderer error forwarding are one purpose (support evidence); audit rides along as "record of app activity". Audit could become its own leaf if it gains a spec. |
| `operator-app/infra-logs` | Yes — CloudWatch readback with a viewport state machine (live/paused/historical) and its own spec. |
| `operator-app/app-update-and-release` | Yes — producer (release workflow) and consumer (updater) of one artifact: the GitHub release feed (lens E's "release feed" truth). |
| `operator-app/ipc-bridge` | Yes — one transport with its own invariants ("no HTTP transport", "secrets never reach the renderer", `window.hyveon` naming) and its own test seam; it can be specified as a channel contract without describing any page. |
| `operator-app/desktop-shell` | **Scrutinised — acceptable after the split.** See below. |
| `game-server` | Yes — the game declaration and its validation are one model; every per-game resource fans out from it. |
| `deployment-config` | Yes — owns one object (`deployment-config.json`), its versions, settings and drift; purpose = "what should exist". |
| `discord-bot` | Yes — a fully serverless subsystem with its own entry point (Function URL), permission model (`canRun`) and config store. |
| `helper-task` | Yes — the throwaway FileBrowser task + upload engine + seeder all serve "get bytes onto the volume". |

**desktop-shell / ipc-bridge.** At 102 files the original `desktop-shell` was the leaf most at risk of being a "frontend glue" bucket, and the split offered here was applied on user approval. `ipc-bridge` (24 files) takes the transport: preload (`window.hyveon`, `stream-bridge`, the `__test.mock()` registry), `ipc-main-bridge.ts`, `rpc-error-message.filter.ts`, `validation.ts`, `api.service.ts`, the `Window.hyveon` type augmentation and `lib/bridge.utils.ts`, plus the specs that exercise the bridge itself. Its purpose is *a typed, secret-free channel between window and back end*, backed by `preload-bridge-naming`, the no-HTTP / mock-seam half of `desktop-only-operator-surface`, and the "secrets never reach the renderer" invariant. `desktop-shell` (78 files) keeps *give the operator one window*: entry/main/composition root (`app.module`, `cloud-provider.module` — kept here rather than in the bridge as earlier suggested, because it binds cloud tokens rather than carrying messages), window chrome + `WindowService` (`custom-title-bar`), app icon (`app-icon`), layout/topbar/nav, route table/first-run gate, polling heartbeat, the settings host page, and the UI-integrity half of `desktop-only-operator-surface`. The residual smell is the ~30 presentation primitives (`components/ui/*` ×16, `section-card`, `async-content`, `empty-state-card`, `error-banner`, `inline-alert`, `loading-state`, `confirm-dialog`, `page-header`, `lib/{utils,format,confirm-skip}.utils.ts`, `use-copied-reset`, `DESIGN.md`, `components.json`) and the host `settings.page.tsx` — carried, not purposeful. Recommendation: write `APP-SHELL` EARS only for the spec-backed surfaces (window chrome, app icon, polling heartbeat, route table/first-run gate) and treat the primitives as carried code whose only requirement is conformance to `DESIGN.md` tokens.

No other leaf smells like a deploy-unit, team, or utils grouping. `iac/program` is one package, but its purpose (declaring resources) is domain-level; the Lambda leaves cross package lines deliberately.

## 6. Sweep disagreements by leaf (→ Open Questions)

From inventory §4. A disagreement touching several leaves is listed under its primary owner and cited from the others.

- **iac/run**
  - `partialApply` persistence: `AwsRunRecordStore.ts:189-207,336-374` neither writes nor reads it (sweep-7), while sweeps 3/5/10 describe it as durable (`PulumiService.ts:2037`, `RunRecordService.ts:439-475`, `iac.page.tsx:55-82`, `iac.md:161-180`).
  - Durable run lock before first apply: `RunService.ts:179-195` skips the DynamoDB lock without `runsTableName` (sweep-5), while `cloud-provider.module.ts:174-175` gives the store a pre-apply fallback (sweep-6). Cited from `desktop-shell`.
- **iac/engine**
  - Pulumi passphrase machine-bound (`pulumi-infra-program`) vs portable (`pulumi-engine-runtime`, matches code). Cited from `iac/program`.
- **iac/program**
  - efs-seeder always-on (`lambda-runtime-currency`) vs conditional (CLAUDE.md, code). Cited from `helper-task`.
  - "Five vs six Lambdas" — code comments say 5 (log-tailable), CLAUDE.md and packages say 6. Primary in `infra-logs`.
- **game-runtime/task-and-dns**
  - Region of truth: `AwsCloudProvider` config uses `outputs.awsRegion` while raw `EcsService`/`Ec2Service` clients use `ConfigService.getRegion()` (`EcsService.ts:71` vs `:213`); stores split the same way (`cloud-provider.module.ts:80,109,131,180`). Cited from `deployment-config`, `iac/engine`, `desktop-shell`.
  - Costs sidebar link: `e2e/pages/CostsPage.ts:12,22-23` TODO says Costs is not in the sidebar; `app-nav.component.tsx:20-59` and `polling.spec.ts:45-51` show it is.
  - Fargate pricing in three places (`gameServerValidator.ts`, cloud-aws re-export, `AwsCloudProvider.estimateHourlyCost`); `CostEstimates` declared in `CostService.ts`, `hyveon-api.ts`, `api.service.ts`.
- **game-runtime/watchdog**
  - None of its own; inherits the health-check viability question (watchdog invokes health-check).
- **game-runtime/health-check**
  - Viability: sweep-8 says it cannot initialise (`ECS_CLUSTER` missing in `lambdas.ts:552`; no AWS-API egress in `securityGroups.ts:430-446`); `docs/docs/components/lambdas.md:304-363` and the `game-health-checks` spec describe it as working.
  - Spec sync hazard: re-applying `add-pluggable-health-checks` would regress main's auth-type wording.
- **operator-app/wizard-and-bootstrap**
  - `GUIDED_PROFILE_NAME` defined in both `desktop-preload/src/hyveon-api.ts:1968` and `GuidedIamService.ts:94`. Cited from `ipc-bridge`.
  - Wizard state file name and step order differ across specs.
  - `CloudHealthService` lives in `WizardModule` but is a Settings feature.
- **operator-app/diagnostics**
  - `DiagnosticsPanel.tsx` is the lone PascalCase component (naming, not behaviour).
- **operator-app/infra-logs**
  - "Five vs six Lambdas" (`infrastructure-logs.page.tsx:58`, `logs.controller.ts:220`, `LogsService.ts:585` vs CLAUDE.md; docs `management-app.md:14`, `app/index.md:111`, `lint.yml:49`).
- **operator-app/app-update-and-release**
  - `enableAutoUpdate` gate vs manual check/fallback (spec contradiction).
  - Spec sync hazard: re-applying `add-release-automation` would regress main (rewritten by #664/#665).
- **operator-app/ipc-bridge**
  - Two IPC facades: `api.service.ts` wraps some namespaces; `iac.*`, `logs.*`, `wizard.*`, `iac.settings.*` are called on `window.hyveon` directly.
  - Chromium e2e tier vs no-HTTP invariant: `hyveon-http-bridge.ts` serves a fictional `/api/*` map; `app.component.tsx:33-40` and `use-deployment-settings.hook.ts:171-184` guard only for it.
  - `ipc-main-bridge.ts:99-100` says "no NestJS exception filter anywhere" while `RpcErrorMessageFilter` is registered (stale comment).
  - `validation.ts:14-16` says Nest "maps to a 400 with the same shape the legacy Express handlers used" — stale; there is no HTTP transport (sweep-6).
- **operator-app/desktop-shell**
  - None of its own beyond those cited above (region-of-truth and pre-first-apply lock lines in `cloud-provider.module.ts`).
- **game-server**
  - Spec sync hazards: icmp/https deltas on `game-port-visibility` (main is a hand-merge); `game-https-configuration` main lacks constraint 5 from its delta.
- **deployment-config**
  - Inherits region of truth (`AwsRemoteFileStore` uses `getRegion()`, other stores `outputs.awsRegion`).
- **discord-bot**
  - Two Discord event receivers: `shared/src/discord/awsLambdaDiscordReceiver.ts` (reads `discord_interactions_url`, no consumers) vs `cloud-aws/src/AwsDiscordEventReceiver.ts` (reads `interactionsInvokeUrl`); `DISCORD_RECEIVER` token not consumed outside DI.
  - No OpenSpec capability exists.
- **helper-task**
  - `use-folder-seed.hook.ts` sits under `components/` not `hooks/`; `PublicIpService`/`SchedulerService` serve only `FileManagerService` but are provided by `AwsModule` (`task-and-dns`).

## 7. Active OpenSpec changes → leaf

State from `sweep-10.md` (tasks ticked / total on HEAD).

| Change | Primary leaf | Also touches | State |
|---|---|---|---|
| `add-healthcheck-auth-type` | `game-runtime/health-check` | `game-server` (validator, wizard fields) | Shipped (#530) + synced (#644), unarchived; 27/27; verify.md says ready for archive. |
| `add-pluggable-health-checks` | `game-runtime/health-check` | `watchdog`, `iac/program` (lambda-runtime-currency delta) | Shipped + synced, unarchived; 29/29. Re-applying its delta would regress main (superseded by auth-type) — archive without spec application, before auth-type. |
| `add-scripted-health-checks` | `game-runtime/health-check` | `iac/program` | Not started; 0/28. Written against pluggable-health-checks; credential model needs reconciling with auth-type. |
| `add-icmp-ingress` | `game-server` | `iac/program` (`securityGroups.ts`) | Shipped + synced, unarchived; 16/16. Main `game-port-visibility` is a hand-merge — archive must skip spec application. |
| `https-explicit-web-port` | `game-server` | `iac/program` (Caddy, SG), `deployment-config` (read-time normaliser) | Shipped (#688/#689/#691) + synced, unarchived; 15/15. Main is missing constraint 5 from the delta. |
| `add-pinned-hostname` | `game-server` | `iac/program` (`hostnameShim.ts`), `diagnostics` (bundle allowlist) | Shipped (#692), **not synced** (no `game-hostname-pinning` main spec), unarchived; 20/22 (2 manual tasks). |
| `add-release-automation` | `operator-app/app-update-and-release` | — | Shipped (#495) + synced (#644), unarchived; 18/26 (open tasks are admin/live-verification, de facto done). Re-applying would regress main. |
| `add-update-feed-fallback` | `operator-app/app-update-and-release` | — | Shipped + synced, unarchived; 6/6. |
| `add-user-initiated-update-install` | `operator-app/app-update-and-release` | `desktop-shell` (settings host), `deployment-config` (`iac-settings.controller.ts` channels) | Shipped, **not synced**, unarchived; 11/11. Must be applied after add-update-feed-fallback. |
| `add-vpc-flow-logs` | `operator-app/infra-logs` | `iac/program` (flow log + IAM role), `deployment-config` (toggle) | Not started; 0/22. Proposes new capability `vpc-flow-logs`. |
| `embed-file-browser` | `helper-task` | `iac/program` (`efsVolumeAccessPoints` output), `game-server` (detail-page Files link, `games.start` upload guard), `game-runtime/task-and-dns` (dashboard Files navigation, `EcsService.tagTask`/`findRunningTaskOrThrow`), `operator-app/ipc-bridge` (`volumeFiles` preload namespace, `ipc-broadcast.ts` push forwarding), `operator-app/desktop-shell` (`/games/:name/files` route, `NativeDialogModule`, helper quit hook wiring), `operator-app/diagnostics` (export dialog via `NativeDialogService`) | Shipped (PRs #694, #695, #696, #698, #699; stack #697), synced, and archived as `openspec/changes/archive/2026-10-30-embed-file-browser/` by #701 (42/42 tasks). Created main capability `game-volume-file-browser` (the 37th) and updated `game-volume-folder-upload`. No longer an active change. |
