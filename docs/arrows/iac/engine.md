# Arrow: engine

The machinery that actually runs Pulumi inside the app: downloads the pinned engine, opens the stack, supplies credentials, cancels and recovers stuck operations, caches the resulting stack outputs.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.

Engine provisioning, the workspace seam, credential exclusivity and provable-ownership lock recovery are implemented and heavily unit-tested; gaps are destroy-output redaction, quit-time termination of an in-flight engine, an uncancellable stack initialization, and a 5,004-line `PulumiService.ts` shared with `iac/run` that carries triplicated streaming code and many stale comments.

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
- `operator-app/desktop-shell`: `settings.page.tsx` (engine-version row), top-bar env pill (consumer of `env.get`), `cloud-provider.module.ts` (store region resolvers `:80,109,131,180,198`, governed by `IAC-ENGINE-REGION-002`).
- `game-runtime/task-and-dns`: `EcsService.ts` (`buildProviderConfig` region at `:72` and `getClient` at `:213-217`, governed by `IAC-ENGINE-REGION-002`).
- `app/packages/desktop-main/src/electron-entry.ts` (quit lifecycle; see finding 2).

### OpenSpec sources
- `openspec/specs/pulumi-engine-runtime/spec.md`: primary capability, 7 requirements / 32 scenarios. Synced main spec; no active change under `openspec/changes/` touches it (final-clustering §7).
- `openspec/specs/pulumi-infra-program/spec.md`: cited only for its contradicting passphrase sentence (`spec.md:70`), owned by `iac/program`.
- `openspec/specs/wizard-flow/spec.md`: "Stack initialization step with phased progress" (`spec.md:75`) and "Resolved Pulumi engine version in Settings" (`spec.md:137`) are rendered by this leaf's `stack-init-step` and `pulumiVersion.ts`, but the capability is owned by `wizard-and-bootstrap`.

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

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `pulumi-engine-runtime` | 7 | 32 | Provisioning, pin, typed failures, workspace seam, passphrase derivation + migration, credential exclusivity and provable-ownership lock recovery match code. "App quits with an operation in flight" has no implementing code path (finding 2). "Every operation MUST be cancellable" does not hold for `initializeStack` (finding 4). "Credentials are not logged" holds for credentials, but destroy output skips the separate env-value redaction (finding 1). Escalation wording in code contradicts the spec's "logical escalation, not a literal forced kill" (finding 3). Passphrase portability contradicts `pulumi-infra-program` (finding 5). |

**OpenSpec summary:** `wizard-flow`'s stack-init and engine-version requirements are cited, not carried.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Engine provisioning | `IAC-ENGINE-PROV-001` to `IAC-ENGINE-PROV-012` | 10 | 0 | 2 |
| Engine version pin | `IAC-ENGINE-PIN-001` to `IAC-ENGINE-PIN-005` | 5 | 0 | 0 |
| Engine provisioning failure | `IAC-ENGINE-PFAIL-001` to `IAC-ENGINE-PFAIL-006` | 5 | 0 | 1 |
| Workspace seam | `IAC-ENGINE-WS-001` to `IAC-ENGINE-WS-010` | 10 | 0 | 0 |
| Secrets passphrase | `IAC-ENGINE-PASS-001` to `IAC-ENGINE-PASS-008` | 7 | 0 | 1 |
| Credentials | `IAC-ENGINE-CRED-001` to `IAC-ENGINE-CRED-006` | 6 | 0 | 0 |
| Output redaction | `IAC-ENGINE-REDACT-001` to `IAC-ENGINE-REDACT-002` | 1 | 0 | 1 |
| Stale backend lock recovery | `IAC-ENGINE-LOCK-001` to `IAC-ENGINE-LOCK-010` | 9 | 0 | 1 |
| Engine process lifecycle | `IAC-ENGINE-LIFE-001` to `IAC-ENGINE-LIFE-009` | 5 | 0 | 4 |
| Leaked-promise recovery | `IAC-ENGINE-LEAK-001` to `IAC-ENGINE-LEAK-003` | 3 | 0 | 0 |
| Stack initialization | `IAC-ENGINE-INIT-001` to `IAC-ENGINE-INIT-007` | 6 | 0 | 1 |
| Stack outputs | `IAC-ENGINE-OUT-001` to `IAC-ENGINE-OUT-011` | 10 | 0 | 1 |
| Install region | `IAC-ENGINE-REGION-001` to `IAC-ENGINE-REGION-002` | 0 | 0 | 2 |
| Electron runtime guard | `IAC-ENGINE-RT-001` to `IAC-ENGINE-RT-003` | 2 | 0 | 1 |

**Summary:** 79 of 94 active specs implemented; 0 deferred; 15 gaps.

## Key Findings

1. **Destroy output is not env-redacted**: `destroy()`'s `push` enqueues raw lines (`PulumiService.ts:3034-3037`) while preview (`:1648`) and apply (`:2297`) pass every line through `redactEnvironmentValues`. Destroy lines reach `recordRunChunk`, the live stream and `pulumi.log` (`:3130-3131,3190`). `appliedGameServers` is a stack output (`:1054`) that appears to carry game env values, so a destroy transcript may print them [inferred: depends on Pulumi's destroy display]. `PulumiService.destroy.test.ts` has no redaction case (sweep-5, consistent with code).
2. **No quit-time termination of an in-flight engine**: `electron-entry.ts` only calls `app.quit()` on `window-all-closed` (`electron-entry.ts:251`), with no `before-quit`/`will-quit` handler, and no desktop-main provider implements `onModuleDestroy`/`onApplicationShutdown` except `folder-upload.controller.ts`. Nothing aborts `PulumiService`'s internal controllers on quit. Whether the Electron process still exits cleanly with a live `pulumi` child is `[unverified]`; the spec scenario "App quits with an operation in flight" has no code behind it.
3. **Escalation claims a kill that never happens**: escalation only abandons the promise (`PulumiCancellation.ts:226-238`), but `PulumiOperationEscalatedError`'s message says the invocation "has been forcefully terminated" (`:118-119`) and the log says "force-terminating" (`:232`). No caller passes `onEscalate` (`PulumiService.ts:1674-1683,2375-2378,3110-3113`), so an escalated `pulumi` child keeps running. Escalated runs deliberately keep their lock-ownership record as reclaim evidence (`:2417-2420,3151-3154`).
4. **Stack initialization is neither cancellable nor lock-recoverable**: `initializeStack(onPhase?)` takes no `AbortSignal` (`PulumiService.ts:1113`) and `stack.refresh()` runs bare (`:1168`), with no `runWithEscalatingCancellation`, no leaked-promise wrapper and no `classifyStackLockConflict` (unlike up/destroy at `:2325-2347,3061-3083`). The wizard's `cancel()` only stops consumption (`stack-init-step.component.tsx:118-122`). A lock conflict during refresh surfaces as `PulumiStackInitializationError('operation')` (`:1172`) with no reclaim path.
5. **Passphrase spec contradiction (sweep disagreement)**: `openspec/specs/pulumi-infra-program/spec.md:70` calls the secrets provider "machine-bound and has no recovery path"; code derives a portable passphrase per AWS account (`PulumiWorkspaceService.ts:95-99,425-435`), never stored, matching `pulumi-engine-runtime`. The infra-program sentence is stale.
6. **Legacy passphrase migration has a documented dead end**: migration runs the CLI in `workDir` before `LocalWorkspace.create` and needs a `Pulumi.yaml` from a prior run; if `workDir` was wiped but `pulumi.passphrase` survived, every `getOrCreateStack` fails and needs a manual reset (doc comment in `PulumiWorkspaceService.ts:522-591`; call site `:459-473`). Every Pulumi read, including `getStackOutputs`, is blocked in that state.
7. **`getStackOutputs` is a write-capable, flaky read**: it returns `null` whenever any operation or stack init is in flight (`PulumiService.ts:970-976`), and `ConfigService` caches that `null` for 20 s (`ConfigService.ts:99,145-150`). It goes through `getOrCreateStack`, which calls `Stack.createOrSelect` (`PulumiWorkspaceService.ts:508`) and can run the legacy migration, so a dashboard poll can create a stack or re-encrypt secrets [inferred]. It logs the raw `err` object (`PulumiService.ts:1006-1008`), against `.claude/rules/logging.md`.
8. **Lock-recovery side effects and identity scope**: `classifyStackLockConflict` prunes and consumes ownership records as a side effect of classifying (`PulumiLockRecovery.ts:281,301`). The app never calls `requestSingleInstanceLock` (`:33-34`), so a second instance on the same host shares the identity; the dead-PID check (`:217`) is what stops a live sibling's lock being reclaimed.
9. **Engine cache hygiene and logging**: `pruneOldVersions` skips every `.staging-`/`.trash-` entry (`PulumiEngineService.ts:622`), so debris from a crashed install is never reclaimed. Raw `err` objects are logged at `:253,446,453,618` (and `restoreErr` at `:531,575`), which serialise to `{}` through this logger per `PulumiLeakedPromise.ts:205-210`. `getEngineCacheRoot` says it mirrors `ConfigService.getRunsDir()` (`:641`), which does not exist; the method is `PulumiService.getRunsDir` (`PulumiService.ts:4359`).
10. **Raw `process.env` in business logic**: `PulumiService.ts:4341` (`HYVEON_CONFIG_BUCKET`), `:4360` (`RUNS_DIR_PATH`), `:4397` (`HYVEON_LAMBDA_BUNDLES_DIR`); `PulumiEngineService.ts:656`; `PulumiWorkspaceService.ts:787`. `PulumiService.getConfigurationBucket` (`:4339-4343`) duplicates `ConfigService.getConfigurationBucket` (`ConfigService.ts:233-238`) because of the import cycle (`PulumiService.ts:195-208`). Violates `typescript-conventions.md` rule 2.
11. **Duplication past the `duplication.md` threshold**: chunk-streaming setup and drain loop three times (`PulumiService.ts:1635-1714`, `:2285-2406`, `:3027-3141`); identical outcome switches three times (`:3909-3918`, `:3926-3935`, `:4054-4063`); hand-rolled destroy token (`:2734-2744,3798-3838`) beside the shared `LockClearConfirmationGate` used for lock clear (`:700-707,3853-3888`).
12. **Stale comments in the orchestrator and its modules**: Terraform-era `plan()`/`spawnAndStream` references (`PulumiService.ts:1566,1635,1671,1685,1698,1737`); "no `PulumiController` yet" (`:1854,2700,3893`) although `IacController` drives the service; `:2114-2115` says destroy never touches `RunLockService` but destroy calls `createRun` (`:2960`). `PulumiWorkspaceService.ts:800-801` says "three constructor dependencies" (two, `:335-338`). `pulumi-workspace.module.ts:10-11` describes an "encrypted passphrase accessor pair" that "gates generating one", though the passphrase is now derived. `ConfigService.ts:102-104` cites `/api/games`/`/api/status` handlers that no longer exist; `:27` lists only `AWS_DEFAULT_REGION` though `CONFIG_CACHE_TTL_MS` and `HYVEON_CONFIG_BUCKET` are also read; `:9-13` documents the TTL as `DeploymentConfigService`'s.
13. **Dead code**: `ConfigService.readResourcesPath` (`ConfigService.ts:213-215`) has no caller in desktop-main (only `PulumiService.ts:4401` uses its own delegate). `getActiveCloud()` is hard-coded `'aws'` (`:276-278`).
14. **Test double drift**: `PulumiServiceStub` has no `mintLockClearConfirmationToken` (`pulumi-mock.ts:119-191`) though `iac.controller.ts:956` calls it, and `PulumiOperationName` re-declares `getOperationInFlight`'s union by hand (`pulumi-mock.ts:10-11`). `ConfigService.test.ts:279-283` is titled "should default to 30000 and warn" but never asserts the warn (sweep-4) `[unverified]`.
15. **The program provisions in the stored `awsRegion`, not the install region, and phase attribution can mislabel**: preview and apply pass the parsed `deployment-config.json` to `createInfraProgram` unchanged (`PulumiService.ts:1601,1619,2266,2278`), so the program's region is the stored `awsRegion` or its `us-east-1` default (`deploymentConfig.ts:237,327`) rather than the wizard region every backend URL uses (`PulumiService.ts:988,1126,1611,2270,2928,3709`); a Settings edit of that field replaces the whole stack on the next apply. The cloud provider (`EcsService.ts:72`) and the audit, Discord-config and run-record stores (`cloud-provider.module.ts:109,131,180`) read `outputs.awsRegion` instead of `ConfigService.getRegion()`. The state bucket itself is in the wizard region, because bootstrap creates it there (`BootstrapService.ts:605-617`). Separately, failures inside `getOrCreateStack` after the engine phase has ended (STS, migration, `createOrSelect`) are classified `'operation'` (`PulumiService.ts:1346-1354`) before any `'operation'` start event, while the wizard marks the last-started row, the already-finished `engine` row, as failed (`stack-init-step.component.tsx:129,140,149`) [inferred].

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/iac/engine/engine-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Route destroy output through `redactEnvironmentValues` like preview and apply, and add the missing destroy redaction test (finding 1). (specs: `IAC-ENGINE-REDACT-002`)
2. Abort in-flight Pulumi operations on app quit (a `before-quit` handler or a Nest shutdown hook), or amend the spec scenario if exit-without-termination is accepted (finding 2). (specs: `IAC-ENGINE-LIFE-009`)
3. Make `initializeStack` cancellable and run its `refresh()` through the same cancellation, leaked-promise and lock-classification wrappers as up and destroy (finding 4). (specs: `IAC-ENGINE-LIFE-007`, `IAC-ENGINE-LOCK-010`)
4. Set the program's `awsRegion` input from `ConfigService.getRegion()` before every preview and apply, ignoring the stored `DeploymentConfig.awsRegion`, so a stored value can never move or rebuild the stack (finding 15). Lands with `deployment-config`'s Must Fix for the Settings region field. (specs: `IAC-ENGINE-REGION-001`)

### Should Fix
5. Resolve every desktop AWS client's region through `ConfigService.getRegion()`: the cloud provider in `EcsService.ts:72` (code owned by `game-runtime/task-and-dns`) and the audit, Discord-config and run-record stores in `cloud-provider.module.ts:109,131,180` (code owned by `operator-app/desktop-shell`) stop reading `outputs.awsRegion` (finding 15). (specs: `IAC-ENGINE-REGION-002`)
6. Correct `PulumiOperationEscalatedError`'s message and the escalation log to say the promise was abandoned, not the process killed (finding 3). (specs: `IAC-ENGINE-LIFE-004`)
7. Fix the "machine-bound" sentence in `openspec/specs/pulumi-infra-program/spec.md:70` through an OpenSpec change (finding 5).
8. Extract the triplicated streaming setup, outcome switches and destroy-token gate; reuse `LockClearConfirmationGate` for destroy (finding 11).
9. Move raw `process.env` reads behind stubbable accessors and remove the duplicated `getConfigurationBucket` once the import cycle allows it (finding 10).
10. Normalise raw `err` logging in `PulumiEngineService` and `PulumiService.getStackOutputs` (findings 7, 9). (specs: `IAC-ENGINE-PFAIL-006`, `IAC-ENGINE-OUT-003`)
11. Prune orphaned `.staging-`/`.trash-` engine directories (finding 9). (specs: `IAC-ENGINE-PROV-012`)
12. Remove stale comments and dead `ConfigService.readResourcesPath` (findings 12, 13).
13. Add `mintLockClearConfirmationToken` to `PulumiServiceStub` and derive `PulumiOperationName` from the real type (finding 14). (specs: `IAC-ENGINE-RT-003`)
14. Split `PulumiService.ts` along the run/engine seam (run gates, locking and run lifecycle for `iac/run`; workspace, backend, credentials and engine plumbing for this leaf) as its own pure-refactor change with no behaviour change. This removes the `run` <-> `engine` cycle in `docs/arrows/index.yaml` (`iac-design.md`, decision 10; `engine-design.md`, Decisions & Alternatives, "File layout").

### Nice to Have
15. Give `getStackOutputs` a select-only, migration-free path so reads cannot create a stack (finding 7).
16. Provide an operator-facing reset for the legacy-migration dead end (finding 6). (specs: `IAC-ENGINE-PASS-008`)
17. Align stack-init phase attribution between backend and wizard (finding 15). (specs: `IAC-ENGINE-INIT-005`)
