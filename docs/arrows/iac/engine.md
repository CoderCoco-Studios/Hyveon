# Arrow: engine

The machinery that actually runs Pulumi inside the app: downloads the pinned engine, opens the stack, supplies credentials, cancels and recovers stuck operations, caches the resulting stack outputs.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.

Engine provisioning, the workspace seam, credential exclusivity and provable-ownership lock recovery are implemented and heavily unit-tested; every active spec is implemented or deferred; the remaining work is structural: a 5,000-line `PulumiService.ts` shared with `iac/run` that carries triplicated streaming code and many stale comments.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/iac/iac-design.md` (sub-HLD)

### LLD
- `docs/intent/iac/engine/engine-design.md`

### EARS
- `docs/intent/iac/engine/engine-specs.md` (94 specs)

### Tests
- `app/packages/desktop-main/src/controllers/env.controller.test.ts`
- `app/packages/desktop-main/src/services/ConfigService.test.ts`
- `app/packages/desktop-main/src/services/PulumiCancellation.test.ts`
- `app/packages/desktop-main/src/services/PulumiCredentialResolver.test.ts`
- `app/packages/desktop-main/src/services/PulumiEngineService.test.ts`
- `app/packages/desktop-main/src/services/PulumiLeakedPromise.test.ts`
- `app/packages/desktop-main/src/services/PulumiLockRecovery.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.apply.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.clearStaleLock.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.destroy.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.initializeStack.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.preview.test.ts`
- `app/packages/desktop-main/src/services/PulumiService.rollback.test.ts`
- `app/packages/desktop-main/src/services/PulumiWorkspaceService.test.ts`
- `app/packages/web/e2e/integration-specs/config-service.spec.ts`
- `app/packages/web/e2e/integration-specs/pulumi-di-seam.spec.ts`
- `app/packages/web/e2e/integration-specs/stack-outputs.spec.ts`
- `app/packages/web/src/components/first-run-wizard/stack-init-step.component.test.tsx`

### Code

**desktop-main** (`@hyveon/desktop-main`)
- `app/packages/desktop-main/src/services/PulumiService.ts`
- `app/packages/desktop-main/src/services/PulumiEngineService.ts`
- `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`
- `app/packages/desktop-main/src/services/PulumiCredentialResolver.ts`
- `app/packages/desktop-main/src/services/PulumiLockRecovery.ts`
- `app/packages/desktop-main/src/services/PulumiCancellation.ts`
- `app/packages/desktop-main/src/services/PulumiLeakedPromise.ts`
- `app/packages/desktop-main/src/services/ConfigService.ts`
- `app/packages/desktop-main/src/services/electronRuntime.ts`
- `app/packages/desktop-main/src/controllers/env.controller.ts`
- `app/packages/desktop-main/src/modules/config.module.ts`
- `app/packages/desktop-main/src/modules/pulumi-engine.module.ts`
- `app/packages/desktop-main/src/modules/pulumi-service.module.ts`
- `app/packages/desktop-main/src/modules/pulumi-workspace.module.ts`
- `app/packages/desktop-main/src/test-mocks/pulumi-mock.ts`
- `app/packages/desktop-main/src/testing/config-service.fixture.ts`

**shared** (`@hyveon/shared`)
- `app/packages/shared/src/pulumiVersion.ts`

**web** (`@hyveon/web`)
- `app/packages/web/src/components/first-run-wizard/stack-init-step.component.tsx`

### Cited from other leaves
- `iac/run`: `RunService.ts`, `RunRecordService.ts`, `LockClearConfirmationGate.ts`, `iac.controller.ts` (drives `PulumiService` over IPC, e.g. `iac.stack.initialize` at `iac.controller.ts:668`), `app/packages/shared/src/relativeTime.ts` (`formatRelativeAge` behind `PulumiLockRecovery.formatLockAge`), `app/packages/shared/src/errors.ts`. Run's gate logic (8-step apply gate, pre-flight marker, partial-apply detection, destroy token, rollback, stale-lock clear) physically lives in `PulumiService.ts`.
- `iac/program`: `app/packages/infra/src/program.ts` (`createInfraProgram`, consumed at `PulumiService.ts:1619,2278`), `app/packages/shared/src/stackOutputs.ts` and `app/packages/desktop-main/src/testing/stack-outputs.fixture.ts` (the `StackOutputs` shape `ConfigService` caches).
- `operator-app/wizard-and-bootstrap`: `ElectronStoreService.ts` (bootstrap bucket names, `aws.region`, legacy `pulumi.passphrase`, `stackInitialized`, lock-attempt records, orphaned-rollback record), `awsCredentialSource.ts` (source resolution behind `PulumiCredentialResolver`), `SafeStorageService.ts`.
- `deployment-config`: `iac-settings.controller.ts` (`iac.settings.engineVersion` at `iac-settings.controller.ts:210`), `DeploymentConfigService.ts` (reads `ConfigService.readEnvConfigCacheTtlMs()` at `DeploymentConfigService.ts:301`; `restoreRawConfig` behind `DEPLOYMENT_CONFIG_SERVICE`).
- `operator-app/app-update-and-release`: `app/test/packaging-manifest-pins.test.ts` (pins `PULUMI_ENGINE_VERSION` against the `@pulumi/pulumi` manifests).
- `operator-app/desktop-shell`: `settings.page.tsx` (engine-version row), top-bar env pill (consumer of `env.get`), `cloud-provider.module.ts` (store region resolvers, governed by `IAC-ENGINE-REGION-002`).
- `game-runtime/task-and-dns`: `EcsService.ts` (`buildProviderConfig` and `getClient` regions, governed by `IAC-ENGINE-REGION-002`).
- `app/packages/desktop-main/src/electron-entry.ts` (quit lifecycle; see finding 2).

## Architecture

**Purpose:** Make the Pulumi engine usable from a packaged desktop app with no operator-installed tooling: provision the exact pinned CLI, construct one stable Automation API workspace against the operator's own S3 state bucket, inject the wizard-selected credentials exclusively, run operations with cancellation and leaked-promise recovery, recover stale backend locks only on provable ownership, and expose the deployed stack outputs to the rest of the app through a memoised reader.

**Key Components:**
1. `PulumiEngineService` (`PulumiEngineService.ts:308`, `resolve()` at `:361`): installs `PULUMI_ENGINE_VERSION` into `<userData>/pulumi/versions/<pin>` via staging, rename, re-verify and swap-aside (`:471-585`); memoises the in-flight promise and resets on rejection (`:363-368`); exact-pin check on top of the SDK's minimum-version check (`:594-598`); three typed errors (network, integrity, cache-write) via `classifyProvisioningError` (`:198-211`).
2. `PulumiWorkspaceService` (`PulumiWorkspaceService.ts:333`, `getOrCreateStack()` at `:396`): stable `pulumi-workspace/{home,workspace/production}` dirs (`:748-794`), `s3://<bucket>?region=<r>` DIY backend plus `AWS_REGION` (`:423,475-485`), passphrase derived as HMAC-SHA256 of account id + stack name from a live `sts:GetCallerIdentity` (`:95-99,425-435`), one-time legacy passphrase migration via `pulumi stack change-secrets-provider` (`:447-473,592-702`), sets `pulumi.stackInitialized` only on success (`:512`).
3. `PulumiCredentialResolver` (`resolveCredentialEnvVars` at `PulumiCredentialResolver.ts:84`): profile path sets `AWS_PROFILE` and blanks pasted-key vars; pasted path sets keys and blanks `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE` (`:98-122`); no source throws `PulumiCredentialsNotConfiguredError` (`:95-97`).
4. `PulumiLockRecovery` (`classifyStackLockConflict` at `PulumiLockRecovery.ts:256`): parses DIY lock lines, requires identity match, dead PID (`ESRCH` only) and a distinct fresh (≤2 h) ownership record started at or before each lock (`:211-220,289-297`) before classifying as `reclaimable-own-orphan`; otherwise `PulumiUnrecognizedLockError` naming holder and age (`:343-368`).
5. `PulumiCancellation` (`runWithEscalatingCancellation` at `PulumiCancellation.ts:188`): forwards the abort signal to the SDK, short-circuits a pre-aborted signal (`:197-202`), and after 30 s (`:68`) abandons the promise with `PulumiOperationEscalatedError` (`:226-238`).
6. `PulumiLeakedPromise` (`runTreatingLeakedPromiseAsSuccess` at `PulumiLeakedPromise.ts:194`): treats the SDK's post-success "promises still active" throw as success and rebuilds the result via a caller callback.
7. `PulumiService` (`PulumiService.ts:652`): the orchestrator: `getStackOutputs()` (`:968`), `initializeStack()` with engine/plugins/operation phases (`:1113-1181`), `preview()`/`previewCore()` (`:1444,1533`), `apply()` (`:1968`), `destroy()` (`:2852`), `confirmRollback()` (`:3580`), `clearStaleLock()` (`:3701`), `streamRunOutput()` (`:4163`); in-process `operationInFlight`/`stackInitInFlight` guards (`:677,777`); lazy `ModuleRef` lookups for run, config, remote-file-store and deployment-config tokens to break an ESM import cycle (`:836-938`).
8. `ConfigService` (`ConfigService.ts:33`): memoised `getStackOutputs()` (`:130-174`) with a 20 s TTL on a cached `null` (`:99`), `getConfigurationBucket()` (`:233`), `getRegion()` (`:262`), `readEnvConfigCacheTtlMs()` (`:194`); bound to `CONFIG_CACHE_INVALIDATOR` in `config.module.ts:57`.
9. `electronRuntime.ts`: `resolveUserDataPath`/`readIsPackaged`/`readResourcesPath`, guarded on `process.versions.electron` so the plain-Node integration harness can load the module (`electronRuntime.ts:17-61`).
10. `EnvController` (`env.controller.ts:19`, channel `env.get`): top-bar env pill from `outputs.awsRegion`/`domainName`.
11. `StackInitializationStep` (`stack-init-step.component.tsx`): final wizard step; streams `iac.stack.initialize` phase events into a three-row checklist (`:124-155`).
12. `PULUMI_ENGINE_VERSION` (`pulumiVersion.ts:21`, `'3.255.0'`) and `PulumiServiceStub` (`pulumi-mock.ts`), the DI-seam double the web integration harness injects in place of `PulumiService`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Engine provisioning | `IAC-ENGINE-PROV-001` to `IAC-ENGINE-PROV-012` | 11 | 1 | 0 |
| Engine version pin | `IAC-ENGINE-PIN-001` to `IAC-ENGINE-PIN-005` | 5 | 0 | 0 |
| Engine provisioning failure | `IAC-ENGINE-PFAIL-001` to `IAC-ENGINE-PFAIL-006` | 6 | 0 | 0 |
| Workspace seam | `IAC-ENGINE-WS-001` to `IAC-ENGINE-WS-010` | 10 | 0 | 0 |
| Secrets passphrase | `IAC-ENGINE-PASS-001` to `IAC-ENGINE-PASS-008` | 8 | 0 | 0 |
| Credentials | `IAC-ENGINE-CRED-001` to `IAC-ENGINE-CRED-006` | 6 | 0 | 0 |
| Output redaction | `IAC-ENGINE-REDACT-001` to `IAC-ENGINE-REDACT-005` | 5 | 0 | 0 |
| Stale backend lock recovery | `IAC-ENGINE-LOCK-001` to `IAC-ENGINE-LOCK-010` | 10 | 0 | 0 |
| Engine process lifecycle | `IAC-ENGINE-LIFE-001` to `IAC-ENGINE-LIFE-009` | 8 | 1 | 0 |
| Leaked-promise recovery | `IAC-ENGINE-LEAK-001` to `IAC-ENGINE-LEAK-003` | 3 | 0 | 0 |
| Stack initialization | `IAC-ENGINE-INIT-001` to `IAC-ENGINE-INIT-007` | 7 | 0 | 0 |
| Stack outputs | `IAC-ENGINE-OUT-001` to `IAC-ENGINE-OUT-011` | 11 | 0 | 0 |
| Install region | `IAC-ENGINE-REGION-001` to `IAC-ENGINE-REGION-002` | 2 | 0 | 0 |
| Electron runtime guard | `IAC-ENGINE-RT-001` to `IAC-ENGINE-RT-003` | 3 | 0 | 0 |

**Summary:** 95 of 97 active specs implemented; 2 deferred; 0 gaps.

## Key Findings

1. **Output redaction is state-derived and fails closed for every operation**: preview, apply and destroy build one set with `loadRedactionSet`, the union of the stack state's `appliedGameServers` and the configuration the operation was built from (destroy reads the stored configuration object best-effort). An unreadable stack state fails the operation before the engine runs; an empty state (first-ever apply) leaves only the configuration source. Values under 4 characters are skipped, matching is literal, multi-line values contribute each line, and longer values go first (`IAC-ENGINE-REDACT-002` to `IAC-ENGINE-REDACT-005`).
2. **Quit waits for in-flight operations to wind down**: `installOperationQuitHook` prevents the first `before-quit`, calls `PulumiService.abortInFlightOperations()`, waits up to 15 s for `PulumiService.whenIdle()` and the file manager helper stopper, then calls `quit()` once; a 10 s force-exit timer after `quit()` is the backstop (`IAC-ENGINE-LIFE-009`). Whether Electron exits cleanly with a live `pulumi` child without the force-exit is `[unverified]`.
3. **Escalation wording is honest**: escalation abandons the promise and says so (`IAC-ENGINE-LIFE-004`). Only `initializeStack` passes `onEscalate`, and its hook merely records that the run escalated; it does not kill the child, so an escalated `pulumi` child keeps running. Escalated runs deliberately keep their lock-ownership record as reclaim evidence.
4. **Stack initialization is cancellable and lock-recoverable**: `initializeStack(onPhase?, signal?)` runs `refresh()` through `runWithEscalatingCancellation`, the leaked-promise wrapper and the shared `runWithOwnOrphanLockRecovery` (`IAC-ENGINE-LIFE-007`, `IAC-ENGINE-LOCK-010`). No operator cancel channel exists yet (`IAC-ENGINE-LIFE-006`, deferred with `IAC-RUN-CANCEL-001`).
5. **Passphrase is portable**: code derives a per-AWS-account passphrase (`PulumiWorkspaceService.ts:95-99,425-435`), never stored; `iac/engine` owns the decision.
6. **Legacy passphrase migration restores a missing project file**: `restoreProjectSettingsFileIfMissing` writes a minimal `Pulumi.yaml` before the migration CLI runs, so a wiped `workDir` no longer dead-ends (`IAC-ENGINE-PASS-008`). Every Pulumi read, including `getStackOutputs`, can still trigger the migration.
7. **`getStackOutputs` is a write-capable, flaky read**: it returns `null` whenever any operation or stack init is in flight (`PulumiService.ts:970-976`), and `ConfigService` caches that `null` for 20 s (`ConfigService.ts:99,145-150`). It goes through `getOrCreateStack`, which calls `Stack.createOrSelect` (`PulumiWorkspaceService.ts:508`) and can run the legacy migration, so a dashboard poll can create a stack or re-encrypt secrets [inferred].
8. **Lock-recovery side effects and identity scope**: `classifyStackLockConflict` prunes and consumes ownership records as a side effect of classifying (`PulumiLockRecovery.ts:281,301`). The app never calls `requestSingleInstanceLock` (`:33-34`), so a second instance on the same host shares the identity; the dead-PID check (`:217`) is what stops a live sibling's lock being reclaimed.
9. **Engine cache hygiene**: `pruneOldVersions` reclaims crashed-install `.staging-`/`.trash-` directories and every engine log normalises the error message (`IAC-ENGINE-PROV-012`, `IAC-ENGINE-PFAIL-006`). `getEngineCacheRoot` says it mirrors `ConfigService.getRunsDir()`, which does not exist; the method is `PulumiService.getRunsDir`.
10. **Raw `process.env` in business logic**: `PulumiService.ts:4341` (`HYVEON_CONFIG_BUCKET`), `:4360` (`RUNS_DIR_PATH`), `:4397` (`HYVEON_LAMBDA_BUNDLES_DIR`); `PulumiEngineService.ts:656`; `PulumiWorkspaceService.ts:787`. `PulumiService.getConfigurationBucket` (`:4339-4343`) duplicates `ConfigService.getConfigurationBucket` (`ConfigService.ts:233-238`) because of the import cycle (`PulumiService.ts:195-208`). Violates `typescript-conventions.md` rule 2.
11. **Duplication past the `duplication.md` threshold**: chunk-streaming setup and drain loop three times (`PulumiService.ts:1635-1714`, `:2285-2406`, `:3027-3141`); identical outcome switches three times (`:3909-3918`, `:3926-3935`, `:4054-4063`); hand-rolled destroy token (`:2734-2744,3798-3838`) beside the shared `LockClearConfirmationGate` used for lock clear (`:700-707,3853-3888`).
12. **Stale comments in the orchestrator and its modules**: Terraform-era `plan()`/`spawnAndStream` references (`PulumiService.ts:1566,1635,1671,1685,1698,1737`); "no `PulumiController` yet" (`:1854,2700,3893`) although `IacController` drives the service; `:2114-2115` says destroy never touches `RunLockService` but destroy calls `createRun` (`:2960`). `PulumiWorkspaceService.ts:800-801` says "three constructor dependencies" (two, `:335-338`). `pulumi-workspace.module.ts:10-11` describes an "encrypted passphrase accessor pair" that "gates generating one", though the passphrase is now derived. `ConfigService.ts:102-104` cites `/api/games`/`/api/status` handlers that no longer exist; `:27` lists only `AWS_DEFAULT_REGION` though `CONFIG_CACHE_TTL_MS` and `HYVEON_CONFIG_BUCKET` are also read; `:9-13` documents the TTL as `DeploymentConfigService`'s.
13. **Dead code**: `ConfigService.readResourcesPath` (`ConfigService.ts:213-215`) has no caller in desktop-main (only `PulumiService.ts:4401` uses its own delegate). `getActiveCloud()` is hard-coded `'aws'` (`:276-278`).
14. **Test double drift**: `PulumiOperationName` re-declares `getOperationInFlight`'s union by hand (`pulumi-mock.ts:10-11`). `ConfigService.test.ts:279-283` is titled "should default to 30000 and warn" but never asserts the warn (sweep-4) `[unverified]`. `PulumiServiceStub` now implements `mintLockClearConfirmationToken` (`IAC-ENGINE-RT-003`).
15. **Phase attribution is accurate**: a `getOrCreateStack` failure after the engine phase ended emits an `operation` start/end pair so the wizard marks the `operation` row (`IAC-ENGINE-INIT-005`).

## Work Required

Every active spec in `docs/intent/iac/engine/engine-specs.md` is implemented or deferred; the items below are structural and carry no gap spec.

### Must Fix
None.

### Should Fix
8. Extract the triplicated streaming setup, outcome switches and destroy-token gate; reuse `LockClearConfirmationGate` for destroy (finding 11).
9. Move raw `process.env` reads behind stubbable accessors and remove the duplicated `getConfigurationBucket` once the import cycle allows it (finding 10).
12. Remove stale comments and dead `ConfigService.readResourcesPath` (findings 12, 13).
13. Derive `PulumiOperationName` in `pulumi-mock.ts` from the real type (finding 14).
14. Split `PulumiService.ts` along the run/engine seam (run gates, locking and run lifecycle for `iac/run`; workspace, backend, credentials and engine plumbing for this leaf) as its own pure-refactor change with no behaviour change. This removes the `run` <-> `engine` cycle in `docs/arrows/index.yaml` (`iac-design.md`, decision 10; `engine-design.md`, Decisions & Alternatives, "File layout").

### Nice to Have
15. Give `getStackOutputs` a select-only, migration-free path so reads cannot create a stack (finding 7).
