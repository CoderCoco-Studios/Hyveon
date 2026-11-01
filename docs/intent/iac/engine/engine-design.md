---
parent: iac
prefix: IAC-ENGINE
---

# IaC Engine

## Context and Design Philosophy

Hyveon provisions AWS through a Pulumi Automation API program that runs inside the packaged desktop app, with no host-installed `pulumi` binary and no Pulumi Cloud account. The engine leaf is the machinery that makes that possible: it downloads and verifies the exact pinned CLI, builds one stable Automation API workspace pointed at the operator's own S3 state bucket, injects the wizard-selected AWS credentials exclusively, runs engine calls under cancellation and leaked-promise recovery, reclaims stale DIY backend locks only when it can prove the lock is its own orphan, and exposes the deployed stack outputs to the rest of the app through a memoised reader.

It is the same component regardless of what the infrastructure program declares. Neighbouring leaves own the rest:

- `iac/run` owns the operator-facing lifecycle (plan, apply gate, destroy token, rollback, stale-lock clear confirmation, run records and the `iac.*` IPC controller). Its gate logic physically lives in `PulumiService.ts` alongside this leaf's plumbing; the file of about 5,000 lines is shared ground and splits along the run/engine seam (Decisions & Alternatives, "File layout").
- `iac/program` owns `createInfraProgram` and the `StackOutputs` shape this leaf caches.
- `operator-app/wizard-and-bootstrap` owns credential custody (`ElectronStoreService`, `awsCredentialSource.ts`, `SafeStorageService`) and the bootstrap that creates the state bucket; this leaf's `stack-init-step` is the wizard's final step.
- `deployment-config` owns `iac-settings.controller.ts`, which hosts `iac.settings.engineVersion` (`iac-settings.controller.ts:210`) on this leaf's behalf; the channel stays in that controller, and its behaviour is specified here (`IAC-ENGINE-PIN-005`).

The CLAUDE.md invariants that live here: there is no CLI-based IaC step and no host-installed `pulumi` binary, because the app provisions its own pinned engine (`PulumiEngineService.ts:308`); `electronRuntime.ts` gates every Electron import on `process.versions.electron` so the plain-Node integration harness can construct the same services (`electronRuntime.ts:17-61`); and every engine-calling method normalises errors to `.message` before logging, which this leaf mostly but not fully honours (Deferred 7, 8).

The capability this leaf carries is `openspec/specs/pulumi-engine-runtime/spec.md` (7 requirements, 32 scenarios). Most scenarios match code; the exceptions are called out in place below.

## Engine Provisioning

`PulumiEngineService.resolve(onPhase?)` (`PulumiEngineService.ts:361`) returns a `PulumiCommand` for `PULUMI_ENGINE_VERSION` (`'3.255.0'`, `shared/src/pulumiVersion.ts:21`). It memoises the in-flight promise so concurrent callers share one install, and resets the memo to `null` on rejection so the next call retries instead of replaying a stale failure (`PulumiEngineService.ts:363-368`). Each caller gets its own `('engine','start')`/`('engine','end')` pair even when it joins an existing attempt; the phase is coarse because `PulumiCommand.install()` offers no progress hook (TSDoc at `:322-360`).

The cache lives under `<userData>/pulumi/versions/<pin>`, resolved by `getEngineCacheRoot` in the order `HYVEON_PULUMI_ENGINE_DIR`, Electron `userData`, then `os.tmpdir()` (`PulumiEngineService.ts:640-660`). The service is a plain class provider (`pulumi-engine.module.ts:27`) that does nothing at construction, which is what satisfies the spec's "Container builds without an engine" scenario (`pulumi-engine-runtime/spec.md:38-41`).

A fresh install is staged, verified and swapped, never written in place (`installFresh`, `PulumiEngineService.ts:471-585`):

1. Install into a sibling `.staging-<uuid>` directory with `skipVersionCheck: false` (`:487-490`), then assert an exact pin, because the SDK's own check is a minimum-version check (`assertExactPin`, `:594-598`).
2. If `root` is occupied by an entry `tryReuseCached` refused to trust, rename it aside to `.trash-<uuid>` rather than deleting it (`:508-511`), then rename staging into `root`.
3. Re-resolve against the final path and re-verify (`:557-560`). On failure, remove `root` and restore the trashed prior install (`:567-579`).
4. Only then delete the trash directory and prune superseded pinned versions (`:582-583`).

Failures surface as one of three typed errors produced by `classifyProvisioningError` (`PulumiEngineService.ts:198-211`): `PulumiEngineNetworkError`, `PulumiEngineIntegrityError`, `PulumiEngineCacheWriteError`. `resolvedVersion` is set on success and read by `iac.settings.engineVersion` (`iac-settings.controller.ts:210-214`) for the Settings engine-version row.

`pruneOldVersions` skips every `.staging-`/`.trash-` entry (`PulumiEngineService.ts:622`), so debris from a crashed install is never reclaimed. Several catch blocks log the raw error object (`:253,446,453,618`, and `restoreErr` at `:528-532,572-576`).

## Workspace, Backend and Credentials

`PulumiWorkspaceService.getOrCreateStack(input)` (`PulumiWorkspaceService.ts:396`) is the single seam every Pulumi call passes through. Its contract:

| Step | Behaviour | Evidence |
|---|---|---|
| Backend gate | `backendReady: false` throws `PulumiBackendNotBootstrappedError` before any engine work | `PulumiWorkspaceService.ts:397-399` |
| Credentials | `input.credentialEnvVars` or `resolveCredentialEnvVars(store)` | `:409` |
| Engine | `engine.resolve(input.onPhase)` | `:412` |
| Paths | `<root>/home` as `PULUMI_HOME`, `<root>/workspace/production` as `workDir`; root is `HYVEON_PULUMI_WORKSPACE_DIR`, `<userData>/pulumi-workspace`, or tmpdir | `:744-794` |
| Backend URL | `s3://<stateBucket>?region=<stateBucketRegion>` via `PULUMI_BACKEND_URL` | `:423,480` |
| Passphrase | HMAC-SHA256 over account id + stack name with a fixed app salt; account id from a live `sts:GetCallerIdentity`; never stored | `:95-99,425-435` |
| Legacy migration | if `pulumi.passphrase` exists, re-encrypt via `pulumi stack change-secrets-provider`, then delete the field | `:447-473` |
| Env | credentials, backend URL, `PULUMI_SKIP_UPDATE_CHECK`, `AWS_REGION`, `PULUMI_CONFIG_PASSPHRASE` | `:475-485` |
| Stack | `LocalWorkspace.create` then `Stack.createOrSelect('production', ws)`; set `pulumi.stackInitialized` only on success | `:45,503-512` |
| Missing bucket | mapped to `PulumiBackendNotBootstrappedError` | `:515-517` |

The stack name is the bare constant `production` (`PulumiWorkspaceService.ts:45`), because a non-legacy DIY backend silently creates the wrong stack when given a mis-shaped `organization/<project>/<stack>` name (migrate-iac-to-pulumi `design.md`, "DIY S3 backend").

The state-bucket region passed in is always the wizard's `aws.region` (`PulumiService.ts:988,1126`), the install's one region (Install Region, below), and bootstrap creates the state bucket in that same region (`BootstrapService.ts:605-617`), so the store needs no separate bucket-region field (`IAC-ENGINE-WS-010`).

Credential exclusivity lives in `resolveCredentialEnvVars` (`PulumiCredentialResolver.ts:84`). The profile path sets `AWS_PROFILE` and blanks the pasted-key variables; the pasted path sets both keys, blanks `AWS_SESSION_TOKEN`, and blanks `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` (`:98-122`). Blanking rather than omitting is what stops an ambient variable inherited from the Electron process overriding the wizard's choice. A `none` source throws `PulumiCredentialsNotConfiguredError` (`:95-97`). Only the source kind is logged (`:99,105`).

The legacy migration has a documented dead end: it runs the CLI in `workDir` before `LocalWorkspace.create` and needs a `Pulumi.yaml` from a prior run, so a wiped `workDir` with a surviving `pulumi.passphrase` fails every `getOrCreateStack` until manual reset (TSDoc at `PulumiWorkspaceService.ts:522-591`). A legacy passphrase with the OS keychain unavailable throws an operator-actionable message (`:448-458`).

## Operation Execution: Cancellation, Leaked Promises, Locks

Preview, up and destroy run their SDK call inside two wrappers, nested as `runWithEscalatingCancellation(signal => runTreatingLeakedPromiseAsSuccess(() => attempt(signal), recoverResult))` (`PulumiService.ts:1674-1683,2375-2376,3110-3111`).

**Cancellation.** `runWithEscalatingCancellation` (`PulumiCancellation.ts:188`) refuses a pre-aborted signal with `PulumiOperationNotStartedError` (`:197-202`), forwards abort to the SDK (which sends `SIGINT` to the CLI child without ever escalating to `SIGKILL`, per migrate-iac-to-pulumi `design.md`, "Streaming and cancellation"), and starts a 30 s timer (`:68`). If the operation has not settled when it fires, the promise is abandoned with `PulumiOperationEscalatedError` (`:226-238`). The process is not killed: no caller passes `onEscalate`, yet the error message says the invocation "has been forcefully terminated" (`:118-119`) and the log says "force-terminating" (`:232`). The spec scenario "Unresponsive engine is abandoned" describes logical abandonment, so the code's behaviour matches the spec and its wording does not.

Where the abort comes from matters. `IacController` creates one `AbortController` per plan/apply/destroy/rollback and aborts it only when the renderer's `WebContents` is destroyed (`iac.controller.ts:740,870,1020,1233`). The `activeApplies`/`activeDestroys` maps exist "to let a future `iac.apply.cancel` channel" reach a run (`iac.controller.ts:532-549`), but no cancel channel is registered, and the renderer's stream `cancel()` only stops consumption (`iac.controller.ts:771`). Operator-initiated cancellation of a running engine call therefore has no path today.

**Leaked promises.** `runTreatingLeakedPromiseAsSuccess` (`PulumiLeakedPromise.ts:70`) treats the SDK's post-success "promises still active" throw as success and rebuilds the result through a caller callback that re-reads `stack.outputs()`/`stack.info()` (`PulumiService.ts:2349-2352,3085`), since nothing can be recovered from the rejected promise.

**Lock recovery.** Immediately before the lock-taking call, `PulumiService` writes an ownership record via `store.recordPulumiLockAttempt` (`PulumiService.ts:2323,3059`). On a lock conflict, `classifyStackLockConflict` (`PulumiLockRecovery.ts:256`) returns `reclaimable-own-orphan` only when every parsed lock has identity match (OS username + hostname), a dead PID (`process.kill(pid, 0)` throwing `ESRCH`, `:168-174`), and a distinct fresh ownership record started at or before it (`:289-297`). Records older than two hours are pruned as a side effect (`:190,271-282`) and consumed records are cleared (`:299-302`). A reclaimable orphan is cleared with `stack.cancel()` and the call retried once (`PulumiService.ts:2332-2340,3068-3076`); anything else becomes `PulumiUnrecognizedLockError` naming holder and coarse age (`PulumiLockRecovery.ts:324,343`), which `iac/run`'s confirmed `clearStaleLock` handles (`PulumiService.ts:3701`).

The PID belongs to the CLI child, not the app, and the app never calls `requestSingleInstanceLock` (`PulumiLockRecovery.ts:23-37`), so a second instance on the same host shares the identity; the liveness and time-consistency checks are what prevent a live sibling's lock being reclaimed. Escalated runs deliberately keep their ownership record as reclaim evidence (`PulumiService.ts:2417-2420,3151-3154`).

**In-process exclusivity.** `operationInFlight` (`'preview' | 'up' | 'destroy' | 'rollback' | null`, `PulumiService.ts:677`) and `stackInitInFlight` (`:777`) serialise work within one app instance; `getOperationInFlight()` (`:752`) is what `IacController`'s pre-flight guard reads (`iac.controller.ts:721-728`), so in-app concurrency is reported as busy, not stale.

**Redaction.** Preview and apply pass every streamed line through `redactEnvironmentValues` (`PulumiService.ts:1403,1648,2297`). Destroy's `push` enqueues raw lines (`:3034-3037`) that reach run records, the live stream and `pulumi.log`. The spec's "Credentials are not logged" holds for credentials; game env values on destroy are unredacted.

**Quit.** No `before-quit`/`will-quit` handler exists (`electron-entry.ts:251` only calls `app.quit()` on `window-all-closed`), and no provider implements a Nest shutdown hook that would abort `PulumiService`'s controllers. The spec scenario "App quits with an operation in flight" (`pulumi-engine-runtime/spec.md:209`) has no implementing code path.

## Stack Initialization and Stack Outputs

`initializeStack(onPhase?)` (`PulumiService.ts:1113`) is the wizard's final step, driven by `iac.stack.initialize` (`iac.controller.ts:636`), which streams phase events to the renderer. It refuses while any operation or another init is in flight (`:1114-1121`), then runs three phases:

| Phase | Work | Failure classification |
|---|---|---|
| `engine` | `getOrCreateStack` with a no-op program (reported by `PulumiEngineService`) | credential, decrypt and engine errors → `'engine'`; anything else (STS, migration, `createOrSelect`) → `'operation'` (`:1345-1353`) |
| `plugins` | `installPlugin('aws', <@pulumi/aws package version>)` (`:1153,1213-1217`) | `'plugins'` |
| `operation` | `stack.refresh()` with an ownership record written and cleared around it (`:1165-1175`) | `'operation'` |

Unlike up and destroy, `initializeStack` takes no `AbortSignal` and runs `refresh()` without the cancellation, leaked-promise or lock-classification wrappers, so the "every operation MUST be cancellable" requirement does not hold here and a lock conflict surfaces as a plain `PulumiStackInitializationError('operation')`. The wizard's `StackInitializationStep` debounces its call past StrictMode's double mount precisely because cancellation only stops consumption (`stack-init-step.component.tsx:118-122`). It marks the last-started phase as failed (`:129,140,149`); since STS and migration failures happen after the `engine` row has already ended, the wizard appears to blame the finished `engine` row for them [inferred].

Stack outputs are read through two layers. `PulumiService.getStackOutputs()` (`PulumiService.ts:968`) never throws: it returns `null` when any operation or init is in flight (`:970-976`), when there is no state bucket, region, or evidence of a prior stack (`hasEverCreatedOrSelectedStack`, which also accepts a surviving legacy passphrase, `:642-645`), on any error (logged with the raw `err`, `:1006-1008`), or when the outputs map is empty. Because it goes through `getOrCreateStack`, a read can call `Stack.createOrSelect` and run the legacy migration [inferred].

`ConfigService.getStackOutputs()` (`ConfigService.ts:130-174`) memoises the in-flight promise. A non-null result is cached until `invalidateCache()` (`:106`), which `PulumiService` calls via the `CONFIG_CACHE_INVALIDATOR` token only after a successful apply or destroy (`PulumiService.ts:2513,3223`; binding at `config.module.ts:25`). A `null` result is retried after 20 s (`ConfigService.ts:99`). A dashboard poll that lands mid-operation therefore caches "not deployed" for up to 20 s. `ConfigService` also serves `getConfigurationBucket()` (`:233`), `getRegion()` (`:262`) and `readEnvConfigCacheTtlMs()` (`:194`, read by `DeploymentConfigService.ts:301`). `env.get` (`env.controller.ts:19`) renders the top-bar pill from the cached outputs.

`PulumiService` cannot import `ConfigService` by value because `ConfigService` already depends on it, so it resolves `CONFIG_CACHE_INVALIDATOR` and three other tokens lazily through `ModuleRef` (`PulumiService.ts:195-208,836-938`) and carries its own copy of `getConfigurationBucket` (`:4340-4344`).

## Install Region

An install has exactly one AWS region, the wizard region in electron-store `aws.region` (`docs/high-level-design.md`, decision 10). `ConfigService.getRegion()` is its one resolver: it returns `aws.region`, falling back to `AWS_DEFAULT_REGION` and then `us-east-1` only before the wizard has stored one (`ConfigService.ts:262-268`, `IAC-ENGINE-OUT-009`).

Two rules follow, and this leaf owns both because it owns the resolver:

- **The program's region is the wizard region.** `PulumiService` sets the program's `awsRegion` input from `ConfigService.getRegion()` before every preview and apply, and ignores any `awsRegion` stored in `deployment-config.json` (`IAC-ENGINE-REGION-001`). Today it passes the parsed document unchanged (`PulumiService.ts:1601,1619,2266,2278`), so a stored value that differs from the wizard region provisions the stack somewhere else, and editing it replaces the whole stack, EFS world saves included.
- **Every desktop AWS client resolves its region through `getRegion()`** (`IAC-ENGINE-REGION-002`). The secrets and configuration stores, `EcsService.getClient` and the log, scheduler, EC2 and file-manager clients already do (`cloud-provider.module.ts:80,198`; `EcsService.ts:213-217`); the cloud provider used for start, stop and status reads `outputs.awsRegion` instead (`EcsService.ts:72`, code owned by `game-runtime/task-and-dns`), and the audit, Discord-config and run-record stores prefer it (`cloud-provider.module.ts:109,131,180`, code owned by `operator-app/desktop-shell`).

The backend URL here and the wizard-time services (`BootstrapService.ts:605,707`, `IamCheckService.ts:137`, `AwsProfileService.ts:278`) read `aws.region` directly rather than through `getRegion()`, so they refuse to run when the wizard has not stored a region instead of taking the resolver's fallbacks; they read the same value as `getRegion()` on any configured install.

Stack outputs still echo `awsRegion`, and the top-bar env pill displays it (`env.controller.ts:23`); once the program takes its region from the wizard, the echo always equals `getRegion()` for a deployed stack, so the pill is a display of the same value, not a second source a client may read.
AWS-mandated global placements are outside the rule: the program's `us-east-1` provider for the CloudFront certificate is an `iac/program` resource and stays fixed (`program.ts:175-182`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Engine source | App downloads the pinned CLI via `PulumiCommand.install` into `userData` | Host-installed `pulumi` on `PATH`; default `~/.pulumi` | Packaged app must not depend on operator tooling or collide with an operator's own Pulumi; `pulumiCommand` and `pulumiHome` must both be set or the custom root is silently ignored (migrate-iac-to-pulumi `design.md`, "Engine cached under `userData`") |
| Version policy | Exact pin, enforced on top of the SDK's minimum check | Accept any compatible version | Reproducible engine across installs; SDK check alone is a floor (`PulumiEngineService.ts:594-598` TSDoc) |
| Install atomicity | Stage, verify, swap-aside, re-verify, then delete | Install in place; delete-then-install | Never leave a partial install or destroy a good one before the replacement is proven (`PulumiEngineService.ts:501-543` comments) |
| Program form | Inline `PulumiFn` | `workDir` program with `Pulumi.yaml` + `node_modules` | `workDir` is hostile to asar and would put editable infra source on disk (migrate-iac-to-pulumi `design.md`, "Inline program") |
| State backend | DIY S3 backend via `PULUMI_BACKEND_URL` | Pulumi Cloud | No account, no token, no standing cost; S3 auth rides the AWS credential chain (migrate-iac-to-pulumi `design.md`, "DIY S3 backend") |
| Secrets provider | `passphrase` | `none`; customer-managed KMS key | DIY backend has no "none" escape hatch; KMS costs ~$1/month to encrypt placeholders (migrate-iac-to-pulumi `design.md`; portable-passphrase `design.md` D2) |
| Passphrase source | Derived HMAC of account id + stack name, recomputed each call | Random per-machine value in `safeStorage`; stored in the config bucket; export/import UI | Portable across machines on the same AWS account with no stored artifact (portable-passphrase `design.md` D1) |
| Legacy migration | Automatic, silent, one-time re-encryption inside `getOrCreateStack` | Explicit "migrate" UI action | Chosen "universally" by the user (portable-passphrase `design.md` D3) |
| Credential injection | Explicit env vars with competing vars blanked | Rely on ambient AWS chain | Ambient profile/keys must not override the wizard's selection [inferred from `PulumiCredentialResolver.ts:98-122` and the spec's "Ambient … cannot override" scenarios] |
| Cancellation | Forward `AbortSignal`, abandon the promise after 30 s | `SIGKILL` the child; `stack.cancel()` | SDK abort never escalates; `stack.cancel()` is "very dangerous" and reserved for confirmed lock clearing (migrate-iac-to-pulumi `design.md`, "Streaming and cancellation") |
| Lock reclaim | Auto-reclaim only on identity + dead PID + fresh time-consistent record | Identity match alone; always ask | Identity alone would reclaim a live sibling's lock (`PulumiLockRecovery.ts:29-37`) |
| Lock evidence lifetime | Records expire after 2 h | Keep until consumed | A leaked record must not arm auto-reclaim forever (`PulumiLockRecovery.ts:57-60`) |
| Outputs read path | Never-throw `getStackOutputs` behind a memoising `ConfigService` | Throw to callers; uncached | Every call site relies on `null` meaning "not deployed" (`PulumiService.ts:1003-1005` comment); caching avoids an engine call per poll [inferred] |
| Busy-while-reading | Return `null` while an operation is in flight | Queue behind the operation; read last-known outputs | unknown; appears to avoid contending for the workspace [inferred] |
| Breaking the import cycle | Lazy `ModuleRef` tokens plus a duplicated `getConfigurationBucket` | Restructure dependencies | `ConfigService` depends on `PulumiService` (`PulumiService.ts:195-208`) |
| File layout | Split `PulumiService.ts` along the run/engine seam: `iac/run`'s run gates, locking and run lifecycle in separate files from this leaf's workspace, backend, credential and engine plumbing; a pure refactor with no behaviour change, carried out as its own change | Keep one file shared by both leaves | Removes the `run` <-> `engine` cycle recorded in `docs/arrows/index.yaml` and makes file ownership follow the spec-ownership seam both leaves already use (`iac-design.md`, decision 10) |
| Install region | One region per install, the wizard's `aws.region`, resolved only through `ConfigService.getRegion()`; the program's `awsRegion` input is set from it | Two regions on purpose: the wizard region for the control plane and `DeploymentConfig.awsRegion` for game resources, each client assigned one explicitly | Two settings every new client must choose between; the secrets store and helper-task clients already follow a different rule from start/stop; editing the game region would still replace the whole stack, EFS world saves included (`docs/high-level-design.md`, decision 10) |

## Open Questions & Future Decisions

### Resolved

1. Passphrase is derived per AWS account and stack, not stored per machine (portable-passphrase `design.md` D1, D3, D5). The contradicting sentence in `pulumi-infra-program/spec.md:70` ("machine-bound and has no recovery path") is stale relative to this decision; correcting it is Deferred 5.
2. `PulumiService.ts` splits along the run/engine seam as its own pure-refactor change (Decisions & Alternatives, "File layout"; `iac-design.md`, decision 10).
3. The state bucket's region is the wizard region: bootstrap creates the bucket in `aws.region`, and an install has one region, so the backend URL keeps using `aws.region` and the store records no separate bucket region (`IAC-ENGINE-WS-010`; Install Region; `docs/high-level-design.md`, decision 10).

### Deferred

1. Should destroy output go through `redactEnvironmentValues` like preview and apply, and who adds the missing destroy redaction test? (`PulumiService.ts:3034-3037` vs `:1648,2297`)
2. Should the app abort in-flight engine calls on quit (a `before-quit` handler or Nest shutdown hook), or should the spec scenario "App quits with an operation in flight" be amended? Does Electron currently exit cleanly with a live `pulumi` child? [unverified] (`electron-entry.ts:251`)
3. Should `initializeStack` accept an `AbortSignal` and run `refresh()` through the cancellation, leaked-promise and lock-classification wrappers? (`PulumiService.ts:1113,1168`)
4. Should `PulumiOperationEscalatedError` and its log line say "abandoned" instead of "forcefully terminated", or should escalation actually kill the child via `onEscalate`? (`PulumiCancellation.ts:118-119,232`)
5. Who owns the OpenSpec change correcting `pulumi-infra-program/spec.md:70`'s "machine-bound" sentence?
6. Is there to be an operator cancel channel for running plan/apply/destroy? The controller maps anticipate `iac.*.cancel` but none is registered, so `pulumi-engine-runtime`'s "Operation is cancelled" scenario is reachable only by closing the window (`iac.controller.ts:532-549,740`).
7. Should `getStackOutputs` stop logging the raw `err` object, per `.claude/rules/logging.md`? (`PulumiService.ts:1006-1008`)
8. Should `PulumiEngineService` normalise its raw-`err` logs, which serialise to `{}` through this logger per `PulumiLeakedPromise.ts:205-210`? (`PulumiEngineService.ts:253,446,453,618,528-532,572-576`)
9. Should orphaned `.staging-`/`.trash-` engine directories be pruned? (`PulumiEngineService.ts:622`)
10. Should the triplicated streaming setup and drain loop (`PulumiService.ts:1635-1714,2285-2406,3027-3141`) and the triplicated outcome switches (`:3909-3918,3926-3935,4054-4063`) be extracted, past the `duplication.md` threshold? Should destroy's hand-rolled token (`:2733-2743,3797-3837`) reuse `LockClearConfirmationGate` (`:700-707`)?
11. Should raw `process.env` reads move behind stubbable accessors? (`PulumiService.ts:4341,4360,4397`; `PulumiEngineService.ts:656`; `PulumiWorkspaceService.ts:787`) Can the duplicated `getConfigurationBucket` (`PulumiService.ts:4340-4344` vs `ConfigService.ts:233-238`) go once the import cycle is broken?
12. Should `getStackOutputs` get a select-only, migration-free path so a dashboard read cannot create a stack or re-encrypt secrets? (`PulumiWorkspaceService.ts:508`, `:459-473`)
13. Is caching a mid-operation `null` for 20 s acceptable, given the dashboard shows "not deployed" for that window? (`PulumiService.ts:970-976`, `ConfigService.ts:99,145-150`)
14. What operator-facing reset, if any, covers the legacy-migration dead end when `workDir` is wiped but `pulumi.passphrase` survives? (`PulumiWorkspaceService.ts:522-591`)
15. Should stack-init phase attribution be aligned so STS, migration and `createOrSelect` failures do not mark the finished `engine` row as failed? (`PulumiService.ts:1346-1354`, `stack-init-step.component.tsx:129,140,149`)
16. Should classification be side-effect free? `classifyStackLockConflict` prunes and consumes ownership records while classifying (`PulumiLockRecovery.ts:271-282,299-302`), so a caller that classifies and then does not reclaim has still spent the evidence.
17. Stale comments: Terraform-era `plan()`/`spawnAndStream` (`PulumiService.ts:1566,1635,1671,1685,1698,1737`); "no `PulumiController` yet" (`:1854,2700,3893`); destroy "never touches `RunLockService`" (`:2114-2115`) though destroy calls `createRun` (`:2960`); "three constructor dependencies" (`PulumiWorkspaceService.ts:800-801`, actually two); the "encrypted passphrase accessor pair" (`pulumi-workspace.module.ts:10-11`); `/api/games`/`/api/status` handlers (`ConfigService.ts:102-104`); `getEngineCacheRoot` "mirrors `ConfigService.getRunsDir()`" (`PulumiEngineService.ts:641`), which is `PulumiService.getRunsDir` (`PulumiService.ts:4359`). Remove them?
18. Dead or vestigial code: `ConfigService.readResourcesPath` (`ConfigService.ts:213-215`) has no caller; `getActiveCloud()` is hard-coded `'aws'` (`:276-278`). Remove, or keep as a multi-cloud seam?
19. Test-double drift: `PulumiServiceStub` lacks `mintLockClearConfirmationToken` (`pulumi-mock.ts:119-191`) though `iac.controller.ts:956` calls it, and `PulumiOperationName` re-declares the in-flight union by hand (`pulumi-mock.ts:10-11`). `ConfigService.test.ts:279-283` is titled "should default to 30000 and warn" but may not assert the warn [unverified].
20. Arrow-doc line drift found while writing this design: `runTreatingLeakedPromiseAsSuccess` is at `PulumiLeakedPromise.ts:70`, not `:194`, and the `CONFIG_CACHE_INVALIDATOR` binding is at `config.module.ts:25`, not `:57`. Correct the arrow doc at audit time.

## References

- Arrow doc: `docs/arrows/iac/engine.md`
- EARS specs: `docs/intent/iac/engine/engine-specs.md`
- OpenSpec: `openspec/specs/pulumi-engine-runtime/spec.md` (carried); `openspec/specs/pulumi-infra-program/spec.md` (cited for `spec.md:70`); `openspec/specs/wizard-flow/spec.md` (stack-init step and engine-version row, owned by `wizard-and-bootstrap`)
- OpenSpec design history: `openspec/changes/archive/2026-08-10-migrate-iac-to-pulumi/design.md`, `openspec/changes/archive/2026-08-13-pulumi-portable-passphrase/design.md`
- Docs pages: `docs/docs/architecture.md`, `docs/docs/components/infra.md`, `docs/docs/components/management-app.md`, `docs/docs/app/settings.md`
- Neighbouring leaf designs: `docs/intent/iac/run/run-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/deployment-config/deployment-config-design.md`
