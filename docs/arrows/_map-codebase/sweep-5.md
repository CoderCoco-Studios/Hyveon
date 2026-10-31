# Sweep 5 — `app/packages/desktop-main/src/services/` (M–Z, lowercase, `_` subdirs/files)

Scope: `git ls-files app/packages/desktop-main/src/services | awk -F/ '$6 !~ /^[A-L]/'` — 56 files (loose files under `services/` whose names start M–Z / lowercase / `_`, plus the `__fixtures__/` and `folderUpload/` subdirectories). Loose files starting A–L (e.g. `AwsProfileService.ts`, `ConfigService.ts`, `ElectronStoreService.ts`, `LockClearConfirmationGate.ts`) are excluded by the awk filter and are treated here as out-of-scope collaborators.

All paths below are relative to the repo root. `S/` abbreviates `app/packages/desktop-main/src/services/`.

---

## app/packages/desktop-main/src/services/__fixtures__/aws-profile/.aws

```yaml
- path: app/packages/desktop-main/src/services/__fixtures__/aws-profile/.aws/config
  purpose: Fake ~/.aws/config fixture with default, dev, and prod profiles (prod is SSO-session-shaped).
  exports: none (data file)
  dependencies: none
  data_shapes: INI; [default] region us-east-1 output json; [profile dev] us-west-2; [profile prod] eu-west-1 + sso_session=my-sso
  side_effects: none
  role: test fixture
  observations: Only consumer is S/AwsProfileService.test.ts (out of scope). Not used by any file in this sweep.

- path: app/packages/desktop-main/src/services/__fixtures__/aws-profile/.aws/credentials
  purpose: Fake ~/.aws/credentials fixture with default, dev, and noregion profiles.
  exports: none
  dependencies: none
  data_shapes: INI; AKIAEXAMPLE* access keys + fake secrets; dev has region us-west-2
  side_effects: none
  role: test fixture
  observations: Fake keys are AKIA-prefixed but shorter than 20 chars, so they would NOT match diagnosticsLogScrubber's 16-char AKIA pattern (S/diagnosticsLogScrubber.ts:5). Consumer is AwsProfileService.test.ts only.
```

## app/packages/desktop-main/src/services (loose files, M–Z / lowercase)

```yaml
- path: app/packages/desktop-main/src/services/PublicIpService.ts
  purpose: Detects the operator's public IPv4 via https://checkip.amazonaws.com (5 s timeout) to scope the file-manager helper's SG rule.
  exports: PublicIpService (Nest @Injectable) with detect(): Promise<string>
  dependencies: node:net isIPv4, @hyveon/shared errMessage, ../logger
  data_shapes: returns dotted-quad string
  side_effects: network (fetch), logs warn on failure
  role: Nest service
  observations: Throws a plain Error "Could not detect your public IP address: …" (PublicIpService.ts:28); IPv6-only networks always fail (isIPv4 check :23). Consumed by FileManagerService and aws.module.

- path: app/packages/desktop-main/src/services/PublicIpService.test.ts
  purpose: Pins detect(): trims body, rejects non-IPv4/out-of-range octet/non-2xx, normalizes fetch failures.
  role: test

- path: app/packages/desktop-main/src/services/PulumiCancellation.ts
  purpose: Cancellation-with-escalation wrapper around Pulumi SDK operations (SDK only sends one SIGINT, never escalates).
  exports: PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS (30_000), PulumiOperationNotStartedError, PulumiOperationAbortedError, PulumiOperationEscalatedError, EscalatingCancellationOptions, runWithEscalatingCancellation()
  dependencies: ../logger, @hyveon/shared errMessage
  data_shapes: operation(signal) => Promise<T>; options { escalationTimeoutMs?, onEscalate? }
  side_effects: timers, logs
  role: pure-ish utility / primitive
  observations: Escalation is "logical" only — the promise is abandoned, process is not killed (:28-36); no caller in the repo passes onEscalate (PulumiService.ts:1673-1682, 2374-2377, 3109-3112), so a wedged engine child keeps running. Pre-aborted signal short-circuits without invoking operation (:197-202). TSDoc references sections "Three distinct settlement shapes" (:94), "pre-aborted signal" (:74), "No PID exposed via the public API" (:110,:134) that do not exist as named sections in the file header. Only consumer: PulumiService.

- path: app/packages/desktop-main/src/services/PulumiCancellation.test.ts
  purpose: Pins no-signal passthrough, pre-aborted → NotStarted (operation never invoked, warn logged), aborted-then-reject → Aborted wrapping cause, clean resolve after abort, timer cleared, genuine failure unwrapped, sync throw handling, escalation after timeout with onEscalate, default timeout, abandoned op late-resolve without unhandled rejection.
  role: test

- path: app/packages/desktop-main/src/services/PulumiCredentialResolver.ts
  purpose: Turns the wizard-selected AWS credential source into an env-var overlay for the Pulumi engine, explicitly clearing the other source's vars with ''.
  exports: PulumiCredentialsNotConfiguredError, resolveCredentialEnvVars(store)
  dependencies: ./awsCredentialSource resolveAwsCredentialSource, type ElectronStoreService, ../logger
  data_shapes: Record<string,string> — profile: { AWS_PROFILE, AWS_ACCESS_KEY_ID:'', AWS_SECRET_ACCESS_KEY:'', AWS_SESSION_TOKEN:'' }; pasted: { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN:'', AWS_PROFILE:'', AWS_DEFAULT_PROFILE:'' }
  side_effects: logs (source kind only)
  role: pure helper (reads store)
  observations: 'none' source is a hard throw, not empty env (:95-97). Relies on '' being treated as unset by Go/JS AWS SDKs (:73-79). Profile path does not clear AWS_DEFAULT_PROFILE (only pasted path clears profile vars) — asymmetry is by design (profile path sets AWS_PROFILE, which wins over DEFAULT).

- path: app/packages/desktop-main/src/services/PulumiCredentialResolver.test.ts
  purpose: Pins profile/pasted outputs, mutual-exclusivity clears (incl. AWS_SESSION_TOKEN on pasted path), 'none' throws + warns, rethrow on source failure, no secret values logged, and (via real child spawns) that '' actually overrides ambient env while omission leaks.
  role: test

- path: app/packages/desktop-main/src/services/PulumiEngineService.ts
  purpose: App-managed provisioning of the pinned Pulumi CLI (PULUMI_ENGINE_VERSION) into <userData>/pulumi/versions/<pin>, never PATH or ~/.pulumi.
  exports: PulumiProvisioningPhase ('engine'|'plugins'|'operation'), PulumiPhaseStatus, PulumiPhaseCallback, PulumiEngineNetworkError, PulumiEngineIntegrityError, PulumiEngineCacheWriteError, PulumiEngineService { resolve(onPhase?), getPinnedVersion(), getResolvedVersion() }
  dependencies: @pulumi/pulumi/automation/index.js PulumiCommand (explicit /index.js required, :6-10), @hyveon/shared PULUMI_ENGINE_VERSION, semver, ./electronRuntime resolveUserDataPath, node:fs/os/path/crypto
  data_shapes: PulumiCommand; staging dirs .staging-<uuid>, trash dirs .trash-<uuid>
  side_effects: filesystem (mkdir/rename/rm under cache root), network (PulumiCommand.install downloads from get.pulumi.com), child-process exec (version checks), logs
  role: Nest service
  observations: Memoizes in-flight promise; rejected attempt resets to null (:363-368). Exact-pin check on top of SDK's minimum-version check (:594-598). Staging → rename → re-verify → trash/restore flow (:471-585). pruneOldVersions deletes every non-current sibling except .staging-/.trash- (:613-627) — orphaned .trash-/.staging- dirs from crashed runs are never pruned. Raw process.env read for HYVEON_PULUMI_ENGINE_DIR (:656) contrary to typescript-conventions rule 2. describeCause is a trivial alias of errMessage (:20-22). TSDoc cites sections "Swap-aside, not delete-then-install" (:432,:463), "No partial-install reuse" (:462), "Version-namespaced cache" (:591-592) that aren't headed sections in the class doc. removeDirBestEffort/tryReuseCached log raw `err` objects (:253,:446,:454,:618) — per PulumiLeakedPromise.ts:81-86 raw Errors serialize to {} through this logger.

- path: app/packages/desktop-main/src/services/PulumiEngineService.test.ts
  purpose: Pins sync no-throw construction, single install under concurrency (success and failure), success memoized / failure not, cache reuse, wrong-version and ENOENT discard, ambiguous cache entry left in place + swap-aside + restore on post-rename failure, staging-then-rename, pruning, typed error classification (network vs HTTP-status integrity vs EACCES cache-write), elapsed logging, env-override and tmpdir fallback roots, phase reporting per call and never 'plugins'/'operation'.
  role: test

- path: app/packages/desktop-main/src/services/PulumiLeakedPromise.ts
  purpose: Treats the Pulumi SDK's post-success "leaked promise" throw as success and rebuilds the result via a caller callback.
  exports: isLeakedPromiseError(err), runTreatingLeakedPromiseAsSuccess(operation, recoverResult)
  dependencies: ../logger, @hyveon/shared errMessage
  data_shapes: regex /The Pulumi runtime detected that \d+ promises? (?:was|were) still active/
  side_effects: logs warn with message/stack
  role: utility primitive
  observations: Documents that the SDK's finally block aborts before tearing down gRPC servers/temp log file, so recovery makes the leak silent rather than fixing it (:18-24). TSDoc references a "Division of responsibility with the caller" section (:64) that does not exist. Only consumer: PulumiService.

- path: app/packages/desktop-main/src/services/PulumiLeakedPromise.test.ts
  purpose: Pins single/plural message match, non-match for CLI/lock/non-Error, compatibility with the installed SDK's real debuggable.leakedPromises() message, passthrough on success/genuine failure, recovery + warn, recoverResult failure propagates.
  role: test

- path: app/packages/desktop-main/src/services/PulumiLockRecovery.ts
  purpose: Classifies DIY-backend stack-lock conflicts as provable own orphans (auto-reclaim) or requiring operator confirmation.
  exports: PulumiStackLockInfo, isStackLockConflict, parseStackLocks, PulumiLockClassification, isPidAlive, PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS (2 h), classifyStackLockConflict(err, store, stackName, identity?, now?), formatLockAge, PulumiUnrecognizedLockError
  dependencies: @pulumi/pulumi/automation ConcurrentUpdateError, @hyveon/shared formatRelativeAge, ElectronStoreService listPulumiLockAttempts/clearPulumiLockAttempt (type PulumiLockOwnershipRecord), node:os userInfo/hostname
  data_shapes: lock line regex `<url>: created by <user>@<host> (pid N) at <RFC3339>`; classification union not-a-lock-conflict | reclaimable-own-orphan | requires-confirmation
  side_effects: electron-store mutation (prunes stale records, consumes evidence records), process.kill(pid,0) probe, logs
  role: domain logic module
  observations: Reclaim requires every lock to have identity match + dead PID (ESRCH only; EPERM = alive) + a distinct fresh record with startedAt <= lockedAt (:211-220, :289-297). classifyStackLockConflict mutates the store as a side effect of a classification call (:281, :301). Notes the app never calls app.requestSingleInstanceLock() (:33-34; confirmed: no occurrence in desktop-main/src). TSDoc references "verified Go source" (:67) and "Why provable ownership" section (:109) not present.

- path: app/packages/desktop-main/src/services/PulumiLockRecovery.test.ts
  purpose: Pins conflict detection (instanceof + message backstops), lock-line parsing (single/multi/none), isPidAlive ESRCH/EPERM semantics, reclaim only with identity+dead pid+fresh consistent record, evidence consumption/no replay, live lock never reclaimed, time-consistency, max-age pruning, partial identity match, one record can't prove two locks, formatLockAge buckets, PulumiUnrecognizedLockError message.
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.ts
  purpose: 5004-line Pulumi Automation API orchestrator: stack outputs, wizard stack init, preview (plan), gated apply, token-gated destroy, rollback, stale-lock clear, live run-output streaming, local run.json/pulumi.log persistence, plus ~30 exported error classes.
  exports: DI tokens RUN_RECORD_PERSISTER, RUN_LOCK_SERVICE, CONFIG_CACHE_INVALIDATOR, DEPLOYMENT_CONFIG_SERVICE and interfaces RunRecordPersister, RunLockService, ConfigCacheInvalidator, DeploymentConfigRestorer; PulumiRunChunk, PulumiPreviewResult, PulumiPreviewOutcome, PulumiRunRecord, PulumiUpResult, PulumiApplyOutcome, PulumiDestroyResult, PulumiDestroyOutcome, PulumiOperationOutcome, PulumiPartialApplyStep; class PulumiService { getOperationInFlight, getStackOutputs, initializeStack, preview*, apply*, mintDestroyConfirmationToken, mintLockClearConfirmationToken, destroy*, resolveRollbackTarget, computeRollbackDiff, confirmRollback*, clearStaleLock, computePlanHash, readRunRecord, hasPlanArtifact, streamRunOutput* } (* = async generator); errors PulumiOperationInFlightError, PulumiStackInitializationError, PulumiPreviewError, PulumiUpError, PulumiDestroyError, PulumiLockClearError, PulumiPartialApplyError, StalePlanError, PulumiPlanRunNotFoundError, PulumiPlanRunWrongKindError, PulumiPartialApplyRetryBlockedError, PulumiPlanNotApprovedError, PulumiApprovalExpiredError, PulumiPlanHashMismatchError, PulumiPlanArtifactStaleError, PulumiEngineVersionMismatchError, PulumiPlanHashError, PulumiRunPersistError, PulumiPreflightMarkerError, DestroyNotConfirmedError, LockClearNotConfirmedError, RollbackTargetNotFoundError, RollbackNotApplyRunError, RollbackNoConfigVersionError, RollbackVersionMissingError, PulumiRollbackPlanFailedError
  dependencies: @hyveon/infra createInfraProgram; @hyveon/shared CONFIGURATION_OBJECT_KEY, diffDeploymentConfig, findWebPortCollisions, isApprovalExpired, normalizeDeploymentConfigGames + types; @pulumi/pulumi automation types; Nest ModuleRef (lazy strict:false lookups for RunRecordService/RunService/ConfigService/DeploymentConfigService/REMOTE_FILE_STORE to break ESM import cycles); PulumiWorkspaceService, PulumiEngineService, ElectronStoreService, LockClearConfirmationGate (out of scope), PulumiCancellation, PulumiLeakedPromise, PulumiLockRecovery, PulumiCredentialResolver, awsCredentialSource, electronRuntime
  data_shapes: <runsDir>/<runId>/{<runId>.plan.json, pulumi.log, run.json}; StackOutputs projected from OutputMap with per-field defaults; planHash = sha256(artifactBytes ++ utf8(configVersionId)); engineVersion = manifest.version minus leading 'v'
  side_effects: Pulumi CLI subprocesses (preview/up/destroy/refresh/cancel/installPlugin/outputs/history/info), filesystem writes under runs dir, S3 config-object reads/restore via RemoteFileStore/DeploymentConfigService, DynamoDB run-record + durable lock via RunRecordService/RunService, electron-store writes (lock attempts, orphaned rollback), logs
  role: Nest service (core orchestration)
  observations: |
    - Chunk-streaming setup (buffers/queue/wake/notify/push/handleData/onOperationSettled/drain loop) is copy-pasted three times: preview (:1635-1713), apply (:2285-2405), destroy (:3026-3140). Abort-listener wiring and force-close finally blocks also triplicated. toOperationOutcome/toApplyOperationOutcome/toDestroyOperationOutcome are three identical switch bodies (:3908-3934, :4053-4062). Per .claude/rules/duplication.md these meet the ≥3 threshold.
    - destroy() does NOT redact operator environment values from streamed output (push at :3033-3036 has no redactEnvironmentValues call), unlike preview (:1647) and apply (:2296). appliedGameServers is a stack output carrying env values (:1389-1390); destroy output may appear to print outputs being deleted — possible leak into pulumi.log / run history.
    - Destroy-confirmation token is hand-rolled (pendingDestroyConfirmation + assertFreshDestroyConfirmation, :691, :2733-2743, :3797-3837) while lock-clear uses the shared LockClearConfirmationGate (:700-707, :3852-3887) — same mint/expire/bind/consume shape implemented twice.
    - Stale comment contradiction: apply re-check comment says "`preview`/`destroy` never touch `RunLockService` at all" (:2113-2114), but destroy calls getRunLockService().createRun (:2959).
    - References to non-existent code: "mirroring plan()'s" (:1565, :1670, :1736), "spawnAndStream" (:1634, :1684, :1697) — no plan()/spawnAndStream exist anywhere in app/packages (Terraform-era leftovers). "there is no `PulumiController` yet" (:1853), "a controller that doesn't exist yet" (:2699), "none exists yet for Pulumi operations" (:3892) — IacController (controllers/iac.controller.ts) now drives this service.
    - Many TSDoc cross-refs to named sections that don't exist ("Error attribution" :1110/:4474, "Gate structure" :592/:2925/:4032, "Lock-recovery wiring"/"Force-close safety net" :2321/:2413, "No-op inline program" :3016, "Compensating semantics" :3615, "Why previewCore, not preview()" :3626, "Structured changeSummary" :1665, "Engine-version stamping" :434/:3939).
    - confirmRollback: if previewCore returns undefined (aborted mid-plan) after restoreRawConfig succeeded, no orphaned-rollback marker is recorded and no error thrown (:3630) — restored config becomes head with no completed plan, the exact case recordOrphanedRollback exists for. Not covered by rollback tests.
    - apply gate 6 recomputes hash with `currentConfigVersionId ?? ''` (:2076) when the plan record had no configVersionId.
    - getStackOutputs never throws; returns null while any op/stack-init is in flight (:970-976), which ConfigService then caches (comment :2527-2534).
    - Raw process.env reads: HYVEON_CONFIG_BUCKET (:4340), RUNS_DIR_PATH (:4359), HYVEON_LAMBDA_BUNDLES_DIR (:4396) — duplicates of ConfigService resolution order by design (:4324-4357) and contrary to typescript-conventions rule 2.
    - Known gap documented: packaged-app lambda bundle path <resourcesPath>/lambda is not populated by electron-builder.yml (:4387-4393).
    - Logs raw `err` object in getStackOutputs (:1007).
    - Comment at :1362 says `"true"`'s prefix is dropped, but "true" is 4 chars and passes MIN_REDACTABLE_ENV_VALUE_LENGTH=4 (:102) — "true" values are redacted everywhere in logs.
    - parseConfigurationObject (:3413-3421) lets a raw JSON.parse SyntaxError escape for a malformed config.

- path: app/packages/desktop-main/src/services/PulumiService.test.ts
  purpose: Pins getStackOutputs null short-circuits (no bucket / not initialized / no region / stack-init in flight), getOrCreateStack args, full field projection + defaults, empty outputs → null, never-throw on any failure with warn; constructors/messages of the error classes.
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.apply.test.ts
  purpose: Pins the 8-step gate order and each typed rejection (incl. PartialApplyRetryBlocked, 15-min approval window, artifact re-hash), lock acquired last, RunLockHeldError unwrapped; pre-flight marker after lock/before up() and fail-closed with explicit release (issue #399); streaming + history fallback; env redaction (stream + log, min length, prefix overlap); partial-apply detection and persisted partialApply semantics (incl. cancel mid-flight); cache invalidation before persist and only on success; own-orphan reclaim+retry vs unrecognized lock; leaked-promise recovery; abort listener removal; concurrency re-checks against initializeStack and preview.
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.clearStaleLock.test.ts
  purpose: Pins no-op program + cancel, warn log with initiator, refusal under operationInFlight/stackInit, config/stack-existence errors, PulumiLockClearError on cancel failure, re-entry after success/failure, and token gate (unminted/mismatch/expired/consumed).
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.destroy.test.ts
  purpose: Pins stack-init concurrency guards, token gate incl. target binding (bucket/region), superseded tokens, same-token race decided by token, token-before-createRun ordering, config checks don't burn the token, lock reservation order, RunLockHeldError unwrapped, post-createRun re-check release, preMintedRunId validation, no-plan destroy, streaming/history fallback, persistence, cache invalidation, lock recovery, leaked-promise recovery, abort/force-close persistence.
  role: test
  observations: No test asserts env-value redaction for destroy (cf. preview/apply "environment redaction" describes) — consistent with the missing redaction in PulumiService.ts:3033.

- path: app/packages/desktop-main/src/services/PulumiService.initializeStack.test.ts
  purpose: Pins three-phase start/end reporting, no-op program, explicit aws plugin install, refresh as operation, lock-attempt record/clear around refresh, phase error attribution (engine incl. credentials + pasted-decrypt; operation for createOrSelect/refresh; plugins), no stackExists field, backendReady true, pre-flight config check, reentrancy guards.
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.preview.test.ts
  purpose: Pins runId/run-dir/plan-artifact path, no credentialEnvVars passed, config read from RemoteFileStore first, missing bucket/object/stale version refusals, legacy https webPort collision rejection, concurrency guards, line-split streaming with partial-line flush, pulumi.log transcript, env redaction, changeSummary from onEvent and history fallback filters (kind/result/age/all-zero), planHash algorithm, engineVersion 'v' strip, PulumiPlanHashError, persistence, failure, abort/force-close, leaked-promise recovery.
  role: test

- path: app/packages/desktop-main/src/services/PulumiService.rollback.test.ts
  purpose: Pins resolveRollbackTarget (prior version, typed errors), computeRollbackDiff (diff, legacy-https normalization not a change, undefined on any failure), confirmRollback happy path (byte-for-byte restore, rolledBackFrom tagging, guard released), rollback busy naming, stack-init guard, expired version before write, orphaned-rollback marker + PulumiRollbackPlanFailedError on post-restore plan failure.
  role: test
  observations: No case for an aborted (undefined-returning) previewCore after a successful restore.

- path: app/packages/desktop-main/src/services/PulumiWorkspaceService.ts
  purpose: Builds the Automation API LocalWorkspace/Stack seam: stable pulumiHome/workDir, s3:// DIY backend, passphrase secrets provider with an STS-account-derived passphrase, legacy-passphrase migration.
  exports: PULUMI_PROJECT_NAME ('hyveon'), PULUMI_STACK_NAME ('production'), PULUMI_PASSPHRASE_DERIVATION_SALT ('hyveon:pulumi-stack-passphrase:v1', frozen), deriveStackPassphrase(accountId, stackName), resolveAwsAccountId(store, region, stsClientFactory?), PulumiBackendNotBootstrappedError, PulumiWorkspaceInput, PulumiWorkspaceService { getOrCreateStack(input) }
  dependencies: @pulumi/pulumi automation LocalWorkspace/Stack, @aws-sdk/client-sts, node:child_process spawn, node:crypto createHmac, PulumiEngineService, ElectronStoreService, PulumiCredentialResolver, awsCredentialSource, electronRuntime
  data_shapes: envVars { ...credentialEnvVars, PULUMI_BACKEND_URL: s3://<bucket>?region=<r>, PULUMI_SKIP_UPDATE_CHECK, AWS_REGION, PULUMI_CONFIG_PASSPHRASE }; dirs <userData>/pulumi-workspace/{home, workspace/production}
  side_effects: AWS STS GetCallerIdentity, filesystem mkdir, spawns `pulumi stack change-secrets-provider` (30 s timeout, SIGTERM), electron-store writes (pulumi.passphrase removal, pulumi.stackInitialized=true), logs
  role: Nest service
  observations: Passphrase is HMAC-SHA256(salt, accountId+stackName), recomputed each call, never stored (:95-99, :435). Legacy migration happens before LocalWorkspace.create and depends on Pulumi.yaml already existing in workDir (:559-576). Keychain unavailability checked before decrypting legacy passphrase (:447-458). BUCKET_MISSING_PATTERN explicitly unverified against real S3 (:186-200). Raw process.env read for HYVEON_PULUMI_WORKSPACE_DIR (:787). Stale comment: "this service already has three constructor dependencies" (:800-801) — it has two (:335-338). TSDoc references "Finding 1's fix" and a "Call order" doc section (:709-712) that doesn't exist; "spec.md:102"/"spec.md:100" line refs (:268, :408) are fragile. resolveInlineProjectSettings sets `main: process.cwd()` (:726).

- path: app/packages/desktop-main/src/services/PulumiWorkspaceService.test.ts
  purpose: Pins stable non-tmp, non-growing pulumiHome/workDir distinct from engine cache; bare stack name; default project only when no Pulumi.yaml; backend URL + encoded region + AWS_REGION; passphrase provider; engine from PulumiEngineService; backendReady=false short-circuit and missing-bucket backstop reclassification; derived passphrase identical across machines with no listStacks; STS failure normalized; stackInitialized bookkeeping; credentialEnvVars cannot override seam-owned vars; real resolver wiring; credentials unconditional and never logged; elapsed logging; onPhase forwarding; legacy migration success/failure/keychain-unavailable; pinned HMAC digest; resolveAwsAccountId behaviour.
  role: test

- path: app/packages/desktop-main/src/services/RunRecordService.ts
  purpose: Facade over RunRecordStore (DynamoDB + S3 for AWS) for run history: persist (best-effort, inline-vs-offloaded log, always releases lock), writePreflightMarker (fail-closed), getLogUrl, getByRunId, listRuns, approveRun.
  exports: RunRecordTableNotConfiguredError, RunRecordNotFoundError, RunRecordNotPlanError, RunRecordNotSuccessfulError, INLINE_LOG_LIMIT_BYTES (350 KiB), ListRunsOpts, PersistRunRecordParams, PreflightMarkerParams, RunRecordService
  dependencies: @hyveon/shared buildRunSk, deriveRunStatus, resolvePreApplyRunsTableName + types; ConfigService.getStackOutputs; RunService.releaseRun; RUN_RECORD_STORE, REMOTE_FILE_STORE tokens
  data_shapes: RunRecord with mutually-exclusive logInline / logS3Key; pre-flight marker {kind:'apply', status:'aborted', exitCode:null, partialApply:true, completedAt=startedAt}
  side_effects: reads local log file, DynamoDB puts/gets/queries and S3 log offload via store, logs
  role: Nest service
  observations: Table name falls back to resolvePreApplyRunsTableName(remoteFileStore) (:267-271) but RunService (same lock lifecycle) does NOT use that fallback (RunService.ts:179, :231, :272) — on a fresh install the durable lock is skipped while run records are written. Terraform-era wording: ".tfplan artifact" (:72, :86, :154). persist logs raw `err` objects (:336, :351, :382), against .claude/rules/logging.md rule 2 normalization. clampLimit "mirrors AuditService's identically-named helper" (:124) — documented duplication.

- path: app/packages/desktop-main/src/services/RunRecordService.test.ts
  purpose: Pins inline vs offload threshold (incl. exact boundary), missing/unreadable logs, optional field carry/omit, sk/status derivation, swallow-on-failure, lock release on every persist path, pre-flight marker shape/propagation/no lock release, getLogUrl/getByRunId/listRuns delegation, clamping, empty-page/undefined when no table, approveRun validation errors, and the pre-apply table-name fallback ("bootstrap deadlock fix").
  role: test

- path: app/packages/desktop-main/src/services/RunService.ts
  purpose: Single apply lock for plan/apply/destroy: synchronous in-memory RunLock plus DynamoDB-mirrored durable lock, with a confirmation-token-gated operator clear.
  exports: DEFAULT_LOCK_TTL_MS (1 h), RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS (5 min), RunLockClearNotConfirmedError, RunLockChangedError, RunService { createRun, getCurrentLock, releaseRun, mintLockClearConfirmationToken, clearLock }
  dependencies: @hyveon/shared RunLockHeldError, isRunLockExpired + types; ConfigService.getStackOutputs; RUN_RECORD_STORE; LockClearConfirmationGate (out of scope)
  data_shapes: RunLock { runId, kind, initiator, acquiredAt, expiresAt }
  side_effects: DynamoDB acquire/get/release via RunRecordStore, logs
  role: Nest service
  observations: In-memory lock set synchronously before first await (:163-177). Expired in-memory lock is silently taken over (:163). Durable layer skipped entirely when stack outputs lack runsTableName (:179-195) — no pre-apply fallback, unlike RunRecordService. releaseRun swallows durable failures and logs raw `err` (:241-244). Mint requires expectedRunId to match the current lock (TOCTOU guard, :312-326). File-level comment cites issue #106 (:3). Docs use Terraform-era `runs_table_name` (:139, :144, :217, :252).

- path: app/packages/desktop-main/src/services/RunService.test.ts
  purpose: Pins acquire+mirror, second simultaneous createRun rejected, rollback on durable rejection with warn, in-memory-only mode, pre-minted runId, expired-lock takeover, getCurrentLock expiry, scoped release/no-op, swallow durable release failures, mint/clear token semantics (durable fallback, supersede, RunLockChangedError, consumption, durable-only clear).
  role: test

- path: app/packages/desktop-main/src/services/SafeStorageService.ts
  purpose: Wraps Electron safeStorage; degrades to plaintext passthrough when not in Electron or keychain unavailable.
  exports: SafeStorageService { isAvailable, encrypt, decrypt } with protected readIsElectron/readIsAvailable/encryptString/decryptString seams
  dependencies: electron (lazy createRequire), ../logger
  data_shapes: base64 ciphertext string or plaintext
  side_effects: OS keychain, logs
  role: Nest service
  observations: Plaintext fallback on encrypt (:51-54) — secrets stored in clear when keychain is locked. decrypt returns the input unchanged when unavailable, so a real ciphertext read while the keychain is locked is returned as a garbage base64 blob (:88-93, remarks :72-79). This is why PulumiWorkspaceService checks availability explicitly before decrypting (PulumiWorkspaceService.ts:447-448).

- path: app/packages/desktop-main/src/services/SafeStorageService.test.ts
  purpose: Pins availability logic, plaintext passthrough + warn outside Electron/locked keychain, base64 encryption, decrypt round trip, plain-Error wrapping of Electron failures, and that plaintext/ciphertext values are never logged.
  role: test

- path: app/packages/desktop-main/src/services/SchedulerService.ts
  purpose: EventBridge Scheduler wrapper that schedules a one-time ecs:StopTask (universal target) to auto-stop the FileBrowser helper.
  exports: CreateStopScheduleParams, SchedulerService { createStopSchedule, deleteSchedule }
  dependencies: @aws-sdk/client-scheduler, ConfigService.getRegion, ElectronStoreService, awsCredentialSource resolveAwsClientCredentialsWithSignature, awsClientCache createCachedAwsClient
  data_shapes: schedule at(yyyy-mm-ddThh:mm:ss) UTC, FlexibleTimeWindow OFF, ActionAfterCompletion DELETE, Input {Cluster, Task, Reason} PascalCase
  side_effects: AWS Scheduler Create/DeleteSchedule, logs
  role: Nest service
  observations: Never throws; createStopSchedule returns boolean, deletes same-named schedule first (:101-102). Logs raw `err` objects (:129, :149) — against logging.md normalization and serializes to {} per PulumiLeakedPromise.ts:81-86. TSDoc mentions `{@link Ec2Service}` (:49) without import. ResourceNotFoundException treated as success (:148).

- path: app/packages/desktop-main/src/services/SchedulerService.test.ts
  purpose: Pins delete-before-create, exact CreateSchedule shape (universal target, OFF window, DELETE after completion), false+log on failure, delete no-op on ResourceNotFound and swallowing other errors.
  role: test

- path: app/packages/desktop-main/src/services/WindowService.ts
  purpose: Drives the main BrowserWindow's minimize/maximize/close and pushes maximize state to the renderer.
  exports: WindowService { attach(win), minimize, toggleMaximize, close, isMaximized }
  dependencies: electron BrowserWindow (type only), ../logger
  data_shapes: push channel `window.maximizedChange` (boolean) via webContents.send
  side_effects: Electron window calls, IPC push to renderer, logs
  role: Nest service
  observations: Every method no-ops before attach (:55-56 etc.). 'closed' listener detaches only if still the same window (:46-48). Push channel bypasses @MessagePattern bridge (:108-114). Logs via template-string messages rather than metadata (:50, :60).

- path: app/packages/desktop-main/src/services/WindowService.test.ts
  purpose: Pins pre-attach no-ops, delegation, toggle semantics, maximizedChange push on native events, detach on closed, stale-closed-listener guard.
  role: test

- path: app/packages/desktop-main/src/services/awsClientCache.ts
  purpose: Memoized "get or rebuild" factory for a single AWS SDK client keyed on region + credentialsSignature.
  exports: CachedAwsClientConfig, createCachedAwsClient(factory)
  dependencies: none
  data_shapes: cache key `${region}::${credentialsSignature ?? ''}`
  side_effects: none (closure state)
  role: utility
  observations: Consumed by Ec2Service, EcsService, LogsService, SchedulerService. No unit test file in scope.

- path: app/packages/desktop-main/src/services/awsCredentialSource.ts
  purpose: Single decision point for which AWS credential source the wizard selected, plus SDK-client credentials + cache signature derivation.
  exports: StaticAwsCredentials, AwsClientCredentials, AwsPastedCredentialDecryptError, AwsCredentialSource ('none'|'pasted'|'profile'), resolveAwsCredentialSource, resolveAwsClientCredentials, ResolvedAwsClientCredentials, resolveAwsClientCredentialsWithSignature
  dependencies: @aws-sdk/credential-providers fromIni, ElectronStoreService (get('aws'), getPastedCredentials), ../logger
  data_shapes: signatures 'none' | 'pasted:<profile>:<accessKeyId>' | 'profile:<profile>'
  side_effects: decrypts stored creds via store, logs (profile name, never keys)
  role: utility (shared credential resolver)
  observations: Pasted entry wins over a same-named CLI profile (:59-60, :111-114). Signature embeds the access key id (:185) — non-secret but identifying. Wraps raw decrypt errors in a typed class so PulumiService.classifyGetOrCreateStackFailure can tag them (:36-48). Widely consumed (12 modules, see cross-scope).

- path: app/packages/desktop-main/src/services/awsCredentialSource.test.ts
  purpose: Pins none/pasted/profile resolution, pasted-precedence, typed decrypt error naming profile with warn, no key values logged, signature stability/rotation/kind-switch.
  role: test

- path: app/packages/desktop-main/src/services/diagnosticsBundleAllowlist.ts
  purpose: Explicit allowlist reducer from DeploymentConfig to the diagnostics bundle's config summary.
  exports: DiagnosticsGameServerSummary, DiagnosticsConfigSummary, buildDiagnosticsConfigSummary(settings, gameServers)
  dependencies: @hyveon/shared types DeploymentConfig, GameServer
  data_shapes: top-level projectName, awsRegion, vpcCidr, hostedZoneName, dnsTtl, watchdog*, auditTableName, runsTableName; per-game name, image, cpu, memory, portCount, https, hasWebPort, volumeCount, hasHealthCheck, hasPinnedHostname
  side_effects: none (pure)
  role: pure function
  observations: Excludes environment, file_seeds, healthCheck.auth, Discord IDs, pinnedHostname/webPort values (:3-11, :26-33). Consumer: DiagnosticsBundleService.

- path: app/packages/desktop-main/src/services/diagnosticsBundleAllowlist.test.ts
  purpose: Pins allowlisted fields present, Discord/unknown fields excluded, per-game reduction, pinnedHostname/webPort presence-only, https default false.
  role: test

- path: app/packages/desktop-main/src/services/diagnosticsLogScrubber.ts
  purpose: Regex scrubber redacting AKIA/ASIA access key ids and token/key/secret-labeled long values from log text before bundling.
  exports: scrubSecrets(text)
  dependencies: none
  data_shapes: string → string with [REDACTED]
  side_effects: none (pure)
  role: pure function
  observations: Defense-in-depth only (:18-24). Does not catch unlabeled secret values (e.g. a raw secret access key without a label) or values shorter than 16 chars (:15-16).

- path: app/packages/desktop-main/src/services/diagnosticsLogScrubber.test.ts
  purpose: Pins AKIA/ASIA redaction, labeled long values and secret= assignments, untouched normal/short lines, multi-line, correct position when the value appears earlier in the line.
  role: test

- path: app/packages/desktop-main/src/services/electronRuntime.ts
  purpose: Lazy, guarded accessors for Electron userData path, app.isPackaged, and process.resourcesPath.
  exports: resolveUserDataPath(), readIsPackaged(), readResourcesPath()
  dependencies: node:module createRequire, electron (lazy)
  data_shapes: string | null / boolean / string | undefined
  side_effects: none beyond lazy require
  role: utility
  observations: Gated on process.versions.electron so plain-Node integration server doesn't crash (:17-26). Each consumer keeps a one-line delegate method for test override (PulumiService.ts:4413-4436, PulumiEngineService.ts:676-678, PulumiWorkspaceService.ts:805-807). No unit test in scope.

- path: app/packages/desktop-main/src/services/guided-iam-rotation-integration.test.ts
  purpose: Integration test driving real GuidedIamService.rotate() then IamCheckService.checkPermissions() against a shared real ElectronStoreService, pinning that post-rotation clients use the rotated key (not the bootstrap key) and report origin 'guided'.
  role: test (integration, aws-sdk-client-mock)
  observations: Tests out-of-scope services (GuidedIamService, IamCheckService) — lives here only because of its lowercase filename.

- path: app/packages/desktop-main/src/services/mergeGameLists.ts
  purpose: Pure merge of declared games (deployment-config.json) and deployed game names (stack outputs) into GameListEntry[] with drift attached.
  exports: mergeGameLists(declared, deployed, driftEntries?)
  dependencies: @hyveon/shared redactGameServer, types DriftEntry, GameListEntry, GameServer
  data_shapes: GameListEntry { name, declared, deployed, config?, drift? { kind, changedFields } }
  side_effects: none
  role: pure function
  observations: Redaction seam for health-check credential before IPC (:12-14). Doc still references an `/api/games` HTTP route (:7), but the desktop app has no HTTP transport (CLAUDE.md invariant) — stale. Ordering: declared order then deployed-only (:18-20). Consumers: GamesWriteService, games.controller.

- path: app/packages/desktop-main/src/services/mergeGameLists.test.ts
  purpose: Pins declared-only/deployed-only/both flags, dedupe, ordering, drift attach (config_drift, pending_create/delete), default empty drift, health-check redaction to secretSet.
  role: test
  observations: Titles still say "tfstate" (lines 15, 49) — Terraform-era wording.

- path: app/packages/desktop-main/src/services/sleep.ts
  purpose: setTimeout-backed sleep(ms) shared by services' protected sleep seams.
  exports: sleep(ms)
  dependencies: none
  side_effects: timer
  role: utility
  observations: Consumers: GuidedIamService, BootstrapService, AwsProfileService. folderUpload/uploadEngine.ts defines its own abortableSleep (uploadEngine.ts:76-89) rather than extending this one.

- path: app/packages/desktop-main/src/services/verifyAccessKeyWithRetry.ts
  purpose: Retry loop for verifying newly minted IAM access keys (default delays 1/2/4/8/8 s, 6 attempts ~23 s).
  exports: VERIFY_ACCESS_KEY_RETRY_DELAYS_MS, VerifyAccessKeyWithRetryOptions, verifyAccessKeyWithRetry(verify, options)
  dependencies: ../logger, @hyveon/shared errMessage
  data_shapes: options { sleep (required), delaysMs?, onAttemptFailed? }
  side_effects: logs; sleeps via caller seam
  role: utility
  observations: Rethrows the last original error unchanged (:69). Consumers: AwsProfileService, GuidedIamService.

- path: app/packages/desktop-main/src/services/verifyAccessKeyWithRetry.test.ts
  purpose: Pins first-try success w/o sleep, retry until success, delay order, no sleep after final failure, original error rethrown, onAttemptFailed numbering, custom/default delays, debug/warn logs without raw error or key values.
  role: test
```

## app/packages/desktop-main/src/services/folderUpload

```yaml
- path: app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.ts
  purpose: undici-based REST client for one FileBrowser helper, pinned to a per-launch self-signed cert by SHA-256 fingerprint.
  exports: FileBrowserClientOptions, RemoteEntry, UploadFileArgs, FileBrowserApi (interface), PinMismatchError, FileBrowserHttpError, FileBrowserClientFactory (@Injectable), FileBrowserClient
  dependencies: undici Agent/request, node:fs createReadStream, node:stream Transform, @hyveon/shared errMessage
  data_shapes: POST /api/login (JWT text → X-Auth), POST /api/resources/<path>/ (mkdir; 409 ok), POST /api/resources/<path>?override=true (octet-stream upload), GET /api/resources/<dir>/ (404 → null; items[])
  side_effects: HTTPS network to helper task, local file reads
  role: HTTP client (main process → ECS helper)
  observations: Trust = only the launch cert as CA + checkServerIdentity fingerprint compare (:123-130); TLS trust failures mapped to PinMismatchError by walking cause chain (:99-106). Password held in memory only (:12-13). AbortError passes through un-normalized (:216). Verified against filebrowser v2.63 (:113-114).

- path: app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.test.ts
  purpose: Against a real local fake TLS FileBrowser (testing/fake-filebrowser-server.ts), pins login/mkdir/upload-through-counter/list, null on missing dir, FileBrowserHttpError on login rejection and non-2xx upload, PinMismatchError with nothing sent on a different cert and on fingerprint mismatch with same CA, refusal before login; also that generateEphemeralCert yields distinct certs.
  role: test

- path: app/packages/desktop-main/src/services/folderUpload/ProgressAggregator.ts
  purpose: Accumulates upload byte/file counts and emits FolderUploadProgress snapshots every 500 ms with EMA rate (α=0.3) and ETA after 3 samples.
  exports: PROGRESS_INTERVAL_MS, ProgressAggregator
  dependencies: @hyveon/shared/folderUpload types FolderUploadPhase, FolderUploadProgress, OverwriteSummary
  data_shapes: snapshot { game, phase, bytesDone, bytesTotal, filesDone, filesTotal, currentPath, bytesPerSecond, etaSeconds, error, overwrite }
  side_effects: setInterval timer, emit callback
  role: helper class
  observations: Rate only sampled in 'uploading' phase (:115). Resume-skipped bytes advance the tick baseline so they aren't counted as throughput (:78-81). bytesDone can run ahead of what landed; 'done' only after verification (:15-16). bytesTotal/filesTotal are constructor params declared non-readonly but never mutated (:33-34).

- path: app/packages/desktop-main/src/services/folderUpload/ProgressAggregator.test.ts
  purpose: Pins ~500 ms emission + final stop emit, counters/currentPath, byte rollback floored at zero, skipped bytes excluded from rate, smoothed rate with delayed ETA, phase-change clears path and carries error, overwrite summary only during awaiting-confirmation.
  role: test

- path: app/packages/desktop-main/src/services/folderUpload/ephemeralCert.ts
  purpose: Generates a throwaway self-signed P-256 cert (24 h validity, 5 min backdate) for one upload-helper launch.
  exports: EphemeralCert { certPem, keyPem, fingerprint256 }, generateEphemeralCert(now?)
  dependencies: selfsigned, node:crypto X509Certificate
  data_shapes: CN/SAN 'hyveon-seed-helper' placeholder; client pins fingerprint rather than hostname
  side_effects: none (CPU only)
  role: utility
  observations: keyPem documented as never logged/sent to renderer (:7). No dedicated test file; covered indirectly by FileBrowserClient.test.ts.

- path: app/packages/desktop-main/src/services/folderUpload/tlsLaunch.ts
  purpose: Builds ECS container overrides that decode base64 cert/key env vars to /tmp and exec filebrowser --cert/--key.
  exports: TlsContainerSettings, buildTlsContainerSettings(filebrowserArgs, cert)
  dependencies: type EphemeralCert
  data_shapes: { entryPoint ['sh','-c'], command [script, 'filebrowser', ...args], environment [FB_TLS_CERT_B64, FB_TLS_KEY_B64] }
  side_effects: none (pure)
  role: pure function
  observations: Private key travels as a plaintext task-definition/override env var FB_TLS_KEY_B64 (:30-33) — visible to anyone with ecs:DescribeTaskDefinition/DescribeTasks. Notes it is meant to be replaceable by a Caddy sidecar (:16-17), cf. the in-task TLS invariant. No test file.

- path: app/packages/desktop-main/src/services/folderUpload/uploadEngine.ts
  purpose: Upload orchestration primitives: ancestor-dir creation, remote listing, overwrite classification, resume-aware bounded-concurrency upload with retries, and post-upload verification.
  exports: UploadItem, UploadEngineOptions, DEFAULT_ENGINE_OPTIONS (concurrency 4, maxAttempts 3), UploadCancelledError, ConfirmationTimeoutError, FileChangedError, UploadFileError, VerifyResult, abortableSleep, ancestorDirs, ensureDirs, listPlannedDirs, remoteSizesOf, listRemoteSizes, classifyUpload, verifyUpload, uploadAll
  dependencies: FileBrowserClient (FileBrowserApi, errors), ProgressAggregator, @hyveon/shared/folderUpload MAX_OVERWRITE_SAMPLES, node:fs/promises stat
  data_shapes: OverwriteSummary { conflictCount, identicalCount, newCount, otherExistingCount, samples[] }; VerifyResult { ok, missing, mismatched }
  side_effects: network via FileBrowserApi, local stat, timers
  role: domain logic module
  observations: Resume = same-size match only, no content hash (:271, :180-181). Local file re-stat'd before each attempt; size or mtime change is permanent FileChangedError (:229-230). Permanent = cancel, pin mismatch, file change, 4xx except 408/429 (:207-211). Linear backoff 500 ms × attempt (:249). First failing file aborts all in-flight uploads via inner controller (:278-289). ConfirmationTimeoutError extends UploadCancelledError but overrides message after super (:42-47). otherExistingCount counts every remote file in listed parent dirs not in the plan (:189). Consumer: FolderUploadService.

- path: app/packages/desktop-main/src/services/folderUpload/uploadEngine.test.ts
  purpose: Pins ancestorDirs ordering, parents-first mkdir, full upload counting, ≤4 in flight, resume skip vs partial overwrite, retry with byte rollback, failure naming path after 3 attempts, no retry for 4xx/pin mismatch, retry on 5xx, size/mtime change refusal, cancellation aborting in-flight, verify missing/mismatch, one list per parent, missing dirs omitted, list stops on abort, classifyUpload buckets incl. zero-byte conflict and 20-sample cap.
  role: test
```

---

## Observed behaviours

- Engine is installed only into `<userData>/pulumi/versions/<pin>` (env override `HYVEON_PULUMI_ENGINE_DIR`, tmpdir fallback), never PATH/~/.pulumi — S/PulumiEngineService.ts:634-663.
- A failed engine provisioning attempt is not memoized; the next resolve() retries from scratch — S/PulumiEngineService.ts:363-368.
- Engine version must equal the pin exactly; the SDK's own check is only a minimum — S/PulumiEngineService.ts:271-279, :594-598.
- Fresh engine installs go staging → rename → re-verify, with the prior occupant parked in `.trash-<uuid>` and restored on failure — S/PulumiEngineService.ts:487-584.
- Superseded pinned versions are pruned after every successful fresh install — S/PulumiEngineService.ts:582-583, :613-627.
- Pulumi stack name is always the bare `production`, project `hyveon` — S/PulumiWorkspaceService.ts:31, :45.
- Backend is the DIY S3 backend `s3://<stateBucket>?region=<r>`, plus `AWS_REGION` env, with `passphrase` secrets provider — S/PulumiWorkspaceService.ts:423, :475-491.
- Stack secrets passphrase = HMAC-SHA256(frozen salt, accountId + stackName), from a live sts:GetCallerIdentity every call, never stored — S/PulumiWorkspaceService.ts:95-99, :425-435.
- Legacy stored `pulumi.passphrase` is migrated via `pulumi stack change-secrets-provider` (old via env, new via stdin), then deleted from the store only on success — S/PulumiWorkspaceService.ts:459-473, :592-619.
- Legacy migration refuses with a keychain-unlock error if safeStorage is unavailable rather than handing ciphertext to the CLI — S/PulumiWorkspaceService.ts:447-458.
- Every successful getOrCreateStack sets `pulumi.stackInitialized = true` in electron-store — S/PulumiWorkspaceService.ts:512.
- Credential env for the engine always clears the unselected source's vars with '' (incl. AWS_SESSION_TOKEN on pasted path) — S/PulumiCredentialResolver.ts:99-122.
- No credential source selected → PulumiCredentialsNotConfiguredError, never the engine's default chain — S/PulumiCredentialResolver.ts:95-97.
- A pasted-credentials entry wins over a same-named `~/.aws` profile — S/awsCredentialSource.ts:101-116.
- AWS SDK clients are rebuilt only when region or credential signature changes — S/awsClientCache.ts:41-47; S/awsCredentialSource.ts:177-189.
- Only one Pulumi operation (preview/up/destroy/rollback) runs per PulumiService instance at a time (in-process `operationInFlight`) — S/PulumiService.ts:677, :1450-1465.
- initializeStack has its own reentrancy flag; preview/apply/destroy/confirmRollback/clearStaleLock refuse while it's set — S/PulumiService.ts:777-807.
- getStackOutputs never throws and returns null while any operation or stack-init is running, or if bucket/stackInitialized/region are missing, or outputs are `{}` — S/PulumiService.ts:968-1018.
- initializeStack installs the `@pulumi/aws` plugin at the version read from its installed package.json, then runs `stack.refresh()` on an inert program — S/PulumiService.ts:1151-1176, :1213-1217.
- preview() does not take the DIY backend lock and does not record lock attempts; up/destroy/refresh do — S/PulumiService.ts:1483-1490, :1165, :2322, :3058.
- Preview reads the config object head via RemoteFileStore and refuses if the caller's configVersionId is no longer head — S/PulumiService.ts:1581-1593.
- Legacy https configs are normalised and cross-game webPort collisions rejected before any Pulumi call — S/PulumiService.ts:3413-3421.
- Operator game env values (≥4 chars) are redacted longest-first from preview/apply streamed output and pulumi.log — S/PulumiService.ts:1371-1408, :1647, :2296.
- Destroy output is not passed through env-value redaction — S/PulumiService.ts:3033-3036.
- changeSummary comes from onEvent summaryEvent, falling back to stack.history(1) only if same kind, succeeded, and started within 30 s skew — S/PulumiService.ts:1259-1285.
- planHash = sha256(plan artifact bytes ++ configVersionId); engineVersion stored separately with leading 'v' stripped — S/PulumiService.ts:3944-4003.
- apply enforces an 8-step gate (record exists, kind plan, approved, approval ≤15 min, planHash match, config head unchanged + artifact re-hash, engine version match, then durable createRun) — S/PulumiService.ts:2020-2105.
- An apply-kind record with partialApply:true for the plan blocks any retry of that plan — S/PulumiService.ts:2037-2039.
- A durable `kind:'apply', status:'aborted', partialApply:true` pre-flight marker is written before stack.up(); failure to write it aborts apply and releases the lock — S/PulumiService.ts:2211-2235; S/RunRecordService.ts:439-475.
- Partial apply = any mutating resOutputsEvent before failure/abort; persisted only on non-success outcomes — S/PulumiService.ts:2313-2316, :2474.
- A lock conflict that is a provable own orphan is cleared via stack.cancel() and the up/destroy retried once; otherwise PulumiUnrecognizedLockError — S/PulumiService.ts:2324-2346, :3060-3082.
- Own-orphan proof requires identity match, PID dead (ESRCH), and a distinct fresh (≤2 h) ownership record started at or before the lock for every lock — S/PulumiLockRecovery.ts:211-305.
- Lock-ownership records are kept (not cleared) when an operation escalates, to serve as later reclaim evidence — S/PulumiService.ts:2416-2419, :3150-3153.
- Cancellation escalates after 30 s by abandoning the promise (no process kill) — S/PulumiCancellation.ts:68, :226-238.
- A pre-aborted signal never invokes the Pulumi operation — S/PulumiCancellation.ts:197-202.
- The SDK's post-success leaked-promise throw is treated as success; apply/destroy rebuild results from stack.outputs()/info() — S/PulumiLeakedPromise.ts:70-94; S/PulumiService.ts:2348-2372, :3084-3107.
- On successful apply/destroy, the ConfigService stack-outputs cache is invalidated and operationInFlight cleared before the run record is persisted — S/PulumiService.ts:2494-2544, :3212-3244.
- Force-closed operation generators abort the internal controller and await settlement before releasing the in-process guard, then persist an aborted record — S/PulumiService.ts:1819-1847, :2589-2657, :3275-3329.
- Destroy is gated by a single-use, 5-minute, target-bound (state bucket + region) confirmation token consumed synchronously before createRun — S/PulumiService.ts:325, :2952-2959, :3797-3837.
- Config-presence checks in destroy run before the token, so they don't burn it — S/PulumiService.ts:2926-2952.
- Stale-lock clear is gated by a single-use 5-minute target-bound token and only calls stack.cancel(); it never retries the original op — S/PulumiService.ts:3700-3754.
- Rollback restores the historic config bytes as new head via DeploymentConfigService, then plans with rolledBackFrom; plan failure after restore records an orphaned-rollback marker — S/PulumiService.ts:3579-3649.
- Rollback target = version immediately older than the apply's configVersionId in listVersions order — S/PulumiService.ts:3380-3401.
- Local run artifacts live at `<runsDir>/<runId>/{<runId>.plan.json, pulumi.log, run.json}`; runId must match /^[A-Za-z0-9_-]+$/ — S/PulumiService.ts:290, :1630-1632, :4109-4122, :4229-4272.
- Live run output fans out from an in-memory buffer (full replay then live); finished runs replay pulumi.log as stdout chunks — S/PulumiService.ts:4138-4218.
- Run logs ≤350 KiB are inlined on the DynamoDB record; larger logs are offloaded to S3 (logS3Key) — S/RunRecordService.ts:103, :343-357.
- RunRecordService.persist always releases the run lock in `finally`, even when no table is configured — S/RunRecordService.ts:316-390.
- Run-history table name falls back to a deterministic name derived from the persisted DeploymentConfig before first apply — S/RunRecordService.ts:267-271.
- RunService's durable DynamoDB lock is skipped whenever stack outputs lack runsTableName (no pre-apply fallback); in-memory lock still enforced — S/RunService.ts:179-195.
- Run lock TTL is 1 h; an expired in-memory lock is taken over silently — S/RunService.ts:40, :163.
- Run-lock clear requires minting with the displayed runId and a fresh token still bound to the current lock — S/RunService.ts:312-376.
- safeStorage unavailable → encrypt returns plaintext and decrypt returns input unchanged — S/SafeStorageService.ts:48-54, :88-93.
- FileBrowser helper auto-stop: one-time EventBridge Scheduler universal-target ecs:StopTask with ActionAfterCompletion DELETE; existing same-named schedule deleted first — S/SchedulerService.ts:101-132.
- Main window maximize state is pushed to the renderer on `window.maximizedChange` via webContents.send — S/WindowService.ts:117-124.
- Public IP for the helper SG rule comes from checkip.amazonaws.com with a 5 s timeout, IPv4 only — S/PublicIpService.ts:6-7, :18-29.
- Folder uploads run 4 files concurrently, 3 attempts each, resume by same size, re-stat each file, and abort all on the first permanent failure — S/folderUpload/uploadEngine.ts:27-31, :217-296.
- Helper TLS: per-launch self-signed P-256 cert, client pins SHA-256 fingerprint, key delivered as base64 container env var — S/folderUpload/ephemeralCert.ts:26-40; S/folderUpload/FileBrowserClient.ts:121-131; S/folderUpload/tlsLaunch.ts:22-35.
- Diagnostics bundles include only an explicit allowlist of config fields, plus regex scrubbing of key-shaped strings — S/diagnosticsBundleAllowlist.ts:85-102; S/diagnosticsLogScrubber.ts:31-38.
- Declared game configs are redacted (health-check auth → secretSet) before reaching games.list IPC — S/mergeGameLists.ts:34-41.
- New IAM keys are verified up to 6 times over ~23 s to absorb propagation delay — S/verifyAccessKeyWithRetry.ts:12, :46-79.

## Cross-scope references

Outbound (in-scope → out-of-scope):
- `S/ElectronStoreService.ts` — get/set('aws' | 'bootstrap' | 'pulumi'), getPastedCredentials, getPulumiPassphrase, isSafeStorageAvailable, recordPulumiLockAttempt / clearPulumiLockAttempt / listPulumiLockAttempts (type PulumiLockOwnershipRecord), recordOrphanedRollback. Used by PulumiService, PulumiWorkspaceService, PulumiLockRecovery, PulumiCredentialResolver, awsCredentialSource, SchedulerService.
- `S/ConfigService.ts` — getStackOutputs() (RunService, RunRecordService), getRegion() (SchedulerService); bound as CONFIG_CACHE_INVALIDATOR (invalidateCache) for PulumiService via `modules/config.module.ts`.
- `S/LockClearConfirmationGate.ts` — mint/assertFresh used by PulumiService and RunService.
- `S/DeploymentConfigService.ts` — restoreRawConfig via DEPLOYMENT_CONFIG_SERVICE token (`modules/deployment-config.module.ts`).
- `modules/cloud-provider.tokens.ts` — RUN_RECORD_STORE, REMOTE_FILE_STORE (concrete stores from `@hyveon/cloud-aws` bound in `modules/cloud-provider.module.ts`).
- `modules/run-record.module.ts` — binds RUN_RECORD_PERSISTER → RunRecordService and RUN_LOCK_SERVICE → RunService.
- `@hyveon/infra` createInfraProgram (preview/apply program), and `buildStackOutputs` key contract for projectStackOutputs.
- `@hyveon/shared` — CONFIGURATION_OBJECT_KEY, diffDeploymentConfig, findWebPortCollisions, normalizeDeploymentConfigGames, isApprovalExpired, RunLockHeldError, isRunLockExpired, buildRunSk, deriveRunStatus, resolvePreApplyRunsTableName, PULUMI_ENGINE_VERSION, formatRelativeAge, redactGameServer, errMessage; `@hyveon/shared/folderUpload` (FolderUploadProgress, OverwriteSummary, MAX_OVERWRITE_SAMPLES).
- `../logger.ts` (winston) everywhere.
- External: @pulumi/pulumi automation (PulumiCommand, LocalWorkspace, Stack, ConcurrentUpdateError), @pulumi/aws package.json, @aws-sdk/client-sts, @aws-sdk/client-scheduler, @aws-sdk/credential-providers fromIni, undici, selfsigned, semver, electron (lazy).
- `testing/fake-filebrowser-server.ts` (FileBrowserClient.test.ts); `S/GuidedIamService.ts`, `S/IamCheckService.ts` (guided-iam-rotation-integration.test.ts).

Inbound (out-of-scope → in-scope):
- PulumiService ← `controllers/iac.controller.ts`, `controllers/iac-runs.controller.ts`, `S/ConfigService.ts` (getStackOutputs delegate), `modules/pulumi-service.module.ts`, `modules/run-record.module.ts`, `modules/config.module.ts`, `modules/deployment-config.module.ts`, `test-mocks/pulumi-mock.ts`, web e2e integration specs (`iac-plan`, `iac-apply-gates`, `pulumi-di-seam`, `iac-destroy-token`, `iac-streaming-ansi`, `fixtures/ipc-harness.ts`).
- PulumiEngineService ← `controllers/iac.controller.ts`, `controllers/iac-settings.controller.ts`, `modules/pulumi-engine.module.ts`. PulumiWorkspaceService ← `modules/pulumi-workspace.module.ts`. PulumiLockRecovery ← `controllers/iac.controller.ts`.
- RunRecordService ← `controllers/iac.controller.ts`, `controllers/iac-runs.controller.ts`, `modules/run-record.module.ts`, web e2e `iac-run-records`/`iac-streaming-ansi`. RunService ← `controllers/iac-runs.controller.ts`, `modules/run-record.module.ts`.
- SafeStorageService ← `S/ElectronStoreService.ts`, `S/GuidedIamService.ts`, `S/AwsProfileService.ts`, `modules/electron-store.module.ts`, web e2e `guided-iam.spec.ts`.
- SchedulerService, PublicIpService ← `S/FileManagerService.ts`, `modules/aws.module.ts`.
- WindowService ← `electron-entry.ts` (attach after createWindow), `controllers/window.controller.ts`, `app.module.ts`.
- folderUpload/* ← `S/FolderUploadService.ts`, `modules/folder-upload.module.ts`, `testing/fake-filebrowser-client.ts`; ephemeralCert/tlsLaunch ← `S/FileManagerService.ts`.
- awsCredentialSource ← `S/CloudHealthService.ts`, `S/Ec2Service.ts`, `S/EcsService.ts`, `S/LogsService.ts`, `S/AwsProfileService.ts`, `S/GuidedIamService.ts`, `S/BootstrapService.ts`, `S/IamCheckService.ts`, `modules/cloud-provider.module.ts`. awsClientCache ← Ec2Service, EcsService, LogsService.
- electronRuntime ← `S/CloudHealthService.ts`, `S/ConfigService.ts`, `S/GuidedIamService.ts`. sleep, verifyAccessKeyWithRetry ← AwsProfileService, GuidedIamService (+ BootstrapService for sleep).
- mergeGameLists ← `S/GamesWriteService.ts`, `controllers/games.controller.ts`. diagnosticsBundleAllowlist, diagnosticsLogScrubber ← `S/DiagnosticsBundleService.ts`.
- `__fixtures__/aws-profile` ← `S/AwsProfileService.test.ts`.
