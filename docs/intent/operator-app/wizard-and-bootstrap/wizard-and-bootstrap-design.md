---
parent: operator-app
prefix: APP-WIZARD
---

# First-Run Wizard and AWS Bootstrap

## Context and Design Philosophy

A fresh Hyveon install has no AWS account wired to it, no Pulumi state bucket, no configuration bucket, no `deployment-config.json` and no runs table, and nothing else in the app can work until all of those exist.
This leaf is the path from that empty state to a credentialed, bootstrapped account: the five-step first-run wizard (`WIZARD_STEPS = ['pick-cloud', 'guided-iam', 'credentials', 'bootstrap', 'stack-init']`, `app/packages/shared/src/wizardSteps.ts:9`), the same shell reused as Reconfigure from Settings (`first-run-wizard.component.tsx:59,69`), and the Settings-page Cloud Health checklist (`cloud-health.controller.ts:21`).
It also owns credential custody, which is the durable product of the wizard: the typed electron-store (`ElectronStoreService.ts:191-290,304`), OS-keychain encryption (`SafeStorageService.ts:24`), the single credential resolver every AWS caller uses (`awsCredentialSource.ts:93,177`), and the signature-keyed client caches (`desktop-main/src/services/awsClientCache.ts:35`, `cloud-aws/src/cachedClient.ts:35`).

Guiding principles visible in the code:

- **Main-process SDK only.** Every AWS call in this leaf runs in `desktop-main`; the renderer reaches it only through `wizard.*` and `cloudHealth.*` request/response IPC channels (`wizard.controller.ts:153-429`, `cloud-health.controller.ts:25-55`), and `@aws-sdk/*` imports are banned in `@hyveon/web` by lint (`app/eslint.config.js:114-198`, owned outside this leaf).
- **Idempotent, per-resource steps.** Each bootstrap resource is its own service method and IPC call returning `created | exists | failed` (`BootstrapService.ts:69-75`), so the UI renders per-resource status and retries one resource at a time (archived `add-first-run-wizard/design.md` Decision 6).
- **Never persist a secret in plaintext.** Every writer of pasted or guided credentials refuses to run when the keychain is unavailable (`AwsProfileService.ts:183,270`, `GuidedIamService.ts:416-418`).
- **Resumable, but only non-secret progress.** The resumable progress file records step and guided-IAM sub-state plus a `hasBootstrapKey` boolean, never the key itself (`FirstRunWizardService.ts:33-41,110-116`).

CLAUDE.md invariants that live here: "Secrets never reach the renderer" (redacted shapes; see the deferred question on `wizard.state.get` below), "The desktop app has no HTTP transport" (all channels are `@MessagePattern`), and the AWS-SDK-free `@hyveon/shared` barrel (`iamPolicy.ts`, `wizardSteps.ts` and `awsRegions.ts` are pure data and generators).

What this leaf deliberately does not own:

- The wizard's last step, `stack-init-step.component.tsx`, and `PulumiService.initializeStack` belong to `iac/engine`; this leaf only calls `wizard.complete` after it.
- The first-run gate in `web/src/app.component.tsx:37-60` and the Settings page that hosts Reconfigure and Cloud Health belong to `operator-app/desktop-shell`.
- The preload facade (`desktop-preload/src/hyveon-api.ts`, `window.hyveon.wizard.*`, `cloudHealth.*`) and `desktop-main/src/env.ts` belong to `operator-app/ipc-bridge`.
- `DEPLOYMENT_CONFIG_DEFAULTS`, `withDeploymentConfigDefaults` and `resolveRunsTableName` belong to `deployment-config`; this leaf only seeds the first document.
- The `addGameWizardDraft` and `folderUpload` store slots are declared here (`ElectronStoreService.ts:284,289`) but used by `game-server` and `helper-task`.

## Wizard Lifecycle and State

### Where state lives

Wizard state is split across two stores by lifetime (archived `add-first-run-wizard/design.md` Decision 4):

| Store | Contents | Owner |
|---|---|---|
| `userData/wizard-state.json` | `{ step, guidedIam?: { subState, hasBootstrapKey } }` | `FirstRunWizardService` (`FirstRunWizardService.ts:33-41,211-213`) |
| electron-store `wizardCompleted` | gate flag | `WizardController.readState` / `complete` / `reset` |
| electron-store `activeCloud` | `'aws'` (only value accepted, `wizard.controller.ts:194-199`) | pick-cloud step |
| electron-store `aws` | `{ region?, profile?, accessKeyId?, secretAccessKey? }` (`ElectronStoreService.ts:204-209`) | credentials / guided-IAM steps |
| electron-store `bootstrap` | `{ stateBucket, configurationBucket }` | bootstrap step |
| electron-store `creds.aws[<profile>]` | encrypted `PastedAwsCredentials` (`ElectronStoreService.ts:23-28,230`) | `AwsProfileService`, `GuidedIamService` |

`getProgress()` returns `{ step: 'pick-cloud' }` when the file is missing, unparseable or names an unknown step, and drops a guided-IAM sub-state that fails validation (`FirstRunWizardService.ts:43-44,68-80`).
`recordStep()` rejects unknown steps and sub-states and deliberately never echoes `hasBootstrapKey` into an error message (`:103-116`).

Divergence: `openspec/specs/wizard-flow/spec.md:25` names `userData/wizard-state.json`, but its own scenario at `:34` and the archived design's Decision 4 say `userData/state.json`; code matches `:25`.

### Gate and completion

`wizard.state.get` returns `wizardCompleted`, `activeCloud`, `aws` and `bootstrap` (`wizard.controller.ts:166-175`).
When `wizardCompleted` has never been written, the value falls back to `isTestMode()`, i.e. `HYVEON_TEST_MODE === '1'` (`:168,217-219`), so a test-mode process boots straight past the wizard; this check lives in the production read path and duplicates `desktop-main/src/env.ts:12`.
The renderer gate (desktop-shell's `app.component.tsx:40-54`) treats a missing bridge or a rejected `getState()` as `wizardCompleted = true`, so the gate fails open.

`wizard.complete` sets the flag and returns state (`wizard.controller.ts:347-351`).
`wizard.reset` (`:362-366`) calls `FirstRunWizardService.reset()`, which removes the progress file and clears `wizardCompleted`, `activeCloud`, `aws`, `bootstrap` and `creds` but deliberately leaves `pulumi.*` because the legacy passphrase may be the only key to an existing stack's encrypted state (`FirstRunWizardService.ts:180-208`); it also leaves `addGameWizardDraft` and `folderUpload`, without a stated reason.

### First-run vs Reconfigure

`FirstRunWizard` takes `mode: 'first-run' | 'reconfigure'` (`first-run-wizard.component.tsx:59,69`).
In first-run mode answers are written as each step is left: `activeCloud` on leaving pick-cloud, the credentials payload on leaving credentials unless guided credentials already satisfied the step, and bootstrap names best-effort on leaving bootstrap (`:296-320`).
In Reconfigure mode, steps are pre-marked complete from stored state and collapse (`:231`), the sidebar is hidden (`:332`), and edits buffer in component state until `commitReconfigureAnswers` writes them in one `wizard.state.save` on finish (`use-reconfigure-answers.hook.ts:215-230`, wired at `first-run-wizard.component.tsx:426`).
`commitReconfigureAnswers` sends `credentials.toStatePayload()` whenever the credentials step is not pre-completed (`use-reconfigure-answers.hook.ts:222-224`) without the `!guidedCredentials` guard the first-run path has (`first-run-wizard.component.tsx:307`) `[inferred]` risk, not reproduced.

Step advancement on the bootstrap step requires every resource `created` or `exists` (`first-run-wizard.component.tsx:237-238`, `use-bootstrap-resources.hook.ts:241-246`); it does not consider the IAM check (see below).

## Credential Acquisition Paths

Three paths end in the same place: `aws.profile` and `aws.region` set in electron-store, and, for the two non-profile paths, an encrypted `creds.aws[<profile>]` entry.

| Path | Profile name | Stored material | Entry point |
|---|---|---|---|
| Existing `~/.aws` profile | operator's profile name | none; SDK uses `fromIni({ profile })` | `AwsProfileService.listProfiles` (`AwsProfileService.ts:152`), `wizard.aws.listProfiles` |
| Pasted keys | `hyveon-pasted` by default (`AwsProfileService.ts:28,187`) | encrypted key pair | `savePastedCredentials`, `wizard.aws.saveCredentials` (`wizard.controller.ts:233-246`) |
| Guided IAM | `hyveon-guided` (`GuidedIamService.ts:94`) | encrypted rotated key pair | `wizard.guidedIam.*` (`wizard.controller.ts:374-429`) |

### Guided IAM provisioning

Guided IAM replaces manual IAM console work with a reviewable CloudFormation template handed to the operator's existing console session (archived `add-one-click-aws-bootstrap/design.md` Decision 1).

1. **Template.** `prepareTemplate` reads `resources/cloudformation/iam-bootstrap.yaml`, substitutes `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` and `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` with `generateHyveonDeployAllPolicy()` and `generateHyveonSelfRotatePolicy()` (`shared/src/iamPolicy.ts:200,243`), and writes the result under `userData` (`GuidedIamService.ts:200-215`). Substitution uses single-occurrence `String.replace` (`:210-212`). The template creates the `HyveonDeployAll` and `HyveonSelfRotate` managed policies, an IAM user, and an access key with `DeletionPolicy: RetainExceptOnCreate`, and publishes `AccessKeyId` and `SecretAccessKey` as stack outputs (`iam-bootstrap.yaml:30-89`).
2. **Console handoff.** `openConsole` opens `https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create` (`GuidedIamService.ts:242,275`); the operator uploads the file (Decision 2: no hosted template).
3. **Intake.** The operator pastes the stack-output key into the renderer; `intakeBootstrapKey` validates it with `sts:GetCallerIdentity` and rethrows the raw SDK error so the UI can explain it (`GuidedIamService.ts:325-343`). The bootstrap key is held in renderer React state (`use-guided-iam.hook.ts:146-147`) and cleared after submit (`:409`).
4. **Mandatory rotation** (`rotate`, `GuidedIamService.ts:414-514`), in a documented load-bearing order: keychain gate; `iam:CreateAccessKey` with the bootstrap key; stage the new pair as `hyveon-guided` without activating it; verify with `sts:GetCallerIdentity` through `verifyAccessKeyWithRetry` (delays `[1000, 2000, 4000, 8000, 8000]`, six attempts, `verifyAccessKeyWithRetry.ts:12,46-78`); on failure, best-effort delete the new key and the staged entry and return `verification-failed`; on success set `aws.profile = 'hyveon-guided'`; finally delete the bootstrap key with the new credentials, returning `delete-failed` plus the IAM security-credentials console URL if that fails (`:500-506,661`).
5. **Manual revoke.** `revokeBootstrapKey` (`GuidedIamService.ts:567`) backs the delete-failed screen's retry.

Sub-state progresses `not-started → template-written → awaiting-key-intake → rotation-pending → complete` (`FirstRunWizardService.ts:21`, persisted from `use-guided-iam.hook.ts:278,326,358,410,442`).
A `rotation-pending` resume lands back on intake because the bootstrap key itself is never persisted (`use-guided-iam.hook.ts:201-240`).

Divergence: the archived design specifies `DeletionPolicy: Retain` (Decision 3), the template uses `RetainExceptOnCreate` with an in-file rationale (`iam-bootstrap.yaml:66-73`).

### Region selection

The guided path's region dropdown reads the committed, generated `shared/src/awsRegions.ts` (regenerated by `build/generate-aws-regions.mjs`), with a manual-entry fallback (`guided-region-selection` spec; archived `first-run-wizard-region-dropdown/design.md` D1, D2).
The data set includes `eusc-de-east-1`, "AWS European Sovereign Cloud (Germany)" (`awsRegions.ts:36`); the spec excludes only the `us-gov-` and `cn-` prefixes (`guided-region-selection/spec.md:13-24`), so this is spec-compliant but is a separate partition where commercial credentials do not authenticate.

## Bootstrap Resources and IAM Check

### Resources

`BootstrapService` (`BootstrapService.ts:105`) creates everything with the SDK directly, before any Pulumi stack exists:

| Channel | Method | Resource and settings |
|---|---|---|
| `wizard.bootstrap.stateBucket` | `ensureStateBucket` (`:123`) | Pulumi state bucket: versioning, AES256 default encryption, all four public-access-block settings (`:138-158`) |
| `wizard.bootstrap.configurationBucket` | `ensureConfigurationBucket` (`:185`) | versioning, `expire-noncurrent-versions` lifecycle rule, AES256, public-access block (`:200-242`) |
| `wizard.bootstrap.deploymentConfig` | `ensureDeploymentConfig` (`:313`) | seeds `withDeploymentConfigDefaults({ hostedZoneName: '', gameServers: {} })` as `deployment-config.json` only if absent (`:316-332,343-366`) |
| `wizard.bootstrap.runsTable` | `ensureRunsTable` (`:408`) | run-history DynamoDB table with `status-index` GSI and point-in-time recovery, waits for `ACTIVE` (`:369-400`) |

Settings are re-applied on the `exists` path so older buckets are brought up to standard (`cloud-bootstrap/spec.md:54-66`; archived Decision 5).
Default names are `<project>-tfstate` and `<project>-config` and are operator-editable (`wizard.utils.ts:44-49`); the runs table name is always `resolveRunsTableName(DEPLOYMENT_CONFIG_DEFAULTS.projectName, '')` regardless of what the operator typed (`wizard.controller.ts:307-310`).
The renderer runs the four calls concurrently (`use-bootstrap-resources.hook.ts:219`).

Failure handling: AWS errors inside each method are logged and returned as `{ status: 'failed', message }`, but the client is built before the `try` (`BootstrapService.ts:125,187,315,410`), and `resolveClientConfig` throws `BootstrapCredentialsNotConfiguredError` when `aws.region` is unset (`:701-708`), so that case rejects the IPC call instead.

### IAM permission check

`IamCheckService.checkPermissions` (`IamCheckService.ts:125`) resolves the caller ARN via STS, then runs `iam:SimulatePrincipalPolicy` over `HYVEON_DEPLOY_ALL_ACTIONS` in batches of 50 (`:15,264-317`).
Result is `passed | missing | warning` with an `origin` of `guided | pasted | profile | none` (`:63`, guided when the profile is `hyveon-guided`, `:218`) and `blocking = status === 'missing' && origin === 'guided'` (`:193-196`).
Any STS or simulation failure degrades to a non-blocking `warning` (`:133,140-156,179-183`).
For missing actions it emits a suggested policy with `Resource: '*'` for every action (`:306-315`), broader than the scoped statements in `iamPolicy.ts:79`.

Divergence: `cloud-bootstrap/spec.md:93,110-113` requires the check to run automatically after guided rotation and a guided `missing` result to block progression.
In the renderer the check runs only when the operator presses the button (`use-bootstrap-resources.hook.ts:223-239`, `bootstrap-step.component.tsx:121`), and no renderer code reads `blocking`; the bootstrap step's advance condition is resource status only (`first-run-wizard.component.tsx:237-238`). The service computes the gate; nothing enforces it.

### Cloud Health

`CloudHealthService` (`CloudHealthService.ts:63`) holds a typed check list seeded with one entry, `ecs-service-linked-role` (`:74,94-110`), surfaced as an always-visible Settings checklist rather than a silent self-heal (archived `aws-cloud-health-checks/design.md` D1, D2).
`cloudHealth.fix` calls `iam:CreateServiceLinkedRole` for `ecs.amazonaws.com` (`:133-136`) and degrades to a downloadable policy JSON and a console link (`cloudHealth.downloadPolicy`, `cloudHealth.openPolicyConsole`, `cloud-health.controller.ts:48-55`; D3).
`cloudHealth.list` wraps the checks in a bare `Promise.all` (`cloud-health.controller.ts:28-33`), so one throwing check rejects the list; `writePolicyToDisk` has no try/catch (`CloudHealthService.ts:200-204`).
The service is provided by `WizardModule` (`wizard.module.ts:38`) and carries helpers documented as mirroring `GuidedIamService` (`CloudHealthService.ts:193-212,240-291`).

## Credential Custody

### Encryption

`SafeStorageService` wraps Electron `safeStorage`: `isAvailable()` is false outside Electron or when the OS keychain is unavailable (`SafeStorageService.ts:30-33`).
`encrypt` returns plaintext unchanged with a warning when unavailable (`:51-54`) and `decrypt` returns its input unchanged when unavailable (`:88-93`).
Writers guard against the first case; nothing guards a read that happens after the keychain becomes unavailable, in which case base64 ciphertext would be returned as the key.
`ElectronStoreService` exposes typed `get`/`set`/`delete` plus encrypting accessors; `PastedAwsCredentials` fields are encrypted blobs that callers must not read directly (`ElectronStoreService.ts:19-28`).

### Resolution

`resolveAwsCredentialSource(store)` (`awsCredentialSource.ts:93`) is the one resolver:

- no `aws.profile` → `{ kind: 'none' }`;
- `aws.profile` matches a `creds.aws` entry → `{ kind: 'pasted', accessKeyId, secretAccessKey }` (decrypted), or `AwsPastedCredentialDecryptError` with re-entry instructions if decrypt throws;
- otherwise → `{ kind: 'profile', profile }`, a real `~/.aws` profile.

A pasted entry wins over a CLI profile of the same name; there is no separate discriminator (`BootstrapService.ts:695-700`).
`resolveAwsClientCredentialsWithSignature` (`awsCredentialSource.ts:177-192`) pairs the credentials with a stable signature (`none`, `pasted:<profile>:<accessKeyId>`, `profile:<profile>`) because `fromIni` returns a new function per call and cannot be compared by identity (`:160-176`).
`createCachedAwsClient` keys a lazily built client on `<region>::<signature>` and rebuilds on change (`awsClientCache.ts:35-50`), so same-region key rotation takes effect without a restart; `cloud-aws/src/cachedClient.ts:35` is a code-identical copy.

### Rotation for non-guided keys

`AwsProfileService.rotateActiveCredentials()` (`AwsProfileService.ts:267`) implements mint, verify, swap and revoke for the active pasted key, satisfying `aws-credentials/spec.md:47-59` at the service layer, but no controller channel or UI calls it.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Guided IAM mechanism | CloudFormation template + console handoff | IAM Identity Center device flow; root keys; shell script against the CLI; docs-only | Archived `add-one-click-aws-bootstrap/design.md` Decision 1: declarative, reviewable, deletable, works without Organizations. |
| Template delivery | Local file written under `userData`, operator uploads | Hosted S3 template for a `?templateURL=` quick-create link | Same design, Decision 2: `CreateStack` needs an S3 URL; hosting adds permanently-online project infrastructure for one saved click. |
| Bootstrap secret in stack outputs | Accepted, mitigated by mandatory immediate rotation | Operator mints key by hand; key in Secrets Manager; assumed role | Same design, Decision 3: alternatives are circular or lose the no-console-navigation property. |
| Access key deletion policy | `RetainExceptOnCreate` | `Retain` (as the design specified) | In-file comment `iam-bootstrap.yaml:66-73`: a failed initial create still rolls back cleanly. |
| IAM check gating | Blocking only for guided `missing`; advisory elsewhere; failures are warnings | Advisory everywhere (original wizard) | Same design, Decision 4; note the renderer does not enforce it today. |
| Progress vs answers storage | `wizard-state.json` for flow progress, electron-store for durable answers | Everything in electron-store | Archived `add-first-run-wizard/design.md` Decision 4: keeps ephemeral flow state out of the durable config file. |
| Bootstrap granularity | One IPC call per resource, `created/exists/failed` result | One combined bootstrap call | Same design, Decision 6: per-resource status and retry. |
| Bootstrap transport | SDK-direct in `desktop-main` before any stack exists | Provision buckets/table from the Pulumi program | `cloud-bootstrap` spec "SDK-only bootstrap" (`:7`); runs table moved here to break a circular dependency (`BootstrapService.ts:369-384`). |
| Credential source discriminator | Profile name lookup: pasted entry wins, else `~/.aws` profile | Explicit `kind` field in the store | `[inferred]` from the doc comment at `BootstrapService.ts:695-700`, which states the behaviour but not why a discriminator was rejected. |
| Client cache key | Region + credentials signature string | Compare credential objects; region only | Doc comment `awsCredentialSource.ts:160-176`: `fromIni` identity changes per call; region-only missed rotations. |
| Keychain unavailable on write | Refuse (`SafeStorageUnavailableError`) | Store plaintext | `guided-iam-provisioning` "Keychain requirement" (`spec.md:90`); `GuidedIamService.ts` rotate doc comment step 0. |
| Keychain unavailable on read | Pass the stored value through unchanged | Throw | `[inferred]`: appears to exist for non-Electron test/integration runs where `isAvailable()` is false (`SafeStorageService.ts:30-33`); the doc comment at `:78-79` acknowledges the consequence without a rationale. |
| Cloud Health placement | Always-visible Settings checklist | Silent self-heal in `EcsService.start()`; collapsed summary card | Archived `aws-cloud-health-checks/design.md` D1. |
| Cloud Health module home | Provided by `WizardModule` | Own module | `[inferred]`: shares IAM/STS client helpers with `GuidedIamService` (`CloudHealthService.ts:193-212`). |
| Region data source | Committed generated `awsRegions.ts` + manual entry | Fetch region feed at runtime | Archived `first-run-wizard-region-dropdown/design.md` D1, D2. |
| Unset `wizardCompleted` default | `HYVEON_TEST_MODE` value | Always `false` | `[inferred]`: lets e2e boots skip the wizard without seeding the store (`wizard.controller.ts:168`). |

## Open Questions & Future Decisions

### Resolved

1. ✅ The CloudFormation stack does not create the Pulumi state bucket, and no hosted template is published by the release pipeline (archived `add-one-click-aws-bootstrap/design.md`, Resolved Questions).
2. ✅ The template keeps publishing `SecretAccessKey` as a stack output; mandatory immediate rotation makes the published key single-use, and the delete-failed path (APP-WIZARD-ROTATE-005, APP-WIZARD-ROTATE-006) covers the window when revocation fails (APP-WIZARD-TMPL-008; archived `add-one-click-aws-bootstrap/design.md` Decision 3).

### Deferred

1. Should `SafeStorageService.decrypt` throw instead of returning ciphertext when the keychain is unavailable for a value that was encrypted (`SafeStorageService.ts:88-92`)?
2. Should the `HYVEON_TEST_MODE` fallback for an unset `wizardCompleted` move out of the production read path (`wizard.controller.ts:166-168,217-219`), reusing `env.ts:12`?
3. Should the renderer first-run gate fail closed on a missing bridge or rejected `getState()` (`app.component.tsx:40-54`, desktop-shell)?
4. Should `BootstrapService` build its client inside each `try` so a missing region returns `{ status: 'failed' }` (`BootstrapService.ts:125,187,315,410,701-708`) per `.claude/rules/logging.md` rule 2?
5. Should the runs table name use the operator's project name rather than `DEPLOYMENT_CONFIG_DEFAULTS.projectName` (`wizard.controller.ts:310`)?
6. Should `rotateActiveCredentials` get an IPC channel and UI, or should the `aws-credentials` "In-app access key rotation" requirement be dropped (`AwsProfileService.ts:267`, `aws-credentials/spec.md:47-59`)?
7. Should the IAM check run automatically after guided rotation and its `blocking` flag gate the bootstrap step, as `cloud-bootstrap/spec.md:93,110-113` requires (`use-bootstrap-resources.hook.ts:223-239`, `first-run-wizard.component.tsx:237-238`)?
8. Which is right for the `wizard-flow` spec: the state-file name at `:25` or `:34`, and the Reconfigure step order at `:100` or `wizardSteps.ts:9`?
9. Does Reconfigure's `commitReconfigureAnswers` overwrite the guided profile when guided IAM was re-run (`use-reconfigure-answers.hook.ts:222-224` vs `first-run-wizard.component.tsx:307`)?
10. Should `cloudHealth.list` use `Promise.allSettled` and `writePolicyToDisk` catch its errors (`cloud-health.controller.ts:28-33`, `CloudHealthService.ts:200-204`)?
11. Should `awsClientCache.ts` be removed in favour of `cloud-aws/src/cachedClient.ts`, `GUIDED_PROFILE_NAME` be declared once (`GuidedIamService.ts:94`, `desktop-preload/src/hyveon-api.ts:2107`), and the Cloud Health helpers that mirror `GuidedIamService` be shared (`CloudHealthService.ts:193-212,240-291`)?
12. Should the IAM-check suggested policy reuse the scoped `HYVEON_DEPLOY_ALL_STATEMENTS` instead of `Resource: '*'` (`IamCheckService.ts:306-315`)?
13. Should wizard reset also clear `addGameWizardDraft` and `folderUpload`, or document why not (`FirstRunWizardService.ts:200-208`)?
14. Should template substitution use `replaceAll` (`GuidedIamService.ts:210-212`), and should `awsClientCache.ts` get tests?
15. Should the credential signature avoid embedding the access key id (`awsCredentialSource.ts:185`)?
16. Should `CloudHealthService` move out of `WizardModule` into a Settings-owned module (`wizard.module.ts:38`)?
17. `wizard.state.get` returns `this.store.get('aws')` typed as `WizardAwsChoice` (`wizard.controller.ts:61-64,172`), but the stored `aws` schema also carries `accessKeyId` and `secretAccessKey` blobs (`ElectronStoreService.ts:204-209`); their setters (`:397,423`) have no production caller today, so this is latent. Should the controller project only `profile` and `region`, and should the unused setters be removed?
18. On a Reconfigure that re-runs guided IAM, `rotate` overwrites the existing `hyveon-guided` entry before verifying the new key and deletes it on verification failure (`GuidedIamService.ts:434-438,478`) while `aws.profile` may still name `hyveon-guided`; the resolver would then treat it as a `~/.aws` profile `[inferred]`. Should staging use a temporary name?
19. Should the region list drop `eusc-de-east-1` (`awsRegions.ts:36`), a separate partition, and should the spec exclusion rule name it (`guided-region-selection/spec.md:13-24`)?
20. `aws-cloud-health/spec.md:4` Purpose is still TBD; what is the capability's stated purpose?

## References

- Arrow doc: `docs/arrows/operator-app/wizard-and-bootstrap.md`
- EARS specs: `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md`
- OpenSpec: `openspec/specs/wizard-flow/spec.md`, `openspec/specs/guided-iam-provisioning/spec.md`, `openspec/specs/guided-region-selection/spec.md`, `openspec/specs/aws-credentials/spec.md`, `openspec/specs/cloud-bootstrap/spec.md`, `openspec/specs/aws-cloud-health/spec.md`
- Archived designs: `openspec/changes/archive/2026-07-26-add-first-run-wizard/design.md`, `2026-08-05-first-run-wizard-region-dropdown/design.md`, `2026-08-10-add-one-click-aws-bootstrap/design.md`, `2026-08-11-aws-cloud-health-checks/design.md`
- Docs: `docs/docs/app/first-run-wizard.md`, `docs/docs/app/settings.md`, `docs/docs/components/management-app.md`, `docs/docs/setup.md` (`HyveonDeployAll` source of truth)
- Neighbouring leaves: `docs/intent/iac/engine/engine-design.md`, `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/game-server/game-server-design.md`, `docs/intent/helper-task/helper-task-design.md`
