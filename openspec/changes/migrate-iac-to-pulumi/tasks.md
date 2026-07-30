## 1. Spikes (gate everything else)

- [x] 1.1 Add `@pulumi/pulumi@3.255.0` and `@pulumi/aws@7.39.0` to a scratch workspace; mark `@pulumi/pulumi` `external` in `electron.vite.config.ts` and add it plus `@pulumi/aws` to `electron-builder.yml` `files`, following the `@cdktf/hcl2json` precedent
- [x] 1.2 Spike: run `PulumiCommand.install({ root: <userData>/pulumi })` from the Electron main process and confirm the binary lands at `<root>/bin/pulumi` and that a second call short-circuits
- [x] 1.3 Spike: run a trivial inline program from inside a packaged `app.asar` build and confirm the `--client` gRPC callback executes the closure — this is the highest-risk unknown and gates the whole approach
- [x] 1.4 During the first bootstrap run, point `PULUMI_BACKEND_URL` at the newly created bucket and run a read-only `stack ls` to confirm the `s3://` driver authenticates without a login (Open Question 1); if it fails, add a login step to the workspace seam
- [x] 1.5 Spike: after one `preview` and one `up`, confirm the Electron app quits cleanly with no orphaned `pulumi` process; add this as a permanent e2e check rather than a one-off
- [x] 1.6 If 1.3 fails, stop and re-evaluate against the OpenTofu auto-download fallback recorded in `design.md` before continuing

## 2. Infra workspace scaffold

- [x] 2.1 Create the `app/packages/infra` workspace (`@hyveon/infra`) with its `package.json`, `tsconfig.json`, and ESLint wiring so root `app:lint` / `app:test` pick it up
- [x] 2.2 Define the typed configuration model in `@hyveon/shared`, covering both the `game_servers` map and the top-level deployment settings (project name, region, hosted zone, watchdog tunables), with TSDoc on every field
- [x] 2.3 Add unit tests for the configuration model covering every field, including the `https` flag that HCL round-tripping previously corrupted
- [x] 2.4 Define the stack-outputs type in `@hyveon/shared`, covering cluster, subnet, security-group, Discord table and secret locations, interactions invoke URL, and runs table name

## 3. Infra program — resource parity

- [x] 3.1 Port networking: VPC, subnet, internet gateway, route table, association
- [x] 3.2 Port EFS: file system, mount target, per-game save-data access points, per-HTTPS-game certificate access points
- [x] 3.3 Port ECS: cluster and per-game task definitions derived by iteration over the config map, including the Caddy sidecar container for `https = true` games
- [x] 3.4 Port security groups, including the deduplicated per-game port ingress and the 443/80 opening for HTTPS games
- [x] 3.5 Port IAM roles and policies (6 roles, 5 inline policies, 1 attachment)
- [x] 3.6 Port the five Lambda functions with code sourced from prebuilt `dist/handler.cjs` bundles, plus their log groups, permissions, and the function URL
- [x] 3.7 Port EventBridge rules and targets for the DNS updater and the watchdog
- [x] 3.8 Port DynamoDB tables (discord, runs, audit) and the Secrets Manager secrets, declaring placeholder versions only — drop the `discord_bot_token` / `discord_public_key` inputs so no secret value can enter the stack, and ensure a re-deploy never resets a configured secret back to its placeholder
- [x] 3.9 Port Route53: hosted-zone lookup and the updater Lambda only — assert no per-game DNS record resources exist, since the Lambda is the sole writer
- [x] 3.10 Port the remaining imperative escapes (`aws_dynamodb_table_item` ×2, `aws_lambda_invocation`, `terraform_data`, `aws_secretsmanager_secret_version` ×2) as explicit constructs, and document why each is not a plain resource
- [x] 3.11 Export the stack outputs defined in 2.4
- [x] 3.12 Diff the synthesized resource inventory against the 69 Terraform resources and record any intentional omission with its reason

## 4. Engine runtime

- [x] 4.1 Add the pinned engine version constant to `@hyveon/shared`
- [x] 4.2 Implement `PulumiEngineService`: memoized resolution, install into `<userData>`, non-throwing constructor, typed provisioning errors, no partial-install reuse
- [x] 4.3 Implement the workspace seam: `pulumiCommand`, `pulumiHome`, one stable reused `workDir` per stack under `userData` (relocating the tmpdir leak is not fixing it — reuse, do not create per operation), `PULUMI_BACKEND_URL`, bare stack name
- [x] 4.4 Generate a passphrase, store it via `SafeStorageService`, and supply it on every invocation — it must exist before the first stack is created (a missing passphrase is a hard exit-1 under `--non-interactive`, not a prompt), and a missing passphrase for an existing stack must fail loudly rather than generate a replacement
- [x] 4.5 Propagate wizard-selected credentials into `envVars` — named profile via `AWS_PROFILE`, pasted keys decrypted in the main process — and add a test asserting no key material reaches streamed output or logs
- [ ] 4.6 Report engine provisioning, provider plugin download, and the operation itself as distinct phases (engine-provisioning phase done — `PulumiEngineService.resolve(onPhase)`/`PulumiWorkspaceService.getOrCreateStack(onPhase)`; plugin-download and operation phases are NOT yet fired — no operation-running code exists yet to observe them. Phase 7.1 (`PulumiService.preview`) must call `onPhase?.('plugins'/'operation', ...)` around its first `stack.preview()` call — see task-4.5-4.6-report.md)
- [ ] 4.7 Implement cancellation: `AbortSignal` for user cancel plus a bounded escalation timer to forceful termination, since the SDK never escalates past `SIGINT` (the reusable primitive is done and tested — `PulumiCancellation.ts`'s `runWithEscalatingCancellation`/`PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS`, with three distinct settlement shapes — `PulumiOperationNotStartedError`/`PulumiOperationAbortedError`/`PulumiOperationEscalatedError` — so Phase 7 never has to read `signal.aborted` post-hoc; verified from SDK source that no PID/process handle is exposed via the *public* API, but an unofficial override of `PulumiCommand.prototype.run` on the held instance is technically possible, just declined here for duplication cost with no real call site to verify against yet; Phase 7 must wire `runWithEscalatingCancellation` around its actual `stack.preview/up/destroy` calls and decide whether to build the unofficial `run` override or an OS-level kill mechanism for the `onEscalate` hook — see task-4.7-4.9-report.md)
- [ ] 4.8 Implement lock recovery keyed on provable ownership: record the identity of every lock the app causes to be taken, reclaim the app's own orphans (including after forceful termination) without prompting, and require operator confirmation showing holder and age for any lock it cannot prove it owns (ownership-record mechanism, classification logic — identity match **plus PID-liveness plus time-consistency**, not identity alone, after a review caught identity-only matching could misclassify a live same-machine lock as reclaimable — and the confirmation-required typed error are done and tested against the scenarios a real `ConcurrentUpdateError` can exercise (3 of 4; "in-app busy" is argued in prose/TSDoc since no Pulumi busy-guard exists yet to construct a test against — see the report), plus record pruning/consumption so a single leaked record can't permanently arm auto-reclaim — `PulumiLockRecovery.ts`, `ElectronStoreService.recordPulumiLockAttempt`/`clearPulumiLockAttempt`/`listPulumiLockAttempts` — but nothing calls them yet: Phase 7 must call `recordPulumiLockAttempt` before and `clearPulumiLockAttempt` after each real operation, catch `ConcurrentUpdateError` from `stack.preview/up/destroy`, call `classifyStackLockConflict`, and actually invoke `stack.cancel()` on a `'reclaimable-own-orphan'` result — see task-4.7-4.9-report.md)
- [ ] 4.9 Handle the "succeeded then threw" leaked-promise path so a successful apply is not reported as a failure (the classifier and recovery wrapper are done and tested — `PulumiLeakedPromise.ts`'s `isLeakedPromiseError`/`runTreatingLeakedPromiseAsSuccess`, with source-verified proof this can only be reached after the real operation succeeded — but Phase 7 must supply the real `recoverResult` callback, most plausibly re-reading `stack.outputs()`/`stack.info()` after the fact, since the original `UpResult`/`PreviewResult` is unrecoverable once the SDK's promise has rejected this way; **also verified that recovering this way still leaks the language-server gRPC server, the event-log gRPC server, and the temp log file** — `stack.js`'s `finally` block throws before reaching `server.forceShutdown()`/`cleanUp()` — design.md corrected, and Phase 7/11's "app quits cleanly" e2e check must specifically cover a run that exercises this leaked-promise-recovery path, not only the happy path — see task-4.7-4.9-report.md)
- [x] 4.10 Add a repeated-operation test asserting the workspace directory count under `userData` does not grow across many previews and applies

## 5. Bootstrap

- [x] 5.1 Remove `ensureLockTable`, its `wizard.bootstrap.lockTable` IPC channel, its preload mirror, and its bootstrap-step row
- [x] 5.2 Rename the tfvars bucket concept to the configuration bucket throughout `BootstrapService` and the wizard step, preserving the versioning and 90-day noncurrent-expiry behavior
- [x] 5.3 Apply all four S3 public-access-block settings to both buckets, on creation and on an already-existing bucket — `BootstrapService` currently applies none, while the `terraform/bootstrap/` module it mirrors applies all four
- [x] 5.4 Update the `HyveonDeployAll` policy in `docs/docs/setup.md`: add the four DIY-backend S3 actions and `s3:PutPublicAccessBlock`, remove the lock-table DynamoDB actions
- [x] 5.5 Update the `wizard.bootstrap.*` IPC surface for the changed resource set — drop the lock-table channel, add the public-access-block outcome to per-resource status — and mirror it in the preload and typed API
- [x] 5.6 Update `BootstrapService` tests and the bootstrap wizard-step tests for the added, removed, and renamed operations, including per-resource `failed` status not masking sibling resources

## 6. Configuration store

- [x] 6.1 Replace `TfvarsService`'s HCL read path with JSON parsing against the shared config type
- [x] 6.2 Replace the write path with JSON serialization, deleting `hclSurgeon.ts`, `hclEmit.ts`, and their tests
- [x] 6.3 Delete local-file mode: remove the disk read path, the unguarded `writeFileSync`, and `ConfigService.getTfvarsPath()`, so the S3 bucket is the only configuration source
- [x] 6.4 Make an unconfigured bucket report incomplete setup and route to the wizard — assert in a test that no disk fallback is reachable
- [x] 6.5 Add a round-trip test proving a config containing every field, top-level and per-game, survives write-then-read deeply equal
- [x] 6.6 Remove `@cdktf/hcl2json`, `patches/@cdktf+hcl2json+0.21.0.patch`, its `external` marking, and its `electron-builder.yml` `files` entries; confirm no HCL parser remains in the dependency tree

## 7. Service replacement

- [ ] 7.1 Implement `PulumiService.preview` returning structured `changeSummary`, saving the update plan as a run artifact, reusing the existing chunk line-splitting for `onOutput`/`onError`
- [ ] 7.2 Implement `PulumiService.up` constrained by the saved plan, distinguishing clean failure from partial apply in the run's terminal state
- [ ] 7.3 Implement `PulumiService.destroy` behind the existing confirmation-token gate; assert no untokened call site exists
- [x] 7.4 Implement stack output reads replacing `ConfigService.getTfOutputs()`, degrading to "not deployed yet" for a never-deployed stack (`PulumiService.getStackOutputs()`, delegated to via `ConfigService.getStackOutputs()`; all ~14 real call sites migrated — see task-7.4-7.8-7.9-report.md)
- [ ] 7.5 Port the plan-hash gate: hash over the saved plan artifact plus the config object's version id, with the staleness check independent of plan-file parseability, and refuse to apply a plan produced by a different engine version (`plan.json`'s `manifest.version`)
- [ ] 7.6 Port `resolveRollbackTarget` / `confirmRollback` to the JSON config object, restoring historic content byte-for-byte, holding the shared lock across restore and plan-record persistence, with compensating semantics when plan creation fails
- [ ] 7.7 Make apply-lock acquisition a single atomic compare-and-set that is the authoritative gate, not a preceding "workspace is free" check
- [x] 7.8 Add the optional structured change summary to `RunRecord` in `@hyveon/shared/runs.ts` and persist it, keeping older records readable (`ChangeSummary`/`OpType` in new `@hyveon/shared/changeSummary.ts`; type plumbed through `RunRecordService`/`AwsRunRecordStore`, nothing calls it with a value yet — that's 7.1/7.2's job)
- [x] 7.9 Port the 12 typed error classes, dropping the ones with no Pulumi analogue and adding stale-lock and partial-apply errors (13 original classes found, not 12; 11 ported + `PulumiPartialApplyError` added, colocated in new `PulumiService.ts`; `PulumiUnrecognizedLockError` confirmed as the existing stale-lock class, not recreated — see task-7.4-7.8-7.9-report.md)
- [ ] 7.10 Delete `TerraformService.ts` and its tests

## 8. Controllers and preload

- [ ] 8.1 Repoint all 13 `terraform.*` / `terraform.runs.*` IPC channels at `PulumiService`, renaming them to `iac.*` / `iac.runs.*` and renaming `TerraformController` / `TerraformRunsController` to `IacController` / `IacRunsController`
- [ ] 8.2 Update `ConfigService`: remove `getTfStatePath`, `getTerraformDir`, `seedTerraformWorkspace`, and the tfstate cache; keep the env seams tests rely on
- [ ] 8.3 Update the preload bridge and `hyveon-api.ts` types for the changed payload shapes (structured summary, partial-apply state, stale-lock recovery)
- [ ] 8.4 Update controller unit tests, including the channel-name registration guard
- [ ] 8.5 Rename the `hyveon.terraform` preload namespace to `hyveon.iac` in the preload bridge and `hyveon-api.ts`, and update every renderer call site

## 9. Renderer

- [ ] 9.1 Render the change summary from structured data on the Plan/Apply page; delete the three duplicated summary regexes in `terraform.page.tsx` (renamed `iac.page.tsx`)
- [ ] 9.2 Handle the missing-summary case explicitly — never present an empty summary as "no changes"
- [ ] 9.3 Surface partial-apply failures with re-plan guidance rather than a plain retry
- [ ] 9.4 Add the stale-lock recovery UI with explicit confirmation
- [ ] 9.5 Update the run-history table and read-only detail view to render the structured summary when present and omit it cleanly when absent
- [ ] 9.6 Update the rollback confirmation to identify the target config version and summarize how it differs from current
- [ ] 9.7 Add a deployment-settings section to Settings for the top-level configuration, so no setting requires editing a file — validated before write, sharing the game-form validation patterns
- [ ] 9.8 Rename the `/terraform` route to `/iac` (router config, nav link, routed page component/directory) and update every Playwright page object and e2e mock that references it

## 10. Wizard and prerequisites

- [ ] 10.1 Delete `PrerequisiteService`, the `wizard.prereqs.check` channel, its preload mirror and types, and the prerequisites wizard step
- [ ] 10.2 Remove `prerequisites` from the wizard step list and drop the Reconfigure special-casing that excluded it
- [ ] 10.3 Replace the Terraform-init step with the stack-initialization step, reporting the three provisioning phases and setting the secrets provider at creation
- [ ] 10.4 Replace the Settings Terraform-version row with the resolved engine version plus the pinned version, including a not-yet-provisioned state
- [ ] 10.5 Remove `MINIMUM_TERRAFORM_VERSION` and the version-parsing helpers

## 11. Test surface

- [ ] 11.1 Delete `app/test/fake-terraform.mjs` and the `terraform-shim.ts` / `terraform-fixtures.ts` Playwright fixtures' `PATH`-shim wiring; replace with a `PulumiService` stub injected at the DI seam per the `orchestrator-integration-coverage` delta spec's "In-process engine stub injected via DI" requirement
- [ ] 11.2 Update the integration harness so `ipc` specs resolve stack outputs from the stub's scripted `stack.outputs()` instead of `TF_STATE_PATH`, including the never-deployed-stack case
- [ ] 11.3 Update Electron e2e mocks for the changed IPC payload shapes
- [ ] 11.4 Keep the 1.6 clean-quit check green in CI

## 12. Removal and documentation

- [ ] 12.1 Delete the `terraform/` tree, including `terraform/bootstrap/` and the 376-line `moved.tf`
- [ ] 12.2 Remove the `terraform.tfstate` `extraResources` entry from `electron-builder.yml` and the `.github/workflows/package.yml` step that fabricates a placeholder state file
- [ ] 12.3 Replace the `aws s3api` / `aws dynamodb` recipes in the Makefile generated by `scripts/init-parent.ts` with a Node/TypeScript helper the Makefile invokes, which uses `@aws-sdk/client-s3` and `@aws-sdk/client-dynamodb` — a Makefile cannot import an SDK, it can only shell out, so the SDK work has to live in a program
- [ ] 12.4 Confirm whether the generated-Makefile workflow is maintainer-only; if it is operator-facing, it falls under the app-only operator boundary and the recipe should be removed rather than ported
- [ ] 12.5 Rewrite `docs/docs/components/terraform.md` for the Pulumi program
- [ ] 12.6 Update `docs/docs/setup.md`: drop both prerequisites, the "Configure the AWS CLI" section, and the bootstrap-tfvars CLI walkthrough — and add no CLI steps in their place, since this page is operator-facing
- [ ] 12.7 Record the one-off legacy Terraform teardown in maintainer/contributor notes only, including the duplicate-infrastructure hazard if the Pulumi stack is deployed before the Terraform one is destroyed
- [ ] 12.8 Update `docs/docs/architecture.md`, `docs/docs/guides/user.md`, `docs/docs/guides/submodule.md`, `docs/docs/intro.md`, and `README.md`
- [ ] 12.9 Update `CLAUDE.md`: commands, architecture, the `game_servers` source-of-truth section, and the Terraform-variable checklist
- [ ] 12.10 Assert in docs and tests that no operator-facing instruction requires running any command other than launching the app
- [ ] 12.11 Confirm `npm run app:lint`, `npm run app:test`, `npm run app:test:e2e`, and `npm run app:test:integration` all pass
- [ ] 12.12 Per the `operator-documentation` delta spec: update `docs/docs/guides/maintainer.md` (Lambda count, repo map including `app/packages/infra`, no Route-53-Terraform-managed invariant claim, `app/packages/infra` resource table, full CI workflow list) and `docs/docs/components/management-app.md` (Game CRUD writes the JSON configuration store, not `terraform.tfvars`)
- [ ] 12.13 Add a brief historical note to `docs/docs/architecture.md` on why the project moved from Terraform to Pulumi (multi-cloud optionality, no operator-installed binary, no HCL round-trip) — the rationale narrative, not a capability spec

## 13. Follow-up coordination

- [ ] 13.1 Re-propose `add-one-click-aws-bootstrap` against the Pulumi codebase: drop its `terraform-settings-management` capability and its `TerraformService` credential fix, keep `guided-iam-provisioning`
- [ ] 13.2 Update the CloudFormation-generated policy in that change for the DIY backend — add the four S3 backend actions, drop the lock-table DynamoDB actions
