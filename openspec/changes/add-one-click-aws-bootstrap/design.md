## Context

Hyveon's first-run wizard already covers prerequisites, cloud selection, credential intake, state-bucket/configuration-bucket bootstrap, and `pulumi stack init` against the self-managed S3 backend. What it does not cover is everything that has to happen *before* the wizard can authenticate at all: creating an IAM principal with the `HyveonDeployAll` permission set. That is still documented as manual console work in `docs/docs/setup.md`.

The hard constraint shaping this design is that **an app with no credentials cannot create credentials**. There is no AWS API that authenticates as the root user; root sign-in is a console-only, MFA-gated human action, and AWS blocks root access keys on newly created accounts. Any "auto setup" therefore has to bounce through a browser session the human already owns. The question is only how much work happens on the human's side of that bounce.

Existing pieces this design builds on:

- `app/packages/shared/src/iamPolicy.ts` — `HYVEON_DEPLOY_ALL_ACTIONS`, the single flattened, deduplicated source of truth for the deploy policy's action set, already assertion-locked against `docs/docs/setup.md` by `iamPolicy.test.ts`. It is a flat list used for `iam:SimulatePrincipalPolicy`, not a per-statement structure — the four-statement shape (`HyveonDeploy` / `HyveonIAM` / `HyveonConfigurationBucket` / `HyveonStateBucket`) exists today only as hand-written JSON in `docs/docs/setup.md`; no code encodes that structure yet, which is exactly the gap the CloudFormation generator fills.
- `app/packages/desktop-main/src/services/IamCheckService.ts` — batched `iam:SimulatePrincipalPolicy` over `HYVEON_DEPLOY_ALL_ACTIONS`, purely advisory today (confirmed against the current source: every result — `passed`/`missing`/`warning` — is non-blocking, matching `docs/docs/setup.md`'s own "never blocks you from continuing").
- `app/packages/desktop-main/src/services/AwsProfileService.ts` + `SafeStorageService` — profile discovery (`listProfiles()`) and keychain-encrypted storage of pasted keys (`savePastedCredentials()`), which hard-fails rather than writing plaintext. Confirmed: no rotation method exists today, so the mint-then-revoke rotation this change adds is genuinely new work, not an extension of something partially built.
- `app/packages/desktop-main/src/services/BootstrapService.ts` — SDK-only, idempotent `created`/`exists`/`failed` resource creation for the state bucket and the configuration bucket. Confirmed against the current source: both `ensureStateBucket()` and `ensureConfigurationBucket()` already call a shared `ensurePublicAccessBlock()` helper (all four block settings) unconditionally after `createBucket()` resolves, on both the fresh-create and already-exists paths — the public-access-block gap the earlier draft of this change targeted is **already closed**, as a side effect of unrelated `migrate-iac-to-pulumi` work. The one asymmetry that remains: `ensureStateBucket()` also calls `PutBucketEncryption` (AES256), `ensureConfigurationBucket()` does not.
- `app/packages/shared/src/wizardSteps.ts` — `WIZARD_STEPS = ['pick-cloud', 'credentials', 'bootstrap', 'stack-init']`, the single source of truth for step ordering, shared between the renderer (`wizard.utils.ts`) and the main process (`FirstRunWizardService`).
- Reconfigure mode is a `mode: 'reconfigure'` prop on the same `FirstRunWizard` component (not a separate step list) — steps in `RECONFIGURE_PRE_COMPLETED_STEPS` (`first-run-wizard.component.tsx`) render collapsed/pre-satisfied with an "Edit" affordance; today that set is `['pick-cloud', 'credentials', 'bootstrap']`, leaving `stack-init` always re-run.

Credential plumbing for the infrastructure engine itself is **out of scope for this change and already fully solved**: `PulumiWorkspaceService.getOrCreateStack()` unconditionally resolves `input.credentialEnvVars ?? resolveCredentialEnvVars(this.store)`, and `PulumiCredentialResolver.resolveCredentialEnvVars()` reads the wizard's active credential source (profile → `AWS_PROFILE`; pasted/guided → `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) and throws `PulumiCredentialsNotConfiguredError` when none is set — there is no ambient-chain fallback to guard against. Whatever credential guided provisioning ends up storing as the active source, the engine already picks it up with zero additional plumbing.

## Goals / Non-Goals

**Goals:**

- An operator with nothing but an AWS account and its console sign-in reaches a bootstrapped Pulumi backend without opening the IAM console's policy editor or `docs/docs/setup.md`.
- The permission set CloudFormation creates is generated from `HYVEON_DEPLOY_ALL_ACTIONS` and the real four-statement shape, so it cannot drift from what `IamCheckService` verifies or what `docs/docs/setup.md` documents.
- No long-lived secret that the app depends on is ever readable from CloudFormation stack history after the wizard completes.

**Non-Goals:**

- IAM Identity Center / SSO device-authorization login. It presupposes Identity Center behind AWS Organizations, which is itself manual setup.
- Programmatic use of root credentials, in any form.
- AWS account creation and Route 53 hosted zone creation.
- Any change to how the infrastructure engine (`PulumiService`/`PulumiWorkspaceService`) resolves credentials — already solved, independent of this change.
- Multi-account or cross-account role assumption.

## Decisions

### Decision 1: CloudFormation console handoff, not SSO or a CLI script

**Chosen:** Generate a CloudFormation template, hand it to the operator's already-authenticated console session, let CloudFormation create the IAM principal.

Alternatives considered:

| Option | Why not |
|---|---|
| IAM Identity Center device-authorization flow (`sso-oidc:RegisterClient` → `StartDeviceAuthorization` → `sso:GetRoleCredentials`) | This is the genuine "log in with an OIDC token" mechanism and produces short-lived credentials with no stored secret — strictly better *if* Identity Center is already enabled. It requires AWS Organizations plus a configured permission set, which is more console work than the manual IAM flow it would replace. Correct as a later additive path for operators who already have it; wrong as the bootstrap path. |
| Root access keys entered into the app | AWS blocks root access keys on new accounts and strongly discourages them elsewhere. A root key in an app's keychain is the worst possible credential to hold. Rejected outright. |
| Ship a shell script the operator runs against their own configured CLI | Presupposes a working `aws configure`, which is the thing being bootstrapped. Also moves the trust boundary to "paste this script into your shell", which is worse than a reviewable CloudFormation template. |
| Keep manual IAM console steps, only improve the docs | Does not address the stated problem. |

CloudFormation wins because the artifact is declarative and reviewable before execution, it is idempotent and deletable as a unit, and it works for a solo account with no Organizations.

### Decision 2: Local template file + console upload, with no hosted template

The AWS API reference for `CreateStack` is explicit: `TemplateURL` "must point to a template (max size: 1 MB) that's located in an Amazon S3 bucket or a Systems Manager document," and S3 static-website URLs are not supported. A raw GitHub URL will not work. A true single-click `?templateURL=` quick-create link would therefore require a project-owned public S3 bucket, published to on every release and kept alive indefinitely, because every new operator's setup would depend on that object resolving.

**Chosen:** the local-file path, as the only path.

1. `GuidedIamService` renders the template and writes it to a known path under the app's `userData` directory.
2. The app opens the CloudFormation **Create stack** console page in the operator's default browser, pre-scoped to the selected region.
3. The wizard step displays the file path with a Copy Path button and a reveal-in-file-manager action, and instructs the operator to choose "Upload a template file".

Rationale: hosting buys the operator exactly one saved file-picker interaction, once, and charges the project a piece of permanently-online public infrastructure tied to a maintainer's personal AWS account, whose failure breaks setup for every new user. The upload flow has to exist regardless as the offline and fallback path, so hosting would be pure addition on top of code that already works. Deliberately **not** built, and no build-time constant or dead branch is carried in anticipation of it — if this is revisited later, the branch is small enough to add then.

**Template file location:** `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`, packaged via `electron-builder.yml`'s `extraResources` (the same mechanism that already ships `build/icon.png` for the Linux window/taskbar icon). Rejected `app/packages/shared/` as the home for the raw template asset: `shared` today ships pure TypeScript only — no binary/static asset ever needs to survive its build step into `out/` or into a packaged app, and adding that plumbing (a bundler copy step, an `extraResources` entry reaching into a different package's source tree) would be new infrastructure with no other consumer. Colocating the template under the `desktop-main` package that owns `GuidedIamService` — its only reader, in both dev and packaged runs — keeps the asset next to its one caller and reuses the packaging mechanism the icon assets already exercise.

### Decision 3: The template creates a user with an access key, and the app immediately rotates it

The template creates:

- `AWS::IAM::ManagedPolicy` — document generated at build time from `HYVEON_DEPLOY_ALL_ACTIONS`, reproducing the real current four-statement structure documented in `docs/docs/setup.md`: `HyveonDeploy` (wildcard service grants, `Resource: "*"`), `HyveonIAM` (scoped to `arn:aws:iam::*:role/hyveon-*` and `.../policy/hyveon-*`), `HyveonConfigurationBucket` (scoped to `${project_name}-tfvars` and its `/*`), and `HyveonStateBucket` (scoped to `${project_name}-tfstate` and its `/*` — `s3:ListBucket`/`GetObject`/`PutObject`/`DeleteObject` plus `PutBucketVersioning`/`PutEncryptionConfiguration`/`PutBucketPublicAccessBlock`; **no DynamoDB action of any kind**, since Pulumi's self-managed S3 backend has no lock table — confirmed no `ensureLockTable`/lock-table identifier survives anywhere in the codebase).
- A second, narrower `AWS::IAM::ManagedPolicy` — `HyveonSelfRotate`, scoped to `arn:aws:iam::*:user/${UserName}` (the same stack parameter naming the created user), granting exactly `iam:CreateAccessKey`, `iam:DeleteAccessKey`, `iam:ListAccessKeys` — the permissions Decision 3's mint-then-revoke rotation needs against the principal the stack itself creates. Not part of `HYVEON_DEPLOY_ALL_ACTIONS`: ordinary deploy principals (profile or pasted-key paths) never rotate their own key, so this permission belongs only to the bootstrap principal the template generates.
- `AWS::IAM::User` — name taken from a stack parameter, defaulting to `hyveon`.
- `AWS::IAM::AccessKey` — with `DeletionPolicy: Retain`.
- Outputs: user name, policy ARN, `AccessKeyId`, and `SecretAccessKey` via `!GetAtt`.

The uncomfortable part is that `SecretAccessKey` lands in stack Outputs, which persist and are readable by anything holding `cloudformation:DescribeStacks`.

**Mitigation, treated as a hard requirement rather than a nicety:** on the first successful authentication with the bootstrap key, the app calls `iam:CreateAccessKey` for itself, writes the new key to the OS keychain via `SafeStorageService`, verifies it with `sts:GetCallerIdentity`, and then calls `iam:DeleteAccessKey` on the bootstrap key. From that moment the value sitting in stack Outputs authenticates nothing. `DeletionPolicy: Retain` on the `AWS::IAM::AccessKey` resource is what keeps a later `DeleteStack` from failing on a key CloudFormation no longer owns.

Alternatives considered:

- **Template creates only the user and policy; operator mints the key by hand.** Removes the secret from Outputs entirely, at the cost of sending the operator into the IAM console's security-credentials tab. Genuinely defensible, and it is the documented fallback — but it gives up the "no console navigation" property that motivates the change. The rotation mitigation closes most of the gap.
- **Template writes the key into Secrets Manager and outputs the secret ARN.** Circular: reading the secret requires credentials the operator does not yet have.
- **AWS::IAM::Role assumed by the desktop app.** A role needs a trusted principal, and there is no principal yet. Circular for the same reason.

Ordering note: rotation must run *before* the IAM permission gate, so that the credential being verified is the one the app will actually keep.

### Decision 4: `IamCheckService` becomes a gate, not an advisory check

Today the bootstrap step's "Check permissions" is non-blocking on every path (confirmed against the current source — there is no notion of credential-source origin in `IamCheckService` today, since guided provisioning doesn't exist yet). After guided provisioning the permission set is known by construction, so a simulation failure means something concrete went wrong — wrong account, partially-failed stack, an SCP denying actions. The check runs automatically after rotation, and a `missing` result blocks progress with the specific denied actions listed and a re-run action.

It stays non-blocking on the manual and profile-picker paths, where an operator may deliberately be running a narrower policy. Warnings (simulation itself unavailable, e.g. `iam:SimulatePrincipalPolicy` denied) never block on any path.

### Decision 5: Close the remaining configuration-bucket encryption gap here

`BootstrapService.ensureStateBucket()` and `ensureConfigurationBucket()` both already call the shared `ensurePublicAccessBlock()` helper unconditionally, so the public-access-block gap an earlier draft of this change targeted is already closed — confirmed by reading the current source, not assumed. One asymmetry remains: `ensureStateBucket()` also enables AES256 default encryption via `PutBucketEncryption`; `ensureConfigurationBucket()` does not, despite holding the same class of configuration data (the versioned `deployment-config.json` object).

**Chosen:** add the same idempotent `PutBucketEncryption` call to `ensureConfigurationBucket()`, applied on the `exists` path as well as `created` (matching the existing `ensurePublicAccessBlock()` pattern) so a bucket created before this change is brought into line the next time bootstrap runs against it.

Scope note: this covers only the buckets `BootstrapService` creates. Tightening the `HyveonDeploy` IAM statement is explicitly a separate change (see Open Questions).

## Risks / Trade-offs

- **Secret access key visible in CloudFormation stack Outputs** → Mandatory mint-then-revoke rotation immediately after first authentication, plus `DeletionPolicy: Retain` so stack deletion still succeeds afterwards. Exposure window is the seconds between stack completion and the operator finishing the wizard step, inside their own account.
- **Operator abandons the wizard between stack creation and rotation** → The bootstrap key stays live and exposed in Outputs. The wizard's resumable progress state records "rotation pending" and the next launch resumes into the rotation step rather than skipping past it; the step also offers an explicit "revoke bootstrap key" action.
- **Rotation partially fails (new key created, old key delete denied)** → Verify the new key with `sts:GetCallerIdentity` *before* deleting the old one, and surface an explicit "bootstrap key still active — revoke it manually" warning with the direct console link if the delete fails. Never leave the operator believing rotation succeeded when it did not.
- **CloudFormation stack creation fails partway** → The permission gate catches it. Report the stack's failure reason by name and offer delete-and-retry rather than a generic error.
- **AWS changes the CloudFormation console URL shape or the create-stack flow** → The console URL is constructed in one place in `GuidedIamService` with a unit test pinning its shape, so a fix is one function.
- **Generated policy drifts from the doc** → `iamPolicy.test.ts` already locks `HYVEON_DEPLOY_ALL_ACTIONS` against `docs/docs/setup.md`; extend it to also assert the generated CloudFormation policy document's four statements match the same source, action-for-action and Sid-for-Sid.
- **Operator picks the wrong region in the console** → The console URL carries the region selected in the wizard. Neither `sts:GetCallerIdentity` (account/identity only, no region) nor `iam:SimulatePrincipalPolicy` (policy evaluation only) can confirm which region the stack actually landed in — the post-rotation gate uses a region-scoped `cloudformation:DescribeStacks` call against the selected region to confirm the stack exists there before bootstrap proceeds.

## Migration Plan

There is no data migration; every existing install already has working credentials.

1. The CloudFormation template plus `GuidedIamService` land first, behind the new wizard step, with the existing profile-picker and paste paths untouched as fallbacks.
2. The configuration-bucket encryption fix (Decision 5) is independent and can land at any point — it has no UI dependency.
3. `docs/docs/setup.md` and `docs/docs/app/first-run-wizard.md` are rewritten last, once the flow is verifiable end to end, retaining the manual IAM steps under an explicit "manual fallback" heading.

**Reconfigure mode:** the guided-IAM step is added to `RECONFIGURE_PRE_COMPLETED_STEPS` alongside `pick-cloud`/`credentials`/`bootstrap` — but pre-completion is gated on persisted evidence that guided provisioning actually ran (a stored deploy-principal record, not merely "credentials are currently configured"); the profile-picker and paste paths leave no such record and must not pre-complete this step. There is no separate `reconfigureSteps()` function; reconfigure mode reuses the same `WIZARD_STEPS` array with a pre-completed-set overlay, and the guided-IAM entry in that overlay is conditional rather than unconditional like its three siblings.

**Rollback:** the guided step is additive. Removing it leaves the profile-picker and paste paths exactly as they are today.

## Resolved Questions

These were open during design and are now decided. Recorded here so the reasoning is not re-litigated during implementation.

### Does the CloudFormation stack also create the Pulumi state bucket?

**No.** The stack provisions IAM only; `BootstrapService` remains the single implementation of the state bucket and configuration bucket.

Folding it in would save the operator one wizard step, once, and cost three things. Operators who skip guided provisioning still need `BootstrapService`, so its logic would have to exist in both places and would drift. The Pulumi state bucket would become a child of a stack with a Delete button, and losing that bucket means Pulumi no longer knows what infrastructure exists — recoverable only by importing every resource by hand. And the bucket names are operator-editable in the bootstrap step today, which as stack parameters would have to be fixed at stack-creation time, before that step is reached.

### Does the release pipeline publish the template to a public S3 object for a one-click link?

**No, and no hook is carried for it.** See Decision 2. The upload flow is the only flow, and the codebase carries no build-time constant or dead branch anticipating hosting.

### Is the `HyveonDeploy` IAM statement tightened here?

**No — deferred to its own change.** The generated policy reproduces today's `HYVEON_DEPLOY_ALL_ACTIONS` and four-statement shape exactly.

Three of the policy's four statements are already scoped: `HyveonIAM` is limited to `arn:aws:iam::*:role/hyveon-*` and `.../policy/hyveon-*`, `HyveonConfigurationBucket` is limited to the two configuration-bucket ARNs, and `HyveonStateBucket` is limited to the two state-bucket ARNs. The fourth, `HyveonDeploy`, grants wildcard actions across roughly a dozen services (`ecs:*`, `elasticfilesystem:*`, `ec2:*`, `lambda:*`, `logs:*`, `cloudwatch:*`, `events:*`, `route53:*`, `ce:*`, `dynamodb:*`, `secretsmanager:*`, `s3:*`, `cloudfront:*`, `acm:*`) on `Resource: "*"`.

That is a real and significant exposure — the deploy key can read any secret, delete any bucket, and terminate any instance in the account — and tightening it is the largest security improvement available in this area. It is nonetheless a separate change because the work is not "swap `*` for an ARN": it requires enumerating the specific actions the infrastructure program needs across every wildcard service, several of which (most `ec2:Describe*`, all of Cost Explorer, much of CloudFront) have no resource-level permission support and must stay at `*`. The only reliable verification is repeated `pulumi up` runs against a real account until denials stop appearing, which is a comparable body of work to this entire change. Bundling them would mean a mid-apply `AccessDenied` could be caused by either the new policy or the new setup flow, with no way to tell which.

Note for that follow-up: tightening does **not** break existing installs. `IamCheckService` simulates the caller's actual attached policy, and a wider policy still passes a narrower simulation — so an operator on today's `Resource: "*"` policy continues to pass the permission gate unchanged.

## Open Questions

None outstanding.
