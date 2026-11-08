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
- **Idempotent, per-resource steps.** Each bootstrap resource is its own service method and IPC call returning `created | exists | failed` (`BootstrapService.ts:69-75`), so the UI renders per-resource status and retries one resource at a time rather than through one combined bootstrap call.
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

Wizard state is split across two stores by lifetime, which keeps ephemeral flow state out of the durable config file:

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


### Gate and completion

`wizard.state.get` returns `wizardCompleted`, `activeCloud`, `aws`, `bootstrap` and `deployPrincipal` (`wizard.controller.ts` `readState`).
`wizardCompleted` is `false` until the wizard writes it, in every build and regardless of environment variables.
`aws` is projected to `profile` and `region`; the encrypted key blobs the store schema also allows never leave the main process.
The Electron e2e specs that land on the dashboard get `wizardCompleted: true` from a default mock the preload test seam registers when `HYVEON_TEST_MODE=1` (re-registered by `clearMocks`/`reset`, overridable per spec), not from this handler.
The renderer gate (desktop-shell's `app.component.tsx:40-54`) treats a missing bridge or a rejected `getState()` as `wizardCompleted = true`, so the gate fails open.

`wizard.complete` sets the flag and returns state (`wizard.controller.ts:347-351`).
`wizard.reset` (`:362-366`) calls `FirstRunWizardService.reset()`, which removes the progress file and clears `wizardCompleted`, `activeCloud`, `aws`, `bootstrap` and `creds` but deliberately leaves `pulumi.*` because the legacy passphrase may be the only key to an existing stack's encrypted state (`FirstRunWizardService.ts:180-208`); it also leaves `addGameWizardDraft` and `folderUpload`, without a stated reason.

### First-run vs Reconfigure

`FirstRunWizard` takes `mode: 'first-run' | 'reconfigure'` (`first-run-wizard.component.tsx:59,69`).
In first-run mode answers are written as each step is left: `activeCloud` on leaving pick-cloud, the credentials payload on leaving credentials unless guided credentials already satisfied the step, and bootstrap names best-effort on leaving bootstrap (`:296-320`).
In Reconfigure mode, steps are pre-marked complete from stored state and collapse (`:231`), the sidebar is hidden (`:332`), and edits buffer in component state until `commitReconfigureAnswers` writes them in one `wizard.state.save` when the operator enters the stack-init step (`use-reconfigure-answers.hook.ts`, called from `goNext` in `first-run-wizard.component.tsx`), because stack initialization resolves its credentials from the store and cannot see buffered answers.
The credentials step's paste form stages its keys in renderer memory in Reconfigure mode and `wizard.aws.saveCredentials` runs in that same commit, before `iac.stack.initialize` starts, so a Cancel before stack-init never overwrites `creds.aws.<profile>`; first-run mode still saves on submit. A staged pair with a blank or whitespace-only field is refused on submit.
Guided rotation and the bootstrap buttons act on AWS immediately in both modes and cannot be unwound, and the commit on entering stack-init is itself the point of no return: after any of them has run, Cancel (state kept in `use-reconfigure-cancel.hook.ts`) opens a confirmation stating that those AWS changes remain in place and were not undone, and a Cancel before any of them leaves without a prompt.
`commitReconfigureAnswers` sends `credentials.toStatePayload()` whenever the credentials step is not pre-completed (`use-reconfigure-answers.hook.ts:222-224`) without the `!guidedCredentials` guard the first-run path has (`first-run-wizard.component.tsx:307`) `[inferred]` risk, not reproduced.

Step advancement on the bootstrap step requires every resource `created` or `exists` (`first-run-wizard.component.tsx:237-238`, `use-bootstrap-resources.hook.ts:241-246`); for a guided install it also requires a finished, non-blocking IAM check (see below).

## Credential Acquisition Paths

Three paths end in the same place: `aws.profile` and `aws.region` set in electron-store, and, for the two non-profile paths, an encrypted `creds.aws[<profile>]` entry.

| Path | Profile name | Stored material | Entry point |
|---|---|---|---|
| Existing `~/.aws` profile | operator's profile name | none; SDK uses `fromIni({ profile })` | `AwsProfileService.listProfiles` (`AwsProfileService.ts:152`), `wizard.aws.listProfiles` |
| Pasted keys | `hyveon-pasted` by default (`AwsProfileService.ts:28,187`) | encrypted key pair | `savePastedCredentials`, `wizard.aws.saveCredentials` (`wizard.controller.ts:233-246`) |
| Guided IAM | `hyveon-guided` (`GuidedIamService.ts:94`) | encrypted rotated key pair | `wizard.guidedIam.*` (`wizard.controller.ts:374-429`) |

### Guided IAM provisioning

Guided IAM replaces manual IAM console work with a reviewable CloudFormation template handed to the operator's existing console session. The constraint is that an app with no credentials cannot create credentials: no AWS API authenticates as the root user, so any automated setup has to bounce through a browser session the human already owns.

1. **Template.** `prepareTemplate` reads `resources/cloudformation/iam-bootstrap.yaml`, substitutes `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` and `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` with `generateHyveonDeployAllPolicy()` and `generateHyveonSelfRotatePolicy()` (`shared/src/iamPolicy.ts:200,243`), and writes the result under `userData` (`GuidedIamService.ts:200-215`). Substitution uses single-occurrence `String.replace` (`:210-212`). The template creates the `HyveonDeployAll` and `HyveonSelfRotate` managed policies, an IAM user, and an access key with `DeletionPolicy: RetainExceptOnCreate`, and publishes `AccessKeyId` and `SecretAccessKey` as stack outputs (`iam-bootstrap.yaml:30-89`).
2. **Console handoff.** `openConsole` opens `https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create` (`GuidedIamService.ts:242,275`); the operator uploads the file (there is no hosted template; see Decisions & Alternatives, "Template delivery").
3. **Intake.** The operator pastes the stack-output key into the renderer; `intakeBootstrapKey` validates it with `sts:GetCallerIdentity` and rethrows the raw SDK error so the UI can explain it (`GuidedIamService.ts:325-343`). Intake writes nothing to the store; the deploy principal is recorded by rotation (step 4). The bootstrap key is held in renderer React state (`use-guided-iam.hook.ts:146-147`) and cleared after submit (`:409`).
4. **Mandatory rotation** (`rotate`, `GuidedIamService.ts:414-514`), in a documented load-bearing order: keychain gate; `iam:CreateAccessKey` with the bootstrap key; stage the new pair as `hyveon-guided` without activating it; verify with `sts:GetCallerIdentity` through `verifyAccessKeyWithRetry` (delays `[1000, 2000, 4000, 8000, 8000]`, six attempts, `verifyAccessKeyWithRetry.ts:12,46-78`); on failure, best-effort delete the new key and the staged entry and return `verification-failed`; when `hyveon-guided` is already the active profile (a Reconfigure re-run), the new pair is held in memory and written only after it verifies, so a failure deletes only the new IAM key and nothing already stored (APP-WIZARD-ROTATE-008); on success set `aws.profile = 'hyveon-guided'` and record `deployPrincipal` from the verify call's caller identity: the account ID and, when the caller ARN is an IAM user, the final path segment as the user name, which is the stack's `UserName` parameter, default or not (a non-user ARN records the account ID alone), so a re-run that fails or is abandoned never relabels the still-active key; `FirstRunWizardService.reset()` deletes it; finally delete the bootstrap key with the new credentials, returning `delete-failed` plus the IAM security-credentials console URL if that fails (`:500-506,661`).
5. **Manual revoke.** `revokeBootstrapKey` (`GuidedIamService.ts:567`) backs the delete-failed screen's retry.

Sub-state progresses `not-started → template-written → awaiting-key-intake → rotation-pending → complete` (`FirstRunWizardService.ts:21`, persisted from `use-guided-iam.hook.ts:278,326,358,410,442`).
A `rotation-pending` resume lands back on intake because the bootstrap key itself is never persisted (`use-guided-iam.hook.ts:201-240`).
An `awaiting-key-intake` resume also lands on intake, with its region field editable when no region was recovered; a `template-written` resume lands on the template screen, or on the region screen when no region is recoverable.
When the OS keychain is unavailable, `wizard.guidedIam.rotate` returns `{ status: 'keychain-unavailable' }` (the service still throws `SafeStorageUnavailableError` before minting anything, and the controller maps it); the step shows a screen saying the keychain is unavailable and offering the profile-picker or paste path on the credentials step, with no retry action because retrying cannot succeed.

The access key's `DeletionPolicy` is `RetainExceptOnCreate` (in-file rationale at `iam-bootstrap.yaml:66-73`), so a failed initial create still rolls back cleanly while a later stack deletion does not fail on a key CloudFormation no longer owns.

### Region selection

The guided path's region dropdown reads the committed, generated `shared/src/awsRegions.ts` (regenerated by `build/generate-aws-regions.mjs`), with a manual-entry fallback (APP-WIZARD-REGION-001 to APP-WIZARD-REGION-004).
The data set includes `eusc-de-east-1`, "AWS European Sovereign Cloud (Germany)" (`awsRegions.ts:36`); the generator excludes only the `us-gov-` and `cn-` prefixes (APP-WIZARD-REGION-002), so this is consistent with that rule but is a separate partition where commercial credentials do not authenticate.

The region chosen on either path is the install's one AWS region (`docs/high-level-design.md`, decision 10): bootstrap creates the buckets and runs table in it, and every other leaf resolves its region from it through `ConfigService.getRegion()`.
The lock engages at the first bootstrap call: each `wizard.bootstrap.*` handler persists the wizard region as `installRegionLock` before it creates anything, and creates nothing if that write fails. From then on the wizard refuses a different region at the credentials step, at the guided-IAM region screen (before the CloudFormation handoff), at console handoff and key intake, and again just before rotation activates the minted key. The refusal tells the operator that moving regions means destroying the stack, deleting the bootstrap resources and resetting the app. Because a bootstrap that fails part-way must not strand the operator, Start over (`wizard.reset`) clears the lock (`APP-WIZARD-REGLOCK-001`).

## Bootstrap Resources and IAM Check

### Resources

`BootstrapService` (`BootstrapService.ts:105`) creates everything with the SDK directly, before any Pulumi stack exists:

| Channel | Method | Resource and settings |
|---|---|---|
| `wizard.bootstrap.stateBucket` | `ensureStateBucket` (`:123`) | Pulumi state bucket: versioning, AES256 default encryption, all four public-access-block settings (`:138-158`) |
| `wizard.bootstrap.configurationBucket` | `ensureConfigurationBucket` (`:185`) | versioning, `expire-noncurrent-versions` lifecycle rule, AES256, public-access block (`:200-242`) |
| `wizard.bootstrap.deploymentConfig` | `ensureDeploymentConfig` (`:313`) | seeds `withDeploymentConfigDefaults({ hostedZoneName: '', gameServers: {} })` as `deployment-config.json` only if absent (`:316-332,343-366`) |
| `wizard.bootstrap.runsTable` | `ensureRunsTable` (`:408`) | run-history DynamoDB table with `status-index` GSI and point-in-time recovery, waits for `ACTIVE` (`:369-400`) |

Settings are re-applied on the `exists` path so older buckets are brought up to standard (APP-WIZARD-BOOT-005, APP-WIZARD-BOOT-008): `ensureConfigurationBucket` applies the same idempotent default encryption as `ensureStateBucket` on both the `created` and `exists` paths.
Default names are `<project>-tfstate` and `<project>-config` and are operator-editable (`wizard.utils.ts:44-49`); the runs table name is resolved from the `projectName` and `runsTableName` of the `deployment-config.json` already in the configuration bucket (`BootstrapService.resolveExistingRunsTableName`), falling back to `resolveRunsTableName(DEPLOYMENT_CONFIG_DEFAULTS.projectName, '')` only on a fresh install (document not found), regardless of what the operator typed in the bucket-name fields, because the wizard has no project-name field and a re-run must target the table the stack already uses (APP-WIZARD-BOOT-012).
The renderer runs the four calls concurrently (`use-bootstrap-resources.hook.ts:219`).

Failure handling: AWS errors inside each method are logged and returned as `{ status: 'failed', message }`, and so is a client-construction failure (no stored `aws.region`, undecryptable credentials), because `buildClient` converts the throw into a `failed` result, so no `wizard.bootstrap.*` call rejects (APP-WIZARD-BOOT-004).

### IAM permission check

`IamCheckService.checkPermissions` (`IamCheckService.ts:125`) resolves the caller ARN via STS, then runs `iam:SimulatePrincipalPolicy` over `HYVEON_DEPLOY_ALL_ACTIONS` in batches of 50 (`:15,264-317`).
Result is `passed | missing | warning` with an `origin` of `guided | pasted | profile | none` (`:63`, guided when the profile is `hyveon-guided`, `:218`) and `blocking = status === 'missing' && origin === 'guided'` (`:193-196`).
Any STS or simulation failure degrades to a non-blocking `warning` (`:133,140-156,179-183`).
For missing actions it emits a suggested policy with `Resource: '*'` for every action (`:306-315`), broader than the scoped statements in `iamPolicy.ts:79`.

After guided provisioning completes the wizard runs the check automatically, and a guided install cannot progress past the bootstrap step, even when Reconfigure collapses it, until a check has finished without error and is not `blocking`; a guided install that reaches the step with no result runs the check itself. The panel lists the denied actions as "missing actions only" JSON and tells a guided operator to update the stack with a freshly rendered template, because that JSON is a delta on `Resource: '*'` and pasting it over the stack's policy would replace the full policy (APP-WIZARD-IAMCHK-008, APP-WIZARD-IAMCHK-009). A result for a picked profile or pasted keys never blocks, and switching away from the guided credentials discards the result.

### Cloud Health

`CloudHealthService` (`CloudHealthService.ts:63`) holds a typed check list seeded with one entry, `ecs-service-linked-role` (`:74,94-110`), surfaced as an always-visible Settings checklist rather than a silent self-heal (see Decisions & Alternatives, "Cloud Health placement").
`cloudHealth.fix` calls `iam:CreateServiceLinkedRole` for `ecs.amazonaws.com` (`:133-136`) and degrades to a downloadable policy JSON and a console link (`cloudHealth.downloadPolicy`, `cloudHealth.openPolicyConsole`, `cloud-health.controller.ts:48-55`). The fallback exists because a stack deployed before the permission existed has an out-of-date `HyveonDeployAll`, and code changes to the policy generator do not retroactively update a CloudFormation-managed policy.
`cloudHealth.list` reports a check that throws as an `error` row and still returns the others, and `writePolicyToDisk` logs a write failure and throws a plain `Error` carrying only a message (APP-WIZARD-HEALTH-011). A `needsPolicyUpdate` result carries `policyManagedByStack`, true when the active credentials are the guided profile: guided installs are told to update the policy through their CloudFormation stack, other installs to edit it in the IAM console (APP-WIZARD-HEALTH-008).
The service is provided by `WizardModule` (`wizard.module.ts:38`) and carries helpers documented as mirroring `GuidedIamService` (`CloudHealthService.ts:193-212,240-291`).

## Credential Custody

### Encryption

`SafeStorageService` wraps Electron `safeStorage`: `isAvailable()` is false outside Electron or when the OS keychain is unavailable (`SafeStorageService.ts:30-33`).
`encrypt` returns plaintext unchanged outside Electron but throws `SafeStorageUnavailableError` inside Electron when the keychain is unavailable, so a mid-rotation lock fails before the old key is revoked (APP-WIZARD-CUSTODY-007).
Writers guard against the first case, and `decrypt` throws inside Electron when the keychain is unavailable so a stored ciphertext is never returned as a key (APP-WIZARD-CUSTODY-007); outside Electron it returns the stored plaintext unchanged, matching `encrypt`.
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

`AwsProfileService.rotateActiveCredentials()` implements mint, verify, swap and revoke for the active pasted or guided key (APP-WIZARD-ROTKEY-001 to APP-WIZARD-ROTKEY-004). Settings, in the Cloud Setup section, offers it as a "Rotate key" action over `wizard.aws.rotateKey`, which returns a modeled result for every outcome (`complete`, `verification-failed`, `delete-failed`, `keychain-unavailable`, `unsupported`, `busy`, `failed`), shares one in-flight rotation between concurrent calls, and refuses with `busy` while a Pulumi operation is running (APP-WIZARD-ROTKEY-005). The outcome unions live once in `@hyveon/shared` (`keyRotation.ts`) and are imported by desktop-main and the preload. The Settings row is hidden for `~/.aws`-profile installs. Every AWS-calling service resolves the stored key per call, so later calls and Pulumi operations use the new key.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Guided IAM mechanism | CloudFormation template + console handoff | IAM Identity Center device flow; root keys; shell script against the CLI; docs-only | The artifact is declarative and reviewable before execution, idempotent, deletable as a unit, and works for a solo account without Organizations. IAM Identity Center is strictly better when already enabled (short-lived credentials, no stored secret) but needs Organizations plus a permission set, more console work than it replaces, so it stays a possible later additive path. AWS blocks root access keys on new accounts, and a root key in a keychain is the worst credential to hold. A shell script presupposes a working `aws configure`, the thing being bootstrapped, and moves the trust boundary to "paste this into your shell". Docs-only does not address the problem. |
| Template delivery | Local file written under `userData`, operator uploads | Hosted S3 template for a `?templateURL=` quick-create link | `CreateStack`'s `TemplateURL` must point to an S3 object or Systems Manager document (max 1 MB), so a raw GitHub URL does not work. A one-click link would need a project-owned public S3 bucket, published to on every release and kept alive indefinitely, because every new operator's setup would depend on it; that buys one saved file-picker interaction and ties setup to a maintainer's personal AWS account. The upload flow has to exist anyway as the offline and fallback path, and no dead branch anticipating hosting is carried. The template lives at `desktop-main/resources/cloudformation/iam-bootstrap.yaml`, shipped through `extraResources` (the mechanism that already ships the icon), beside its only reader, because `shared` ships pure TypeScript and has no plumbing for a static asset to survive into a packaged app. |
| Bootstrap secret in stack outputs | Accepted, mitigated by mandatory immediate rotation | Operator mints key by hand; key in Secrets Manager; assumed role | `SecretAccessKey` lands in stack outputs, readable by anything holding `cloudformation:DescribeStacks`, so rotation is a hard requirement: on first authentication the app mints its own key, stores it in the keychain, verifies it with `sts:GetCallerIdentity`, then deletes the bootstrap key, after which the output authenticates nothing. Having the operator mint the key by hand removes the output but loses the no-console-navigation property, and remains the documented fallback. A Secrets Manager secret is circular (reading it needs credentials the operator lacks), as is an assumed role (it needs a trusted principal that does not exist yet). |
| Access key deletion policy | `RetainExceptOnCreate` | `Retain` (as the design specified) | In-file comment `iam-bootstrap.yaml:66-73`: a failed initial create still rolls back cleanly. |
| IAM check gating | Blocking only for guided `missing`; advisory elsewhere; failures are warnings | Advisory everywhere (original wizard) | After guided provisioning the permission set is known by construction, so a failed simulation means something concrete went wrong: wrong account, a partially failed stack, or an SCP denying actions. It stays advisory on the manual and profile paths, where an operator may deliberately run a narrower policy, and a simulation that is itself unavailable never blocks on any path. Rotation runs before the check so the credential verified is the one the app keeps. The renderer does not enforce the gate today. |
| Progress vs answers storage | `wizard-state.json` for flow progress, electron-store for durable answers | Everything in electron-store | Keeps ephemeral flow state out of the durable config file; corrupt or missing progress simply restarts at the first step. |
| Bootstrap granularity | One IPC call per resource, `created/exists/failed` result | One combined bootstrap call | Per-resource status and retry of a single failed resource; idempotency maps `BucketAlreadyOwnedByYou` and `ResourceInUseException` to success. |
| Bootstrap transport | SDK-direct in `desktop-main` before any stack exists | Provision buckets/table from the Pulumi program | No stack, state backend or credentials-bearing engine exists yet, so bootstrap uses SDK clients directly (APP-WIZARD-BOOT-001); the runs table is created here to break a circular dependency (`BootstrapService.ts:369-384`). |
| Credential source discriminator | Profile name lookup: pasted entry wins, else `~/.aws` profile | Explicit `kind` field in the store | `[inferred]` from the doc comment at `BootstrapService.ts:695-700`, which states the behaviour but not why a discriminator was rejected. |
| Client cache key | Region + credentials signature string | Compare credential objects; region only | Doc comment `awsCredentialSource.ts:160-176`: `fromIni` identity changes per call; region-only missed rotations. |
| Keychain unavailable on write | Refuse (`SafeStorageUnavailableError`) | Store plaintext | No credential is ever stored in plaintext (APP-WIZARD-CUSTODY-008); `GuidedIamService.ts` rotate doc comment step 0. |
| Keychain unavailable on read | Throw inside Electron; pass the stored value through unchanged outside Electron | Pass through unchanged everywhere | Inside Electron an unavailable keychain means the stored value is ciphertext, and returning it hands base64 noise to the SDK as a secret (APP-WIZARD-CUSTODY-007); outside Electron `encrypt` stored plaintext, so the plain-Node integration harness and tests need the symmetric pass-through. |
| Cloud Health placement | Always-visible Settings checklist | Silent self-heal in `EcsService.start()`; collapsed summary card | The operator wants visibility and control rather than the app silently auto-fixing account-level problems on `start()`, which would also couple an account-config concern to a per-action code path; an always-visible list generalises to future checks without a new UI each time. The check list is a typed array so a second check is one entry, while only the ECS service-linked-role check ships. Checks run on Settings mount and manual Refresh, with no polling, because the role's existence essentially never changes on its own. The Fix attempts the real remediation first and falls back to the policy JSON only on `AccessDenied`, so only operators with an out-of-date policy do manual work. The service-linked-role statement is scoped by resource path and `iam:AWSServiceName`, which is strictly narrower than the existing `iam:*` on `hyveon-*` resources. |
| Cloud Health module home | Provided by `WizardModule` | Own module | `[inferred]`: shares IAM/STS client helpers with `GuidedIamService` (`CloudHealthService.ts:193-212`). |
| Region data source | Committed generated `awsRegions.ts` + manual entry | Fetch region feed at runtime | The guided-IAM region screen runs before any credentials exist, so no AWS call can supply the list: `DescribeRegions` needs credentials and returns country names rather than city-level locations, and the SSM public parameters are not anonymous and would need a new deploy-policy grant. Fetching the feed at runtime would add a network dependency and a failure state for data that changes on the order of months. The manual-entry item means a stale data set degrades to one extra click, never a block. A Radix `Select` with groups fits continent grouping better than a native `<optgroup>`. The data lives in `@hyveon/shared` because region labels are not web-specific, and the display is `{name} — {code}` so operators who know the code still see it. |
| Region change after bootstrap | Refused from the first bootstrap call (an `installRegionLock` marker persisted before any resource is created; a stored `bootstrap` record also locks, for installs that predate the marker); moving regions is destroy the stack, delete the bootstrap resources, reset the app. Start over clears the marker | Lock only while the game stack has resources, so a destroy frees the region; accept the new region and let the next apply rebuild there; migrate resources across regions | The state bucket, config bucket and runs table are created by bootstrap in the wizard region and survive a stack destroy, so a stack-only lock would let games land in a new region while state stays in the old one, breaking one region per install. The marker is a local check with no AWS lookup, and engaging it before the first create call closes the window where a failed bootstrap leaves buckets in one region and lets the operator pick another. "Start over" clears only local settings and leaves those resources in place, which is why deleting them is a separate step. |
| Staging the new guided key when `hyveon-guided` is already active | Hold the new pair in memory and write it only after it verifies | Stage under a temporary profile name and promote it on success | A Reconfigure re-run would otherwise overwrite the entry `aws.profile` still names before the new key is proven, and a failed verify would delete the credential in use (APP-WIZARD-ROTATE-008, APP-WIZARD-RECONF-009). Memory needs no second store entry, no promotion step and no cleanup path that can itself fail. |
| Unset `wizardCompleted` default | Always `false` in the handler; the e2e dashboard bypass is a default `wizard.state.get` mock in the preload test seam | `HYVEON_TEST_MODE` fallback inside the handler; seeding the real store at launch | A production read path must not depend on an environment variable, and the e2e harness shares the operator's real `userData`, so seeding `wizardCompleted: true` would write into a developer's own store. The preload seam is already test-only and already the place specs override IPC responses. |
| Pasted keys during Reconfigure | Stage in renderer memory, save on entering stack-init | Stage under a pending profile name and promote on commit; snapshot the store and restore on Cancel | A save overwrites `creds.aws.<profile>`, which may be the active credential, so Cancel could not leave the store as it was. Memory needs no new IPC, no promotion step and no cleanup that can itself fail; the keys already sit in the form's inputs, and answers are already buffered until stack-init is entered (APP-WIZARD-RECONF-006). The save cannot wait for Finish: stack initialization resolves credentials from the store, so a revoked or expired active key would fail it with no way forward. A keychain refusal therefore surfaces when the operator continues to stack-init rather than on submit. |
| Cancel after AWS-side changes | Confirm, stating the changes remain | Snapshot and restore the store, or block Cancel | Rotation revokes the bootstrap key, so restoring the earlier store contents could not restore a working state; the honest contract is that AWS-side steps are not undone and the operator is told so before leaving. |
| Recording the deploy principal | Parse the IAM user name and account ID from the bootstrap key's `sts:GetCallerIdentity` ARN at intake | A renderer field for the stack's `UserName` parameter | The key belongs to the stack's `UserName` user, so the caller ARN names it exactly, for a default or custom name, with no operator input to mistype or drift from the stack. |
| Runs table name when the config document cannot be read | Not found falls back to the default name; any other read error or a malformed document fails the step | Fall back to the default name on every failure | A transient S3 error or a corrupt document would otherwise create a table under a guessed name that the stack never uses. A malformed document fails rather than falls back because it proves the document exists, so the default may be wrong. |

## Open Questions & Future Decisions

### Resolved

1. ✅ The CloudFormation stack provisions IAM only; `BootstrapService` stays the single implementation of the state and configuration buckets. Folding the bucket in would save one wizard step, once, while the bootstrap logic would exist in two places and drift (operators who skip guided provisioning still need it), the Pulumi state bucket would become a child of a stack with a Delete button (losing it leaves Pulumi unaware of what infrastructure exists), and the operator-editable bucket names would have to be fixed stack parameters before the bootstrap step is reached. No hosted template is published by the release pipeline.
2. ✅ The template keeps publishing `SecretAccessKey` as a stack output; mandatory immediate rotation makes the published key a temporary credential pending rotation, revoked once the replacement verifies; it stays active while rotation fails or retries (APP-WIZARD-ROTATE-004, APP-WIZARD-ROTATE-007) and when revocation fails, which the delete-failed path surfaces with a retry (APP-WIZARD-ROTATE-005, APP-WIZARD-ROTATE-006) (APP-WIZARD-TMPL-008).
3. ✅ The `HyveonDeploy` statement (wildcard grants across roughly a dozen services on `Resource: "*"`) is not tightened by guided provisioning. Tightening needs the specific actions per wildcard service enumerated, several of which (most `ec2:Describe*`, Cost Explorer, much of CloudFront) have no resource-level scoping, and is verifiable only by repeated `pulumi up` runs against a real account; bundling it would make a mid-apply `AccessDenied` ambiguous between the new policy and the new flow. Tightening does not break existing installs, because a simulation of a wider policy still passes a narrower check.

4. ✅ The `HYVEON_TEST_MODE` fallback for an unset `wizardCompleted` left the production read path; the e2e bypass is the preload test seam's default mock (see the Decisions table).
5. ✅ `wizard.state.get` projects only `profile` and `region` from the stored `aws` record (APP-WIZARD-CREDS-011).
6. ✅ `SafeStorageService.decrypt` throws inside Electron when the keychain is unavailable instead of returning ciphertext (APP-WIZARD-CUSTODY-007).
7. ✅ `BootstrapService` builds its client inside a guard so a missing region or undecryptable credentials return `{ status: 'failed' }` (APP-WIZARD-BOOT-004).
8. ✅ The runs table name follows the `projectName` and `runsTableName` of the existing `deployment-config.json`, and falls back to `DEPLOYMENT_CONFIG_DEFAULTS.projectName` only when no document exists, because the wizard has no project-name field and a re-run must target the table the stack already uses (APP-WIZARD-BOOT-012).
9. ✅ `rotateActiveCredentials` has an IPC channel and a Settings action (APP-WIZARD-ROTKEY-005).
10. ✅ The IAM check runs automatically after guided provisioning and its `blocking` flag gates the bootstrap step (APP-WIZARD-IAMCHK-008, APP-WIZARD-IAMCHK-009).
11. ✅ `cloudHealth.list` isolates a failing check and `writePolicyToDisk` logs and rethrows a plain error (APP-WIZARD-HEALTH-011).

### Deferred

3. Should the renderer first-run gate fail closed on a missing bridge or rejected `getState()` (`app.component.tsx:40-54`, desktop-shell)?
10. Should `awsClientCache.ts` be removed in favour of `cloud-aws/src/cachedClient.ts`, `GUIDED_PROFILE_NAME` be declared once (`GuidedIamService.ts:94`, `desktop-preload/src/hyveon-api.ts:2107`), and the Cloud Health helpers that mirror `GuidedIamService` be shared (`CloudHealthService.ts:193-212,240-291`)?
11. Should the IAM-check suggested policy reuse the scoped `HYVEON_DEPLOY_ALL_STATEMENTS` instead of `Resource: '*'` (`IamCheckService.ts:306-315`)?
12. Should wizard reset also clear `addGameWizardDraft` and `folderUpload`, or document why not (`FirstRunWizardService.ts:200-208`)?
13. Should template substitution use `replaceAll` (`GuidedIamService.ts:210-212`), and should `awsClientCache.ts` get tests?
14. Should the credential signature avoid embedding the access key id (`awsCredentialSource.ts:185`)?
15. Should `CloudHealthService` move out of `WizardModule` into a Settings-owned module (`wizard.module.ts:38`)?
16. The `aws.accessKeyId`/`aws.secretAccessKey` store setters (`ElectronStoreService.ts:397,423`) have no production caller. Should they be removed?
18. Should the region list drop `eusc-de-east-1` (`awsRegions.ts:36`), a separate partition, and should the generator's exclusion rule (APP-WIZARD-REGION-002) name it?

## References

- Arrow doc: `docs/arrows/operator-app/wizard-and-bootstrap.md`
- EARS specs: `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-specs.md`
- Docs: `docs/docs/app/first-run-wizard.md`, `docs/docs/app/settings.md`, `docs/docs/components/management-app.md`, `docs/docs/setup.md` (`HyveonDeployAll` source of truth)
- Neighbouring leaves: `docs/intent/iac/engine/engine-design.md`, `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/game-server/game-server-design.md`, `docs/intent/helper-task/helper-task-design.md`
