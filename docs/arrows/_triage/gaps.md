# Active Gap Triage

Classification of every EARS spec marked `[ ]` (active gap) under `docs/intent/**`, checked against the code at `84c1fe0a` (2026-11-01). This file is analysis only: no spec marker, spec text or code is changed by it. Apply the outcomes through the owning leaf's specs file and arrow doc.

## How to read this

Each `[ ]` spec has one class:

| Class | Meaning | Action it implies |
|---|---|---|
| **a** | Implemented — current code already satisfies the spec; it is only unmarked or unannotated | Mark `[x]`, add the `@spec` annotation |
| **b** | Real gap — current code does not satisfy the spec | Build it (tests first) |
| **c** | Defer — a real gap, but low value, speculative, or waiting on a decision | Mark `[D]` with the reason |
| **d** | Spec wrong or stale — misdescribes intent, duplicates another spec, or is a refactor wish rather than a behaviour | Rewrite, merge or remove the spec; move refactor wishes to the LLD's Work Required |

Impact applies to class **b** (and is noted on a few **c** items): **high** = operator-visible failure, data loss, wrong infrastructure, unbounded cost or a secret leak; **med** = a degraded or misleading path with a workaround; **low** = logging, refactor, test coverage or cosmetic. Evidence cites repo-relative `file:line` at `84c1fe0a`; where a spec's own `(gap: …)` note cites older line numbers, the evidence here uses the current ones.

`node bin/coherence-check.mjs` reports 189 `[ ]` specs and 188 "uncovered"; the one covered `[ ]` spec is `CONFIG-FORM-003`, which carries an `@spec` annotation (`app/packages/web/src/hooks/use-deployment-settings.hook.ts`, `deployment-settings-form.component.test.tsx`) while the behaviour it requires is still unbuilt.

## Summary

No `[ ]` spec is implemented-but-unmarked: every gap note still describes the current code. 135 are real gaps, 28 should be deferred and 26 need their spec text fixed.

The 14 high-impact specs reduce to 8 root causes: five single-spec ones (`RT-TASK-LAUNCH-010`, `IAC-RUN-STORE-007`, `APP-WIZARD-RECONF-009`, `APP-DIAG-SCRUB-003`, `DISCORD-DESK-004`), the health-check Lambda environment (`RT-HEALTH-PROV-003`, `IAC-PROGRAM-LAMBDA-011`), the health-check Lambda network path (`RT-HEALTH-PROV-004`, `IAC-PROGRAM-LAMBDA-012`), and the install-region set of five (`IAC-ENGINE-REGION-001`, `CONFIG-SET-012`, `CONFIG-FORM-003`, `CONFIG-FORM-007`, `APP-WIZARD-REGLOCK-001`).

Totals count specs, one class per spec. `APP-WIZARD-HEALTH-008` is counted once, as class d; its guided-install remediation-copy gap is listed as a second row in its segment and is not counted again.

| Segment | Specs file | a | b (high / med / low) | c | d | Total |
|---|---|---|---|---|---|---|
| `run` | `docs/intent/iac/run/run-specs.md` | 0 | 10 (1 / 6 / 3) | 3 | 4 | 17 |
| `engine` | `docs/intent/iac/engine/engine-specs.md` | 0 | 13 (1 / 5 / 7) | 2 | 0 | 15 |
| `program` | `docs/intent/iac/program/program-specs.md` | 0 | 10 (2 / 1 / 7) | 1 | 2 | 13 |
| `task-and-dns` | `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md` | 0 | 10 (1 / 3 / 6) | 1 | 3 | 14 |
| `watchdog` | `docs/intent/game-runtime/watchdog/watchdog-specs.md` | 0 | 3 (0 / 2 / 1) | 1 | 0 | 4 |
| `health-check` | `docs/intent/game-runtime/health-check/health-check-specs.md` | 0 | 4 (2 / 1 / 1) | 0 | 1 | 5 |
| `wizard-and-bootstrap` | `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md` | 0 | 14 (2 / 5 / 7) | 4 | 2 | 20 |
| `diagnostics` | `docs/intent/operator-app/diagnostics/diagnostics-specs.md` | 0 | 8 (1 / 1 / 6) | 4 | 2 | 14 |
| `infra-logs` | `docs/intent/operator-app/infra-logs/infra-logs-specs.md` | 0 | 10 (0 / 1 / 9) | 2 | 1 | 13 |
| `app-update-and-release` | `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md` | 0 | 5 (0 / 2 / 3) | 1 | 3 | 9 |
| `desktop-shell` | `docs/intent/operator-app/desktop-shell/desktop-shell-specs.md` | 0 | 4 (0 / 1 / 3) | 1 | 3 | 8 |
| `ipc-bridge` | `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md` | 0 | 6 (0 / 1 / 5) | 3 | 2 | 11 |
| `game-server` | `docs/intent/game-server/game-server-specs.md` | 0 | 11 (0 / 2 / 9) | 0 | 2 | 13 |
| `deployment-config` | `docs/intent/deployment-config/deployment-config-specs.md` | 0 | 9 (3 / 2 / 4) | 2 | 0 | 11 |
| `discord-bot` | `docs/intent/discord-bot/discord-bot-specs.md` | 0 | 10 (1 / 5 / 4) | 1 | 1 | 12 |
| `helper-task` | `docs/intent/helper-task/helper-task-specs.md` | 0 | 8 (0 / 3 / 5) | 2 | 0 | 10 |
| **Total** | | **0** | **135** (14 / 41 / 80) | **28** | **26** | **189** |

## Top 10 real gaps by user impact

Ranked by consequence to an operator. Several rank entries group specs that describe one root cause from different leaves; fixing the root closes all of them.

| # | Gap | Specs | Consequence | Evidence |
|---|---|---|---|---|
| 1 | Health-check Lambda cannot run | `RT-HEALTH-PROV-003`, `RT-HEALTH-PROV-004`, `IAC-PROGRAM-LAMBDA-011`, `IAC-PROGRAM-LAMBDA-012`, then `RT-HEALTH-HTTP-005` | Every game that declares `healthCheck` is judged active forever and never idle-stops, so it bills until stopped by hand. | Handler requires `ECS_CLUSTER` at load (`app/packages/lambda/health-check/src/handler.ts:39`) but infra sets only `AWS_REGION_` (`app/packages/infra/src/lambdas.ts:568`); Lambda sits in public subnets with no NAT or VPC endpoints and egress only to game ports (`lambdas.ts:564-567`); watchdog treats a failed check as active (`app/packages/lambda/watchdog/src/handler.ts:159-163`). Once reachable, `https` checks still fail the TLS handshake against the task's private IP (`health-check/src/handler.ts:173-179`). |
| 2 | Desktop Start and Discord `/server-start` race | `RT-TASK-LAUNCH-010` | Overlapping starts launch two paid Fargate tasks for one game; DNS points at whichever reaches RUNNING last. | `withGameLock` is in-process only (`app/packages/cloud-aws/src/AwsCloudProvider.ts:330,427`); followup Lambda checks then calls `RunTask` unguarded, no `clientToken` (`app/packages/lambda/followup/src/handler.ts:126-138`). |
| 3 | Install region is not locked | `IAC-ENGINE-REGION-001`, `CONFIG-SET-012`, `CONFIG-FORM-003`, `CONFIG-FORM-007`, `APP-WIZARD-REGLOCK-001` (and `IAC-ENGINE-REGION-002`) | One edit of the Settings region field points the next apply at a different region: the stack is replaced and EFS world saves are destroyed. A Reconfigure that changes region writes only the electron-store `aws.region`, so it re-points the state backend and the desktop stores at another region without moving the stack. | Settings exposes a free-text region (`app/packages/web/src/components/deployment-settings-form.component.tsx:92-94`) that the hook sends (`use-deployment-settings.hook.ts:155`) and the validator accepts (`app/packages/shared/src/deploymentSettingsWrite.ts:58`); preview/apply pass the stored `awsRegion` to the program (`PulumiService.ts:1611,1629,2293` → `app/packages/infra/src/program.ts:177`, `region: config.awsRegion`); Reconfigure writes any region to `aws.region` (`wizard.controller.ts:205-207`, `GuidedIamService.ts:498`), which only selects the state backend region (`PulumiService.ts:1620-1631`). |
| 4 | Discord config wiped after a failed read | `DISCORD-DESK-004` (and `DISCORD-UI-008`) | A transient DynamoDB read failure caches an empty config; the next permission, admin or guild edit saves it over the real row, erasing allowlists and permissions. | `app/packages/desktop-main/src/services/DiscordConfigService.ts:130-135` caches `emptyConfig()`; mutators at `:300-417` load then save. |
| 5 | Reconfigure can destroy working AWS credentials | `APP-WIZARD-RECONF-009`, `APP-WIZARD-ROTATE-008`, `APP-WIZARD-RECONF-007` | On a guided-IAM install, opening Edit on the credentials step and finishing writes an empty profile; a failed guided re-run deletes the key the app still points at; a cancelled paste leaves unverified keys stored. Each leaves the app without usable AWS access. | `use-reconfigure-answers.hook.ts:226-228` with empty guided prefill (`:151-152`) merged at `wizard.controller.ts:206-207` (code reading, not reproduced); `GuidedIamService.ts:441-445,485`; `use-aws-credentials-form.hook.ts:130`. |
| 6 | Diagnostics bundle leaks JSON-shaped secrets | `APP-DIAG-SCRUB-003` | A secret logged as `"botToken":"…"` or `"apiKey": "…"` reaches the exported bundle unredacted. | The closing quote after the label defeats `LABELED_SECRET_VALUE_PATTERN` (`app/packages/desktop-main/src/services/diagnosticsLogScrubber.ts:15-16`); verified by running the regex. |
| 7 | Durable partial-apply marker is dropped | `IAC-RUN-STORE-007`, then `IAC-RUN-PART-004`, `IAC-RUN-PART-005` | After an interrupted apply, history shows no partial-apply badge and the retry gate refuses with the wrong error, hiding that infrastructure is half-applied. | `AwsRunRecordStore.putRecord` omits `partialApply` (`app/packages/cloud-aws/src/AwsRunRecordStore.ts:188-212`) and `toRunRecord` never reads it (`:339-375`). |
| 8 | Discord follow-up Lambda leaks the token and hangs commands | `DISCORD-RUN-011`, `DISCORD-RUN-010`, `DISCORD-RUN-014` | The interaction token (valid 15 min) is written to CloudWatch; a config-read or network failure leaves the command on "thinking", and async retries re-run the handler. | Whole event logged (`app/packages/lambda/followup/src/handler.ts:277`); config read outside `try` (`:249`); `fetch` not wrapped despite its TSDoc (`app/packages/shared/src/discord/patchOriginal.ts:24`). |
| 9 | update-dns can orphan or delete the wrong record | `RT-TASK-DNS-009`, `RT-TASK-DNS-010`, `RT-TASK-NOTIFY-005` | After a `dnsTtl` change the STOPPED DELETE fails and the A record dangles; a late STOPPED for an old task deletes a live task's record; a task that dies before RUNNING leaves its Discord message stuck on "starting". | DELETE sends current `DNS_TTL` (`app/packages/lambda/update-dns/src/handler.ts:162`), failure swallowed (`:170-172`); no IP ownership check (`:144-149,240-243`). |
| 10 | Watchdog aborts its run when one `StopTask` fails | `RT-WATCHDOG-STOP-004` | A persistently failing `StopTask` for one idle task throws out of the handler, so every task evaluated after it in that run is never checked or stopped and keeps billing; the failure recurs on each scheduled run. | `StopTask` awaited with no `try`/`catch` inside the per-task loop (`app/packages/lambda/watchdog/src/handler.ts:267-273`). Of the med gaps this one has the largest cost consequence, which is why it ranks here. |

Next in line (all **med**): helper upload not re-checking for a server start mid-write and the unused auto-stop warning (`HELPER-UPLOAD-018`, `HELPER-LAUNCH-005`, `HELPER-LAUNCH-006`); the Lambda live tail replaying the whole retained log history on open, about 50k lines observed, which reads as the Lambda firing several times a second but is noise with no data or cost effect (`APP-LOGS-TAIL-005`); a failed save leaving a changed health-check secret live, and cross-game checks run against an empty list after a failed read (`GAME-WRITE-004`, `GAME-WRITE-006`); history status filter using the DynamoDB reserved word `status` without an attribute name (`IAC-RUN-HIST-004`, not checked against live AWS); seeds under any volume but the first failing the apply (`IAC-PROGRAM-SEED-004`); no cancel channel or quit-time abort for IaC runs (`IAC-ENGINE-LIFE-006`, `-007`, `-009`, `IAC-RUN-DSTR-011`).

### Palworld ICMP (`add-icmp-ingress`)

Not an open `[ ]` gap. ICMP port declarations are implemented in code, docs and specs, and the governing specs are `[x]` (`GAME-PORT-009` to `GAME-PORT-012`, `DISCORD-MSG-004`): validator exemption and type range (`app/packages/shared/src/gameServerValidator.ts:656,811`), security-group rule (`app/packages/infra/src/securityGroups.ts:222-223`), exclusion from `portMappings` (`app/packages/infra/src/ecs.ts:279-283`), `firstPortByGame` skipping ICMP (`app/packages/infra/src/lambdas.ts:321`), and the wizard's ICMP row defaulting to type 8. What remains is operational: `openspec/changes/add-icmp-ingress/tasks.md` 5.3 (a live preview and apply, then a Palworld in-game browser join), after which the change is closed.

## Cross-segment duplicates

These pairs describe one behaviour from two leaves. Keep one ID as the owner and turn the other into a citation.

| Behaviour | Specs | Suggested owner |
|---|---|---|
| Health-check Lambda env vars | `RT-HEALTH-PROV-003`, `IAC-PROGRAM-LAMBDA-011`, `IAC-PROGRAM-RUNTIME-003` | `iac/program` (provisioning) |
| Health-check Lambda network path | `RT-HEALTH-PROV-004`, `IAC-PROGRAM-LAMBDA-012` | `iac/program` |
| Install region single-sourced | `IAC-ENGINE-REGION-001`, `CONFIG-SET-012`, `CONFIG-FORM-003`, `CONFIG-FORM-007`, `APP-WIZARD-REGLOCK-001` | `iac/engine` (decision 10 in the HLD); the others cite it |
| Quit-time abort of IaC runs | `IAC-ENGINE-LIFE-009`, `IAC-RUN-DSTR-011` | `iac/engine` |
| Audit-read error handling | `APP-DIAG-AUDR-004`, `APP-DIAG-SVC-002` | `APP-DIAG-SVC-002` |
| Partial-apply persistence | `IAC-RUN-STORE-007`, `IAC-RUN-STORE-008` | `IAC-RUN-STORE-007` |

## Decisions for the owner

- **Refactor wishes written as EARS (class d).** `RT-TASK-STATUS-008`, `RT-TASK-COST-010`, `RT-TASK-COST-012`, `GAME-IPC-005`, `DISCORD-SVC-005`, `IAC-RUN-APPR-006`, `IAC-RUN-DSTR-014`, `IAC-RUN-IPC-008`, `APP-UPDATE-IPC-009`, `APP-UPDATE-PKG-004`, `APP-UPDATE-PKG-005`, `APP-DIAG-LOG-008`, `APP-LOGS-GROUP-007`, `APP-IPC-CONTRACT-004`, `APP-IPC-SEAM-006`, `APP-SHELL-UI-005`, `APP-SHELL-UI-006` and `RT-HEALTH-PROV-005` describe deduplication, dead-code removal, conventions or test style with no runtime effect. Move each to its LLD's Work Required list, or keep them as EARS if the project wants structural requirements tracked as specs.
- **Spec conflicts with the design.** `CONFIG-RESTORE-004` contradicts the deployment-config LLD's Decisions table (unconditional restore; open question 2). `GAME-VALID-010` and `GAME-VALID-011` overlap (reject anything but exact lowercase vs treat case-insensitively or normalise on read); merge them into one reconciled spec, as `docs/arrows/game-server.md:176` already pairs them.
- **Policy calls blocking a gap.** `IAC-ENGINE-LOCK-010` (the spec and `docs/arrows/iac/engine.md:155` Must Fix 3 want lock classification on the stack-init `refresh`, but the `PulumiService.initializeStack` TSDoc at `PulumiService.ts:1097-1103` deliberately declines it because the wizard Retry is simpler; `docs/intent/iac/engine/engine-design.md:151` open question 3 is unresolved), `APP-SHELL-GATE-006` (should the setup gate fail open when setup state is unreadable), `APP-WIZARD-ROTKEY-005` (wire `rotateActiveCredentials` or drop it), `APP-IPC-STREAM-009` and `IAC-RUN-LOCK-010` wait on decisions recorded in their arrow docs.
- **Contested classification.** `APP-DIAG-AUDIT-004` is class c here, but a (implemented), c (defer) and d (spec stale) are each defensible. The spec's behaviour holds today through the upstream never-reject contract (`PulumiService.getStackOutputs`, `PulumiService.ts:972-1023`; `ConfigService.ts:153-167` still rethrows defensively), so the gap is only the unguarded read at `AuditService.ts:91`. The owner picks the class.

## Per-segment lists

Rows are in spec-file order.

### `run`

Specs: `docs/intent/iac/run/run-specs.md` · Arrow doc: `docs/arrows/iac/run.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `IAC-RUN-STORE-007` | b | high | putRecord omits partialApply (cloud-aws/src/AwsRunRecordStore.ts:188-212) and toRunRecord never reads it (:339-375); durable partial-apply marker from writePreflightMarker (RunRecordService.ts:463) is lost |
| `IAC-RUN-STORE-008` | d | - | approveRun spreads the stored record (RunRecordService.ts:643) and approves only kind 'plan' (:634), which never carries partialApply; the only loss path is the store round-trip, i.e. STORE-007 |
| `IAC-RUN-STORE-009` | b | low | Raw err still logged at RunRecordService.ts:339,354,385 and RunService.ts:244 |
| `IAC-RUN-LOCK-009` | b | med | RunService createRun/releaseRun/lock lookup use only getStackOutputs().runsTableName (RunService.ts:181,234,275) vs RunRecordService fallback resolvePreApplyRunsTableName (RunRecordService.ts:268-272); first apply has only in-memory lock |
| `IAC-RUN-LOCK-010` | c | - | iac.runs.get checks only in-memory lock (controllers/iac-runs.controller.ts:223-226). But after restart the run's engine process is dead, so "running" from a stale durable lock would be wrong; needs a decision (multi-instance only) |
| `IAC-RUN-LCLR-008` | b | low | No LockClearConfirmationGate.test.ts beside desktop-main/src/services/LockClearConfirmationGate.ts; test-coverage gap only |
| `IAC-RUN-APPR-006` | d | - | Renderer-local APPROVAL_WINDOW_MS/isApprovalExpired still at web/src/pages/iac.page.tsx:48-53 (shared already imported :6); pure dedupe, no behaviour, belongs in LLD Work Required |
| `IAC-RUN-PART-004` | b | med | Gate reads RunRecordPersister.getByRunId (PulumiService.ts:2037) which goes through the DynamoDB store that drops partialApply, so :2053 never fires and WrongKind (:2056) is thrown; retry still refused. Fixed by STORE-007 |
| `IAC-RUN-PART-005` | b | med | Badge code exists (web/src/components/run-history-row.component.tsx:46, iac-run-detail.page.tsx:202) but list/detail read DynamoDB records with partialApply dropped (AwsRunRecordStore.ts:339-375). Fixed by STORE-007 |
| `IAC-RUN-DSTR-011` | b | med | No shutdown hook for IaC runs (only helper quit hook, helper-quit-hook.ts:34); lock release relies on WebContents destroy abort racing exit, then 1h TTL. Overlaps IAC-ENGINE-LIFE-009 (same fix) |
| `IAC-RUN-DSTR-014` | d | - | Hand-rolled destroy token still at PulumiService.ts:2750 (mintDestroyConfirmationToken) beside LockClearConfirmationGate; pure dedupe/refactor, no behaviour change; belongs in LLD Work Required |
| `IAC-RUN-HIST-004` | b | med | Status-filtered query uses KeyConditionExpression 'status = :status' with no ExpressionAttributeNames (cloud-aws/src/AwsRunRecordStore.ts:305); STATUS is a DynamoDB reserved word, so real DynamoDB rejects it and the history status filter fails |
| `IAC-RUN-DETL-004` | b | low | Run detail resolves runId by scanning newest 200 records of iac.runs.list (web/src/pages/iac-run-detail.page.tsx:22,50); older runs render not-found |
| `IAC-RUN-RBK-010` | b | med | confirmRollback runs previewCore tagged plan (PulumiService.ts:3656), then iac.page.tsx:130-135 auto-submits a second tagged plan on arrival (nav from iac-history.page.tsx:48), so two plan runs per rollback |
| `IAC-RUN-IPC-008` | d | - | Three hand-rolled stream loops still in iac.controller.ts (plan :721, apply :825, destroy :986 handlers); pure dedupe refactor, no behaviour, belongs in LLD Work Required |
| `IAC-RUN-ITEST-005` | c | - | Integration harness replaces PulumiService with PulumiServiceStub by design (web/e2e/integration-specs/iac-apply-gates.spec.ts:35-41); gate math unit-tested in PulumiService.apply.test.ts; needs harness-redesign decision |
| `IAC-RUN-ITEST-007` | c | - | Same deliberate stub design (web/e2e/integration-specs/iac-destroy-token.spec.ts:16-17); token bookkeeping unit-tested in PulumiService.destroy.test.ts; low marginal value |

### `engine`

Specs: `docs/intent/iac/engine/engine-specs.md` · Arrow doc: `docs/arrows/iac/engine.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `IAC-ENGINE-PROV-010` | b | low | Only initializeStack emits a 'plugins' phase (desktop-main/src/services/PulumiService.ts:1159-1168); preview/apply/destroy take no onPhase, so a cold plugin download is indistinguishable from the operation |
| `IAC-ENGINE-PROV-012` | b | low | pruneOldVersions still skips every .staging-/.trash- entry unconditionally (desktop-main/src/services/PulumiEngineService.ts:630); disk debris only, no functional impact |
| `IAC-ENGINE-PFAIL-006` | b | low | Raw err/restoreErr objects still logged at PulumiEngineService.ts:254,451,458,537,581,626 (serialise to {}); logging-rule violation only |
| `IAC-ENGINE-PASS-008` | c | - | Dead end still documented, manual reset only (PulumiWorkspaceService.ts:566-582); hits only pre-derivation installs whose workDir was wiped but legacy passphrase survived; arrow lists as Nice-to-have |
| `IAC-ENGINE-REDACT-002` | b | med | destroy's push enqueues raw chunk (PulumiService.ts:3054-3056) vs preview/apply redacting (:1658,:2312); whether destroy display prints env values is inferred, hence med not high |
| `IAC-ENGINE-LOCK-010` | c | med | initializeStack refresh (PulumiService.ts:1175) has no classifyStackLockConflict; the TSDoc at :1097-1103 deliberately declines it in favour of the wizard Retry. Waiting on a decision (engine-design.md:151 open question 3 is unresolved); not class d because the LLD and arrows/iac/engine.md:155 Must Fix 3 back the spec. Orphaned refresh lock blocks wizard retry until resolved |
| `IAC-ENGINE-LIFE-004` | b | low | Message still "has been forcefully terminated" (services/PulumiCancellation.ts:119) and log "force-terminating" (:233) though escalation only abandons the promise |
| `IAC-ENGINE-LIFE-006` | b | med | No iac.plan/apply/destroy.cancel @MessagePattern (iac.controller.ts MessagePatterns at :640-1354); maps only feed a "future" cancel channel (:526,:537,:546); aborts fire only on WebContents destroy |
| `IAC-ENGINE-LIFE-007` | b | med | initializeStack(onPhase?) takes no signal (PulumiService.ts:1120); stack.refresh() runs bare at :1175, no runWithEscalatingCancellation (used at :1684,:2390,:3130) |
| `IAC-ENGINE-LIFE-009` | b | med | Only before-quit hook is installHelperQuitHook for file helpers (desktop-main/src/helper-quit-hook.ts:34, electron-entry.ts:232); nothing aborts PulumiService ops; no onApplicationShutdown in services |
| `IAC-ENGINE-INIT-005` | b | low | Post-engine getOrCreateStack failures classified 'operation' (PulumiService.ts:1336-1343) but wizard marks lastStartedPhase ('engine', already done) failed (web/.../stack-init-step.component.tsx:131,143); cosmetic |
| `IAC-ENGINE-OUT-003` | b | low | getStackOutputs catch still logs raw err (PulumiService.ts:1010-1011) |
| `IAC-ENGINE-REGION-001` | b | high | preview/apply pass parsed DeploymentConfig unchanged to createInfraProgram (PulumiService.ts:1611,1629; :2293); program uses config.awsRegion for the provider (infra/src/program.ts:177) - wrong-region / stack-replacing infra |
| `IAC-ENGINE-REGION-002` | b | med | EcsService.ts:72 uses outputs.awsRegion; cloud-provider.module.ts:109,131,181 prefer outputs?.awsRegion over getRegion(). Mostly moot once REGION-001 lands (outputs.awsRegion would equal wizard region) |
| `IAC-ENGINE-RT-003` | b | low | PulumiServiceStub (test-mocks/pulumi-mock.ts:67-193) has no mintLockClearConfirmationToken; IacController calls it at iac.controller.ts:967. Test-double drift only |

### `program`

Specs: `docs/intent/iac/program/program-specs.md` · Arrow doc: `docs/arrows/iac/program.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `IAC-PROGRAM-WS-006` | b | low | infra/tsconfig.json excludes only src/**/*.test.ts, so src/testing/fixtures.ts and pulumiMocks.ts compile into dist; private workspace, no runtime effect |
| `IAC-PROGRAM-EFS-004` | b | low | Key `${game}-${volume.name}` re-derived at infra/src/efs.ts:122, ecs.ts:224,229,262, lambdas.ts:739, program.ts:493; GAME_NAME_PATTERN allows '-' (shared/src/gameServerValidator.ts:51) so a-b/c vs a/b-c collides; unlikely names |
| `IAC-PROGRAM-TLS-002` | b | low | Caddy sidecar still uses floating tag 'caddy:2-alpine' (infra/src/ecs.ts:315) |
| `IAC-PROGRAM-TOKEN-002` | d | - | program.ts:169-174 rejects every empty hostedZoneName up front, so a zone is mandatory for all deploys; token check (ecs.ts:127-131) only matters for zone ".". Scenario predates mandatory zone; generic error is clearer |
| `IAC-PROGRAM-LAMBDA-011` | b | high | health-check env is only AWS_REGION_ (infra/src/lambdas.ts:568) but handler does requireEnv('ECS_CLUSTER') at module load (lambda/health-check/src/handler.ts:40); watchdog fails active (watchdog handler.ts:159-163) so games never idle-stop |
| `IAC-PROGRAM-LAMBDA-012` | b | high | health-check Lambda in public subnets (lambdas.ts:564-567), SG egress only to game ports (securityGroups.ts:295-320), no NAT/VPC endpoints in network.ts; can't reach ECS/Secrets Manager APIs; fail-active, so no idle stop |
| `IAC-PROGRAM-LAMBDA-016` | b | low | followup/interactions/watchdog/dns-updater Functions (lambdas.ts:431,462,576,643) have no dependsOn on their log groups (:459,:487,:604,:674); only health-check :571 and seeder :773 do |
| `IAC-PROGRAM-SECRET-005` | c | - | secrets.test.ts:159 only asserts ignoreChanges:['secretString']; a real write-redeploy-assert test needs a live-AWS harness that doesn't exist; ignoreChanges semantics are Pulumi's own |
| `IAC-PROGRAM-DNS-004` | b | low | Only ecs.ts:178 and lambdas.ts:406 strip dots; route53.ts:67 gets trimmed-not-stripped name; domainName output echoes raw config.hostedZoneName (program.ts:521). Trailing dot is DNS-valid, so mostly cosmetic |
| `IAC-PROGRAM-SEED-003` | b | low | triggers hash only file_seeds (infra/src/escapes.ts:261); container_path only in input (:262); Invocation defaults to CREATE_ONLY (no lifecycleScope set), so an input-only change does not re-invoke |
| `IAC-PROGRAM-SEED-004` | b | med | Seeder mounts volumes[0] only (lambdas.ts:738-739, escapes.ts:255); seed under any other volume makes the seeder throw (lambda/efs-seeder/src/handler.ts:35-37), failing apply; no validator catches it first |
| `IAC-PROGRAM-RUNTIME-003` | d | - | Runtime is nodejs24.x (lambdas.ts:59); the only failing part is the health-check init failure, which is exactly LAMBDA-011, so this duplicates it and closes when LAMBDA-011 does |
| `IAC-PROGRAM-RUNTIME-006` | b | low | buildLambda.mjs:13,16-17 still use cwd-relative 'dist'/'src/handler.ts' and :23 sourcemap:true; works under npm workspace scripts (cwd = package dir); build hygiene only |

### `task-and-dns`

Specs: `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md` · Arrow doc: `docs/arrows/game-runtime/task-and-dns.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `RT-TASK-LAUNCH-010` | b | high | CONFIRMED: withGameLock in-process only (cloud-aws/src/AwsCloudProvider.ts:330,427); followup runStart check-then-RunTask unguarded (lambda/followup/src/handler.ts:126-138), no clientToken -> duplicate paid tasks |
| `RT-TASK-LAUNCH-014` | b | low | desktop-main/src/services/EcsService.ts:332,355 still log { err } raw (also :380,:480) |
| `RT-TASK-STATUS-008` | d | - | pure dedupe/type-hygiene, not behaviour; shared/src/types.ts:61,71 exist but redeclared EcsService.ts:148,162, CostService.ts:14, hyveon-api.ts:100,110,126, api.service.ts:121,147 -> LLD Work Required |
| `RT-TASK-DNS-009` | b | med | lambda/update-dns/src/handler.ts:162 DELETE uses current DNS_TTL; Route53 DELETE needs exact TTL -> fails after dnsTtl change, swallowed :170-172, dangling A record to a released IP |
| `RT-TASK-DNS-010` | b | med | update-dns/src/handler.ts:240-243 STOPPED deletes whatever record exists, no IP ownership check (deleteDns :144-149) -> late/duplicate-task STOPPED removes live record |
| `RT-TASK-DNS-014` | b | low | update-dns/src/handler.ts:259 logs JSON.stringify(event) (full event, no secrets) |
| `RT-TASK-NOTIFY-005` | b | med | update-dns/src/handler.ts:240-243 STOPPED path never reads PENDING row -> Discord /server-start message stuck on 'starting' when task dies before RUNNING |
| `RT-TASK-NOTIFY-006` | b | low | update-dns/src/handler.ts:236 upsertDns un-guarded; throw skips notifyDiscordIfPending :237 (async retries may recover) |
| `RT-TASK-COST-010` | d | - | refactor wish: three copies (gameServerValidator.ts:432-436, CostService.ts:34-42, AwsCloudProvider.ts:313-317) share the same constants and give identical results -> Work Required |
| `RT-TASK-COST-011` | c | low | divergence only when TD lacks cpu/memory (EcsService.ts:375-376 1024/2048 vs AwsCloudProvider.ts:298-299); Fargate TDs always carry both; describe-failure path already consistent (costs.controller.ts:41) |
| `RT-TASK-COST-012` | d | - | structural/dead-code cleanup, not behaviour: getCostEstimate (shared/src/cloud.ts:55, AwsCloudProvider.ts:612) has no production caller -> Work Required |
| `RT-TASK-UI-004` | b | low | web/src/polling/game-status-provider.component.tsx:87 .catch(() => undefined); web/src/pages/costs.page.tsx:178 swallows -> silent empty estimates |
| `RT-TASK-UI-005` | b | low | game-status-provider.component.tsx:92 refreshGame maps existing entries only, never inserts |
| `RT-TASK-UI-010` | b | low | web/src/hooks/use-game-actions.hook.ts:91 Undo calls api.start without setBusy(true); desktop withGameLock prevents a duplicate task |

### `watchdog`

Specs: `docs/intent/game-runtime/watchdog/watchdog-specs.md` · Arrow doc: `docs/arrows/game-runtime/watchdog.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `RT-WATCHDOG-SCOPE-005` | c | low | real (lambda/watchdog/src/handler.ts:230 one DescribeTasks for all ARNs, >100 throws) but >100 RUNNING tasks in a personal game cluster is speculative |
| `RT-WATCHDOG-HC-006` | b | med | watchdog/src/handler.ts:233-246 sequential RequestResponse invokes; health-check timeout 30s (infra lambdas.ts:561) vs watchdog 60s (:577); latent until PROV-003/004 fixed |
| `RT-WATCHDOG-STOP-004` | b | med | watchdog/src/handler.ts:267-273 StopTask awaited with no try/catch -> one failure aborts run, later tasks unevaluated (stay running, cost) |
| `RT-WATCHDOG-DOC-002` | b | low | docs/docs/app/settings.md:250 still says DNS TTL applies to records 'the watchdog Lambda writes' |

### `health-check`

Specs: `docs/intent/game-runtime/health-check/health-check-specs.md` · Arrow doc: `docs/arrows/game-runtime/health-check.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `RT-HEALTH-HTTP-005` | b | med | lambda/health-check/src/handler.ts:173-179 fetch(`https://<privateIP>`) with default TLS: no SNI/servername, Caddy cert is for {game}.{zone} -> handshake fails -> fail-active, https games never idle-stop |
| `RT-HEALTH-PROV-003` | b | high | handler.ts:39 requireEnv('ECS_CLUSTER') at load; infra/src/lambdas.ts:568 env only AWS_REGION_ (pinned lambdas.test.ts:832) -> init crash, every health-checked game judged active forever |
| `RT-HEALTH-PROV-004` | b | high | infra/src/lambdas.ts:564-567 public subnets (Lambda ENIs get no public IP), no NAT/VPC endpoints in network.ts; SG egress only game ports (securityGroups.ts:437-452) -> ECS/SM calls cannot leave VPC |
| `RT-HEALTH-PROV-005` | d | - | test-process wish, not runtime behaviour; handler.test.ts:18 still masks it. Better expressed as an infra test pinning ECS_CLUSTER under PROV-003 (fix lambdas.test.ts:832) |
| `RT-HEALTH-REDACT-004` | b | low | web/src/components/add-game-wizard/health-check-fields.component.tsx:124 timeout FormField has no errors prop (only aria-invalid at :130); message not shown |

### `wizard-and-bootstrap`

Specs: `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md` · Arrow doc: `docs/arrows/operator-app/wizard-and-bootstrap.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-WIZARD-GATE-003` | b | low | wizard.controller.ts:169-170 falls back to isTestMode() (:220-222, HYVEON_TEST_MODE) in the production read path; only matters if env var set on operator machine |
| `APP-WIZARD-RECONF-007` | b | med | Paste submit writes unverified keys to creds.aws.hyveon-pasted immediately (use-aws-credentials-form.hook.ts:130, AwsProfileService.ts:189); cancel leaves a paste install's active creds replaced. Guided half (:441,:498) is benign |
| `APP-WIZARD-RECONF-008` | b | low | No "AWS changes remain" copy; Cancel button at first-run-wizard.component.tsx:444-447 just calls onCancel; grep finds no such text in web/src |
| `APP-WIZARD-RECONF-009` | b | high | use-reconfigure-answers.hook.ts:226-228 sends toStatePayload() for any opened credentials step; guided prefill leaves form empty (:151-152), so {profile:'',region:undefined} merges at wizard.controller.ts:206-207. Code reading, not reproduced |
| `APP-WIZARD-GSTEP-006` | b | low | use-guided-iam.hook.ts:244-250 sends template-written and awaiting-key-intake to template, or region screen when aws.region unset (written only at GuidedIamService.ts:498) |
| `APP-WIZARD-TMPL-009` | c | low | Nothing records principal (GuidedIamService.ts:190 leaves UserName; CreateAccessKey({}) at :439 uses caller); display-only, no consumer needs it; pairs with CREDS-010 |
| `APP-WIZARD-INTAKE-002` | c | low | GuidedIamService.ts:337 returns accountId; use-guided-iam.hook.ts:405-409 discards it; account ID already resolved on demand (CloudHealthService.ts:37, IamCheckService); display-only |
| `APP-WIZARD-ROTATE-008` | b | med | GuidedIamService.ts:441-445 overwrites creds.aws.hyveon-guided before verify; :485 deletes it on verify failure while aws.profile still names it, losing the working key on a Reconfigure re-run |
| `APP-WIZARD-KEYCH-002` | b | med | rotate throws SafeStorageUnavailableError (GuidedIamService.ts:424-426) with "pasted" wording (AwsProfileService.ts:51-52); use-guided-iam.hook.ts:376-380 shows verification-failed screen whose only action is Retry rotation |
| `APP-WIZARD-REGLOCK-001` | b | high | wizard.controller.ts:205-207 merges any aws.region; GuidedIamService.ts:498 stores input.region; no bootstrap-completed check anywhere (no region-lock code in web/src or desktop-main/src) |
| `APP-WIZARD-CREDS-010` | c | low | first-run-wizard.component.tsx:401-403 passes fixed label "AWS account (guided setup)"; depends on TMPL-009/INTAKE-002 recording a principal; cosmetic |
| `APP-WIZARD-CREDS-011` | b | low | wizard.controller.ts:174 returns store.get('aws') whole; latent: blob setters ElectronStoreService.ts:399,425 have no production caller. Cheap guard for a security invariant |
| `APP-WIZARD-ROTKEY-005` | c | med | AwsProfileService.ts:271 rotateActiveCredentials has no IPC/UI caller (grep); arrow Should 6 is a pending wire-or-drop decision; Reconfigure paste or guided re-run is the workaround |
| `APP-WIZARD-BOOT-004` | b | low | createS3Client/createDynamoDbClient outside try at BootstrapService.ts:127,190,319,415; resolveClientConfig throws at :713-714; renderer still shows failed via own catch |
| `APP-WIZARD-BOOT-012` | d | - | No operator project name exists at bootstrap (wizard.controller.ts:296-314 doc); projectName is locked after bootstrap by DeploymentConfigService.ts:152-175, so default derivation is the design. Edge: pre-existing config doc |
| `APP-WIZARD-IAMCHK-008` | b | low | IAM check runs only on button click: use-bootstrap-resources.hook.ts:226-240 runIamCheck, iam-check-panel.component.tsx:37-38; no auto-run after guided completion |
| `APP-WIZARD-IAMCHK-009` | b | med | No renderer reads blocking (IamCheckService.ts:93); advance gate is resource status only (use-bootstrap-resources.hook.ts:244-248); missing copy says paste into inline policy (iam-check-panel:55), wrong for guided |
| `APP-WIZARD-HEALTH-008` | d | - | Spec says always CFN, but profile/pasted installs have no stack; current IAM-console copy (cloud-health-section.component.tsx:82-84) is right for them. Make spec origin-conditional (CFN for guided only) |
| `APP-WIZARD-HEALTH-008` (split) | b | med | Remediation-copy gap that remains once the spec is rewritten: guided installs own HyveonDeployAll through a CloudFormation stack (resources/cloudformation/iam-bootstrap.yaml:31-34, GuidedIamService.ts:9,71-73,154-157) yet cloud-health-section.component.tsx:82-84 tells every operator to edit the policy in the IAM console, which drifts the stack from its template. Not counted separately in the totals |
| `APP-WIZARD-HEALTH-011` | b | low | writeFileSync unguarded at CloudHealthService.ts:203-206 (bridge normalises but no log); list half latent: one check, fully try-wrapped (:96-112), bare Promise.all at cloud-health.controller.ts:28-33 |
| `APP-WIZARD-CUSTODY-007` | b | med | SafeStorageService.ts:88-92 returns ciphertext when isAvailable() false; a later keychain outage hands base64 ciphertext to SDK/Pulumi as secret, giving opaque auth/passphrase errors |

### `diagnostics`

Specs: `docs/intent/operator-app/diagnostics/diagnostics-specs.md` · Arrow doc: `docs/arrows/operator-app/diagnostics.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-DIAG-LOG-008` | d | - | Computed twice (desktop-main/src/main.ts:28 and app.module.ts:113) but both yield userData/logs today; pure single-source refactor wish |
| `APP-DIAG-RERR-006` | c | low | Fallback gated on truthy this.state.error (web/src/components/error-boundary.component.tsx:56); only bites on throw null/0/'' which app code never does |
| `APP-DIAG-RERR-007` | b | low | Fallback still says 'Settings → Logs' (web/src/components/error-boundary.component.tsx:62) while log viewer lives under Diagnostics (pages/settings.page.tsx:384-387) |
| `APP-DIAG-RERR-008` | c | low | No install guard (web/src/lib/report-renderer-error.utils.ts:169-178) but only call site is main.tsx:8, once per session; speculative |
| `APP-DIAG-RERR-009` | c | low | Uses instanceof Error (report-renderer-error.utils.ts:175-176) vs isErrorLike at :4; renderer has no cross-realm rejection source today, speculative |
| `APP-DIAG-CONS-012` | b | low | flushInFlight cleared only in .then handlers (web/src/lib/report-renderer-error.utils.ts:126-137); a hung reportLog stops forwarding, contradicting doc :94-97 |
| `APP-DIAG-SVC-002` | b | low | AuditService.list returns store.listEntries uncaught (desktop-main/src/services/AuditService.ts:142); AwsAuditLogStore.listEntries has no catch (cloud-aws/src/AwsAuditLogStore.ts:139-150) |
| `APP-DIAG-SVC-003` | b | low | record's catch still logs raw { err } object (app/packages/desktop-main/src/services/AuditService.ts:113-118) instead of errMessage(err) |
| `APP-DIAG-PANEL-010` | b | med | On tail error the panel returns only <ErrorBanner> (web/src/components/DiagnosticsPanel.tsx:44-48), hiding ExportBundleButton (:74) exactly when an operator needs it |
| `APP-DIAG-BNDL-013` | b | low | Per-game getStatus failure message not scrubbed (desktop-main/src/services/DiagnosticsBundleService.ts:201) vs scrubSecrets for section errors (:151) |
| `APP-DIAG-SCRUB-003` | b | high | Verified by running the regex: '"botToken":"<24 chars>"' and '"apiKey": "..."' pass unredacted (desktop-main/src/services/diagnosticsLogScrubber.ts:15-16); bundle secret-leak path |
| `APP-DIAG-AUDIT-004` | c | low | getStackOutputs read outside try (desktop-main/src/services/AuditService.ts:91), but the behaviour holds today through the upstream never-reject contract (PulumiService.ts:972-1023; ConfigService.ts:153-167 still rethrows defensively); trivial move-into-try. Class left to the owner (Decisions: contested classification) |
| `APP-DIAG-AUDR-004` | d | - | Duplicates APP-DIAG-SVC-002: same gap at desktop-main/src/services/AuditService.ts:142; keep one ID |
| `APP-DIAG-AUDUI-008` | b | low | Subtitle still game-only (web/src/pages/audit.page.tsx:85); AuditEntry doc shared/src/audit.ts:28-33 and audit.controller.ts:8-11 say game config only though AuditAction includes plan/apply/destroy |

### `infra-logs`

Specs: `docs/intent/operator-app/infra-logs/infra-logs-specs.md` · Arrow doc: `docs/arrows/operator-app/infra-logs.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-LOGS-GROUP-007` | d | - | Both declared by hand (shared/src/lambdaFunctionKey.ts:9-14,21-27) but a derive-from-one-declaration refactor, not behaviour; Work Required item |
| `APP-LOGS-SNAP-005` | c | low | getRecentLogs passes no notFound hook (desktop-main/src/services/LogsService.ts:279-290) but /ecs/{game}-server is Pulumi-provisioned per game (infra/src/ecs.ts:194-197), so rarely hit |
| `APP-LOGS-SNAP-006` | b | low | Snapshot uses ${e.message ?? ''} (desktop-main/src/services/LogsService.ts:328) vs paging raw ${e.message} (:519); only differs for message-less events |
| `APP-LOGS-PAGE-008` | b | low | Four identical catches re-log at error (desktop-main/src/controllers/logs.controller.ts:96,120,258,282) what LogsService already warned (LogsService.ts:362,401,668,705) |
| `APP-LOGS-TAIL-005` | b | med | streamLambdaLogs starts with startTime undefined (desktop-main/src/services/LogsService.ts:745,751) so first poll replays whole retained group; observed ~50k-line replay; med by the impact definitions (misleading noise with a workaround, no failure, data loss or cost) |
| `APP-LOGS-TAIL-007` | b | low | FilterLogEventsCommand sent with no abortSignal (desktop-main/src/services/LogsService.ts:750-752) and plain setTimeout sleep (:776) |
| `APP-LOGS-TAIL-009` | b | low | Poll failure yields '[stream error]' with no logger call (desktop-main/src/services/LogsService.ts:772-773) |
| `APP-LOGS-TAIL-011` | b | low | streamLogs yields chunk.message only (desktop-main/src/services/LogsService.ts:206-207); LogChunk = string (desktop-preload/src/hyveon-api.ts:157); UI does not render timestamps today |
| `APP-LOGS-ENGINE-016` | b | low | loadNewer never reads page.hasMore (web/src/hooks/use-log-tail.hook.ts:478-502) and handleScroll re-fires getNewer on every bottom scroll while historical (:533-535), so the tail cannot report that no newer history remains. A separate atNewest-style flag (cf. atOldest :206,:412) meets the spec without touching hasNewer / Jump to latest (:110,:616) |
| `APP-LOGS-ENGINE-017` | b | low | ageLabel = formatAge(now - oldest.receivedAt) (web/src/hooks/use-log-tail.hook.ts:370-371) though snapshot lines carry timestamp |
| `APP-LOGS-UI-008` | b | low | LiveBadge takes only paused (web/src/components/live-badge.component.tsx:19); buffered count shown only when paused (log-tail-view.component.tsx:213) though historical also buffers |
| `APP-LOGS-UI-009` | c | low | Desktop pair stays mounted under hidden md:contents (web/src/components/log-tail-view.component.tsx:150-153) but display:none, no ids, never both visible; harmless |
| `APP-LOGS-RENDER-003` | b | low | Rows keyed by index (web/src/components/log-line-display.component.tsx:117); list receives text only (log-tail-view.component.tsx:201), so no stable id passed down |

### `app-update-and-release`

Specs: `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md` · Arrow doc: `docs/arrows/operator-app/app-update-and-release.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-UPDATE-FALL-007` | c | low | Still per_page=10, no pagination (app/packages/desktop-main/src/updater-fallback.ts:10); needs 10 consecutive feedless releases while DRAFT-003 verifies feeds, so speculative |
| `APP-UPDATE-DL-005` | b | low | Still string-compares rejection text NO_PRIOR_CHECK_MESSAGE='Please check update first' (app/packages/desktop-main/src/updater.ts:178,225); breaks only on an electron-updater wording change |
| `APP-UPDATE-DL-009` | b | low | installDownloadedUpdate calls quitAndInstall unconditionally and returns ok:true (app/packages/desktop-main/src/updater.ts:256-259); UI only offers install after download, masking it |
| `APP-UPDATE-IPC-009` | d | - | Real dup (desktop-main/src/controllers/iac-settings.controller.ts:35,38 vs desktop-preload/src/preload.ts:158,161) but a pure dedupe wish, not behaviour; belongs in LLD Work Required |
| `APP-UPDATE-PKG-004` | d | - | Real dup (electron-builder.yml:18, updater-fallback.ts:5,8, web/src/pages/settings.page.tsx:80) but single-source refactor, not behaviour; move to Work Required |
| `APP-UPDATE-PKG-005` | d | - | Matrix still duplicated (.github/workflows/release.yml:337-364 vs package.yml:37-64, keep-in-sync comment :331-333) but a CI dedupe wish, not behaviour |
| `APP-UPDATE-PKG-006` | b | low | .github/actions/build-package/action.yml:18 still installs @tailwindcss/oxide@4.3.0; package-lock.json:7054 resolves 4.3.3 |
| `APP-UPDATE-PKG-008` | b | med | No guard: app/test/packaging-manifest-pins.test.ts:62-93 checks pins only; electron-builder.yml:40-48 admits new transitive deps aren't picked up; miss = packaged app crash |
| `APP-UPDATE-DRAFT-004` | b | med | Draft created at .github/actions/publish-release/action.yml:24-33 before verify step :39-61 which exits 1 with no cleanup; comment :22-23 claims the opposite |

### `desktop-shell`

Specs: `docs/intent/operator-app/desktop-shell/desktop-shell-specs.md` · Arrow doc: `docs/arrows/operator-app/desktop-shell.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-SHELL-BOOT-008` | b | med | Still console.error only (app/packages/desktop-main/src/electron-entry.ts:51,204,229,250); no logger import in file, so packaged start-up failures leave no log line |
| `APP-SHELL-CHROME-014` | d | - | Skip link sets WebkitAppRegion no-drag unconditionally (web/src/components/app-layout.component.tsx:52) but no-drag is inert outside Electron; no observable behaviour to require |
| `APP-SHELL-GATE-006` | c | med | getState() rejection silently mapped to wizardCompleted=true with no operator signal (app/packages/web/src/app.component.tsx:53-55); class c because the first-run gate's failure policy is an open decision (arrow Must Fix 2) and the spec is conditional on fail-open staying. Buildable as written under the current fail-open behaviour if the owner confirms it |
| `APP-SHELL-NAV-009` | b | low | Sidebar and drawer still read 'Game Servers' (web/src/components/app-layout.component.tsx:82,113) vs top bar 'Hyveon' (app-topbar.component.tsx:115) |
| `APP-SHELL-TOP-002` | b | low | api.env() rejection -> console.error and pill falls back to 'local' (web/src/components/app-layout.component.tsx:30,33-35) |
| `APP-SHELL-UI-004` | b | low | index.css @theme (web/src/index.css:5-44) lacks accent/background/muted; hover:bg-accent at window-chrome.component.tsx:97,105, app-layout:119, topbar:110; bg-muted topbar:61 |
| `APP-SHELL-UI-005` | d | - | hover:text-red-400 hover:bg-red-500/10 still at web/src/components/window-chrome.component.tsx:117; token-convention rule, visually ~identical to --color-red #f87171, not behaviour |
| `APP-SHELL-UI-006` | d | - | DESIGN.md:23 still #8b90a5 vs index.css:21 #9398ad and omits --color-card; doc-sync item, not a behavioural requirement |

### `ipc-bridge`

Specs: `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md` · Arrow doc: `docs/arrows/operator-app/ipc-bridge.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `APP-IPC-CALL-010` | b | low | ipc-main-bridge.ts:28-38 lists 9 patterns; ipc-main-bridge.test.ts:127-198 tests only 5; logs.lambda.stream, iac.apply, iac.destroy, iac.runs.logs still untested |
| `APP-IPC-ERR-004` | b | med | validation.ts:21-24 throws object-body BadRequestException (Nest message = "Bad Request Exception"); rpc-error-message.filter.ts:36 + shared errors.ts:85 read only .message. Also hits discord.controller.ts:75,125 |
| `APP-IPC-ERR-005` | b | low | iac.controller.ts:579-617, logs.controller.ts:46-53, iac-runs.controller.ts:185-188, iac-settings.controller.ts:119-122 call handler directly; no catch, log or plain-Error normalisation |
| `APP-IPC-ERR-007` | b | low | String(err) still at logs.controller.ts:191, iac-runs.controller.ts:301 and also iac.controller.ts:792,923,1070 (plan/apply/destroy end messages) |
| `APP-IPC-STREAM-009` | c | low | stream-bridge.ts:162-165,204-208 shared style only stops local drain; blocked on arrow decision (Should 4): tearing down stack-init/download is undesirable, runs.logs tail ends with the run |
| `APP-IPC-STREAM-011` | b | low | streaming-handle-roundtrip.spec.ts:44,87,138,193 all register __test.mock, short-circuited at stream-bridge.ts:105-111; integration-specs use fake ctx, not the preload |
| `APP-IPC-STREAM-013` | c | low | stream-bridge.ts:214-232 attaches after ack, but both sources await I/O first (LogsService.ts:206,742); window is microtask-only, unreproduced; speculative |
| `APP-IPC-CONTRACT-003` | b | low | hyveon-api.ts:289-292 GameServerPort lacks visibility (shared gameServerConfig.ts:50); :418-432 GameServer hand-mirrored with "keep in sync" comment; compile-time drift only |
| `APP-IPC-CONTRACT-004` | d | - | Wordings differ (api.service.ts:260-261 vs bridge.utils.ts:2,8) but only reachable outside Electron; string dedupe belongs in Work Required (Nice 10), not EARS |
| `APP-IPC-SEAM-006` | d | - | test-mock-registry.ts:61-98 has no consumer besides its own test (package.json:15-17 export only); dead-code removal, not behaviour; keep as Work Required (Nice 8) |
| `APP-IPC-SEAM-007` | c | low | desktop-preload/tsconfig.json includes src/**/* excludes only dist,node_modules; no shipped effect since electron.vite.config.ts:124-136 bundles preload from src and builder ships out/** |

### `game-server`

Specs: `docs/intent/game-server/game-server-specs.md` · Arrow doc: `docs/arrows/game-server.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `GAME-VALID-010` | b | low | shared/src/gameServerValidator.ts:78 protocol: z.string(); tcp/udp check only for https games (:759); wizard dropdown limits UI, hand-edited bad value fails at apply |
| `GAME-VALID-011` | d | - | conflicts with GAME-VALID-010 (reject non-exact-lowercase makes case-insensitive compares moot); exact compares remain at :759,:771,:1008, gameServerPorts.ts:63. Pick one spec |
| `GAME-TOKEN-008` | b | low | infra/src/envTokenWrapper.ts:71-91 30 x (wget -T5 + curl -m5 + sleep 2) = ~6 min worst case vs ~60s budget; only when IP echo unreachable |
| `GAME-HOST-016` | b | low | web/src/components/add-game-wizard/review-step.component.tsx:123-169 env vars + pinned hostname inside 'Storage' SectionCard; owned by environment-step (cosmetic) |
| `GAME-WRITE-004` | b | med | desktop-main/src/services/GamesWriteService.ts:150,225 secret upsert/delete (:488-517) before config write (:159,:235), no rollback -> failed save leaves live check creds changed/deleted |
| `GAME-WRITE-005` | b | low | GamesWriteService.ts:532 throws plain Error out of createGame/updateGame; controller returns it verbatim (games.controller.ts:137-152); ipc bridge backstop only |
| `GAME-WRITE-006` | b | med | DeploymentConfigService.ts:324-336 returns+negatively caches [] on read failure; GamesWriteService.ts:123,207 use as siblings -> vacuous cross-game checks; update gets before=null, dropping existing auth |
| `GAME-WRITE-010` | b | low | GamesWriteService.ts:240-241,285-286 map every GameServerEntryError reason to not_found (documented as intentional at :190-199) |
| `GAME-WRITE-012` | b | low | GamesWriteService.ts:390 errorResult logs { err } raw |
| `GAME-IPC-005` | d | - | type-only mirror drift (desktop-preload/src/hyveon-api.ts:418,650 lack webPort/command); web uses shared/own types (api.service.ts:169,174), no runtime effect -> dedupe Work Required |
| `GAME-IPC-007` | b | low | add-game-wizard.component.tsx:158-160 sets [] on failure; game-detail.page.tsx:119-121 -> 'not found'; server-side validation still guards writes |
| `GAME-WIZ-005` | b | low | add-game-wizard.component.tsx:279-282 jumps to first issue's step only; no per-step error markers |
| `GAME-DRAFT-008` | b | low | web/src/pages/games.page.tsx:118-121 no try/catch; called as void at :165 -> unhandled rejection, banner stays, no message |

### `deployment-config`

Specs: `docs/intent/deployment-config/deployment-config-specs.md` · Arrow doc: `docs/arrows/deployment-config.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `CONFIG-STORE-007` | c | - | Still true (app/packages/cloud-aws/src/AwsRemoteFileStore.ts:107 returns undefined on no body/ETag) but S3 GetObject 200 always carries both; theoretical only |
| `CONFIG-RESTORE-004` | c | med | Real race (app/packages/desktop-main/src/services/DeploymentConfigService.ts:388-394 unconditional put) but LLD Decisions table (design.md:162) chose unconditional and Open Q2 (:189) is undecided; resolve decision first |
| `CONFIG-SET-003` | b | low | Missing object is a plain Error from fetchRawConfig; iac-settings.controller.ts:143-144 maps it to generic code 'error' |
| `CONFIG-SET-006` | b | low | iac-settings.controller.ts:173 re-read inside same try; a throw falls to :200-201 returning code 'error' after a successful write |
| `CONFIG-SET-009` | b | low | iac-settings.controller.ts:143 and :200 log raw { err }; OptimisticLockError branch :187-195 logs nothing |
| `CONFIG-SET-012` | b | high | app/packages/shared/src/deploymentSettingsWrite.ts:58 accepts any non-empty awsRegion; PulumiService.ts:1629 and :2293 still feed the stored awsRegion to the program (:1039 is projectStackOutputs, not a program input) |
| `CONFIG-FORM-003` | b | high | app/packages/web/src/hooks/use-deployment-settings.hook.ts:155 draftToPatch still sends awsRegion |
| `CONFIG-FORM-007` | b | high | deployment-settings-form.component.tsx:92-94 editable free-text AWS region Input; edit replaces whole stack incl EFS saves on next apply |
| `CONFIG-DRIFT-007` | b | med | DriftService.ts:210 uses getGameServers (caches [] on failure, DeploymentConfigService.ts:334); :150-154 emits pending_delete for all; apply path unaffected |
| `CONFIG-DRIFT-008` | b | med | DriftService.ts:13-20 compares only image/cpu/memory/ports/volumes; shared/src/drift.ts:26 closed set; banner copy has no scope note |
| `CONFIG-RBDIFF-002` | b | low | shared/src/deploymentConfig.ts:399-414 hand list typed DeploymentConfigScalarField[] (no completeness check); test :320 hardcodes the same list |

### `discord-bot`

Specs: `docs/intent/discord-bot/discord-bot-specs.md` · Arrow doc: `docs/arrows/discord-bot.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `DISCORD-SVC-005` | d | - | Dedupe/refactor wish (Should Fix 6): endpoint URL works; duplicate outputs infra/src/program.ts:530-531, two receivers still exist. Belongs in LLD Work Required not EARS |
| `DISCORD-AUTH-007` | c | low | Not implemented (lambda/interactions/src/handler.ts:278-289 signature only); Discord does not require it, replay needs captured TLS traffic; defence-in-depth |
| `DISCORD-CMD-009` | b | med | lambda/interactions/src/handler.ts:256-264 awaits an InvocationType Event invoke with no bound (called at :205,:217,:234), so slow Lambda API latency can exceed Discord's 3s budget. Bounding the invoke with an abort/timeout meets the budget, at the cost of a dropped followup (the command stays on "thinking") when the bound fires; the invoke must still be awaited because Lambda freezes after return |
| `DISCORD-RUN-010` | b | med | lambda/followup/src/handler.ts:249 config read outside try; throw leaves interaction stuck on thinking (async retries re-run). PATCH-fail part (:281) cannot itself reply |
| `DISCORD-RUN-011` | b | med | lambda/followup/src/handler.ts:277 console.error logs whole event incl interactionToken (valid 15 min) to CloudWatch |
| `DISCORD-RUN-012` | b | low | String(err) in Discord replies at lambda/followup/src/handler.ts:117, :151, :166 (leaks ARNs/SDK text to guild users) |
| `DISCORD-RUN-014` | b | med | shared/src/discord/patchOriginal.ts:24 fetch not wrapped; network reject throws out of followup/update-dns despite TSDoc :10-12 saying it swallows |
| `DISCORD-DESK-004` | b | high | DiscordConfigService.ts:130-135 caches emptyConfig() on read failure; mutators :300-417 load() then save() overwrite real CONFIG#discord row (data loss) |
| `DISCORD-IPC-006` | b | low | discord.controller.ts:202-209, :221-224 reject only unsafe keys (DiscordConfigService.ts:386, :413); unknown game writes an orphan entry, contrary to TSDoc :181 |
| `DISCORD-UI-008` | b | med | load() swallows missing-table into empty config (DiscordConfigService.ts:126-135) so page shows blank editable config; discord.page.tsx:45-51 labels any loadError not deployed |
| `DISCORD-UI-009` | b | low | credentials-section.component.tsx:47-53 calls onSave without awaiting then clears token/publicKey inputs |
| `DISCORD-UI-010` | b | low | credentials-section.component.tsx:59-60 void clipboard.writeText then markCopied unconditionally |

### `helper-task`

Specs: `docs/intent/helper-task/helper-task-specs.md` · Arrow doc: `docs/arrows/helper-task.md`

| Spec | Class | Impact | Evidence |
|---|---|---|---|
| `HELPER-UPLOAD-013` | c | low | Real (FolderUploadService.ts:189-193 cancel checks only active; preparing :231-255) but renderer exposes no cancel until a run snapshot exists (folder-upload-card.component.tsx:119,161) |
| `HELPER-UPLOAD-018` | b | med | Server checked once in prepare (FolderUploadService.ts:303-308); execute/uploadAll :357-380 never re-check; Discord /server-start can start mid-write |
| `HELPER-REACH-007` | b | low | Narrower than noted: registerTaskDefinition returns null and is cleaned (FileManagerService.ts:455-457); only generateEphemeralCert :400 (in-process) can throw after ingress :381 |
| `HELPER-LAUNCH-005` | b | med | scheduleWarning returned at FileManagerService.ts:494; only consumer path volumeFiles/HelperSessionRegistry.ts:442 ignores it; upload proceeds with no auto-stop |
| `HELPER-LAUNCH-006` | b | med | grep finds no consumer of scheduleWarning in desktop-main or web; HelperSessionSnapshot (volumeFiles/HelperSessionRegistry.ts:26) has no field; browse helper may run indefinitely |
| `HELPER-IPC-004` | b | low | FolderUploadStartResult is {started:false;error:string} (shared/src/folderUpload/types.ts:120); renderer regex /already open/i card:25 and VERIFICATION_PREFIX meter:37 |
| `HELPER-IPC-005` | b | low | FileManagerService.ts:569 returns { message: String(err) } in stop() |
| `HELPER-SEED-005` | b | low | lambda/efs-seeder/src/handler.ts:89 writeFileSync mode applies only on create; no chmodSync on overwrite |
| `HELPER-SEED-006` | c | low | Event built by infra program only; missing seeds/container_path already throw TypeError before any write (handler.ts:62, :29); game is log-only |
| `HELPER-RSV-005` | b | low | folderUpload/uploadEngine.ts:256 overwrite:true with no UploadReservations; reservations used only in volumeFiles/VolumeFilesService.ts and transferOps.ts |
