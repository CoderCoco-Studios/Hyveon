## Context

Hyveon's first-run wizard already covers prerequisites, cloud selection, credential intake, state-bucket/lock-table bootstrap, and `terraform init`. What it does not cover is everything that has to happen *before* the wizard can authenticate at all: creating an IAM principal with the `HyveonDeployAll` permission set, and populating `terraform/terraform.tfvars`. Both are documented as manual console/editor work in `docs/docs/setup.md`.

The hard constraint shaping this design is that **an app with no credentials cannot create credentials**. There is no AWS API that authenticates as the root user; root sign-in is a console-only, MFA-gated human action, and AWS blocks root access keys on newly created accounts. Any "auto setup" therefore has to bounce through a browser session the human already owns. The question is only how much work happens on the human's side of that bounce.

Existing pieces this design builds on:

- `app/packages/shared/src/iamPolicy.ts` — `HYVEON_DEPLOY_ALL_ACTIONS`, already the single source of truth for the deploy policy and already assertion-locked against `docs/docs/setup.md` by `iamPolicy.test.ts`.
- `app/packages/desktop-main/src/services/IamCheckService.ts` — batched `iam:SimulatePrincipalPolicy` over those actions.
- `app/packages/desktop-main/src/services/AwsProfileService.ts` + `SafeStorageService` — profile discovery and keychain-encrypted storage of pasted keys, which hard-fails rather than writing plaintext.
- `app/packages/desktop-main/src/services/BootstrapService.ts` — SDK-only, idempotent `created`/`exists`/`failed` resource creation.
- `TfvarsService` (`app/packages/desktop-main/src/services/TfvarsService.ts`) — already reads and writes `terraform.tfvars`, but only for the `game_servers` map. Writes are **byte-preserving HCL surgery** via `hclSurgeon.ts` (`locateEntry` / `locateMapBody` / `cutEntry` / `replaceEntry`) and `hclEmit.ts` (`emitGameServerEntry`); the file is never regenerated from a parsed model, so everything outside the edited entry survives byte-for-byte. `@cdktf/hcl2json` is used for reading only. Supports a local-file mode and an S3 mode (`RemoteFileStore`) with etag optimistic locking (`OptimisticLockError`).
- `app/packages/shared/src/tfvars.ts` — typed model for a `game_servers` **entry** only. No top-level variable is modelled anywhere.
- `app/packages/shared/src/gameServerValidator.ts` — Zod schema plus business rules (Fargate CPU/memory pairing, absolute container paths, HTTPS port constraints, sibling port collisions), already wired into `GamesWriteService` and the add-game wizard.
- Full `game_servers` CRUD UI already exists (`add-game-wizard/`, `edit-game-form/`, rollback and pending-changes components).
- `@cdktf/hcl2json` — already a dependency, already externalised from the Electron bundle (re-bundling it reintroduces a known Electron quit-hang).

The tfvars gap is therefore much narrower than "the app should own tfvars": per-game editing is done. What remains hand-edited is the **top-level** variable set — `project_name`, `aws_region`, `hosted_zone_name`, and the watchdog knobs — which `docs/docs/setup.md` step 4 still instructs the operator to type into a file.

## Goals / Non-Goals

**Goals:**

- An operator with nothing but an AWS account and its console sign-in reaches `terraform apply` without opening a text editor, the IAM console's policy editor, or `docs/docs/setup.md`.
- The permission set CloudFormation creates is generated from `HYVEON_DEPLOY_ALL_ACTIONS`, so it cannot drift from what `IamCheckService` verifies.
- No long-lived secret that the app depends on is ever readable from CloudFormation stack history after the wizard completes.
- Terraform variables are editable from the app both during first run and afterwards, with the same typed model behind both.
- The credentials the operator chooses actually reach the `terraform` subprocess.

**Non-Goals:**

- IAM Identity Center / SSO device-authorization login. It presupposes Identity Center behind AWS Organizations, which is itself manual setup.
- Programmatic use of root credentials, in any form.
- AWS account creation and Route 53 hosted zone creation.
- Replacing or reworking the existing `game_servers` read/write path, its CRUD UI, or `gameServerValidator`. All of that already works and is extended, not touched.
- A general-purpose HCL serializer. Writes stay byte-preserving splices.
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

### Decision 3: The template creates a user with an access key, and the app immediately rotates it

The template creates:

- `AWS::IAM::ManagedPolicy` — document generated at build time from `HYVEON_DEPLOY_ALL_ACTIONS`, preserving the existing `HyveonDeploy` / `HyveonIAM` / `HyveonTfvarsBucket` statement structure.
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

Today the bootstrap step's "Check permissions" is non-blocking. After guided provisioning the permission set is known by construction, so a simulation failure means something concrete went wrong — wrong account, partially-failed stack, an SCP denying actions. The check runs automatically after rotation, and a `missing` result blocks progress with the specific denied actions listed and a re-run action.

It stays non-blocking on the manual and profile-picker paths, where an operator may deliberately be running a narrower policy. Warnings (simulation itself unavailable, e.g. `iam:SimulatePrincipalPolicy` denied) never block on any path.

### Decision 5: Extend the existing `TfvarsService` surgery approach to top-level variables

`TfvarsService` already solves this problem correctly for `game_servers`, and the existing approach is better than regenerating the file from a model: writes locate the exact byte range of the target and splice it, so comments, ordering, and formatting everywhere else survive untouched. Regenerating from a parsed model would lose all of that, and `@cdktf/hcl2json` has no serializer to make a faithful round trip possible anyway.

**Chosen:** extend, do not replace.

- **Model:** add a top-level variable model to `app/packages/shared/src/tfvars.ts` alongside the existing `GameServer` types — `project_name`, `aws_region`, `hosted_zone_name`, and the watchdog knobs. The `game_servers` model stays exactly as it is.
- **Read:** a `getTopLevelVars()` sibling to the existing `getGameServers()`, reusing the same `fetchRawTfvars()` source resolution (S3 mode when `ConfigService.getTfvarsBucket()` is set, local file otherwise) and the same TTL cache.
- **Write:** a `setTopLevelVar()` / `setTopLevelVars()` sibling to `addGameServer()` / `updateGameServer()`, extending `hclSurgeon.ts` with attribute-level locate-and-replace (the existing helpers target map entries) and `hclEmit.ts` with scalar attribute emission. Insert-if-absent must append in a deterministic position rather than anywhere.
- **Safety:** reuse what already exists — S3 mode keeps its etag optimistic locking and `OptimisticLockError`; both modes route through the existing `writeTfvars()` / `putRawTfvars()` path so there is exactly one write path.

**Deliberately not carried over from the earlier draft:** a passthrough bag for unknown keys (unnecessary — byte-preserving surgery never drops anything), a `# Managed by Hyveon` header (the file is not managed wholesale), a `terraform.tfvars.bak` copy on every write in S3 mode (object versioning already provides history), and any "comments will be lost" confirmation (they will not be lost).

**One genuine gap worth closing:** local mode is an unguarded `writeFileSync` with no versioning and no locking, where S3 mode has both. A `.bak` copy immediately before the splice, in local mode only, gives local operators a single-step undo without touching the S3 path's semantics.

Alternative considered: a general HCL writer that regenerates the whole file from a complete model. Rejected — it discards the byte-preservation property the current implementation deliberately bought, and would regress per-game editing that already works.

### Decision 6: Terraform subprocess credentials come from the resolved chain, exported as env

`TerraformService.spawnAndStream()` currently calls `spawn(binaryPath, args, { cwd })` with no `env`, so the child inherits the Electron process environment and resolves credentials via the ambient default chain — not the profile or pasted keys the wizard selected. An operator on the pasted-keys path therefore has credentials that work for bootstrap and IAM simulation but not for `terraform apply`.

**Chosen:** a single `resolveTerraformEnv()` helper that returns `{ ...process.env, AWS_REGION, ... }` plus either `AWS_PROFILE` (profile path) or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (pasted and guided paths, read from the keychain at spawn time), and is applied by every terraform invocation.

Alternative considered: writing a managed profile into `~/.aws/credentials` and always passing `AWS_PROFILE`. Rejected — it puts plaintext secrets on disk, which the existing `SafeStorageService` design deliberately refuses to do.

Secrets must never appear in the streamed terraform logs; the existing log sanitiser needs to cover the new env values.

### Decision 7: Close the state-bucket public-access-block gap here

`BootstrapService.ensureStateBucket()` and `ensureTfvarsBucket()` create buckets with versioning and AES256 encryption but never call `PutPublicAccessBlock`, while `terraform/bootstrap/main.tf` — the manual fallback that creates the same tfvars bucket — does set all four block settings. The SDK path is therefore strictly weaker than the Terraform path it mirrors, and it is the path every wizard user takes.

**Chosen:** fix it in this change rather than filing it separately. This change is the one that makes guided setup the default route to bucket creation, so shipping it would otherwise widen the blast radius of the very flow being introduced. The fix is a single additional idempotent SDK call per bucket, mirroring the four settings the Terraform module already uses, and it needs no coordination with anything else here.

Scope note: this covers only the buckets `BootstrapService` creates. Tightening the `HyveonDeploy` IAM statement is explicitly a separate change (see Open Questions).

## Risks / Trade-offs

- **Secret access key visible in CloudFormation stack Outputs** → Mandatory mint-then-revoke rotation immediately after first authentication, plus `DeletionPolicy: Retain` so stack deletion still succeeds afterwards. Exposure window is the seconds between stack completion and the operator finishing the wizard step, inside their own account.
- **Operator abandons the wizard between stack creation and rotation** → The bootstrap key stays live and exposed in Outputs. The wizard's resumable progress state records "rotation pending" and the next launch resumes into the rotation step rather than skipping past it; the step also offers an explicit "revoke bootstrap key" action.
- **Rotation partially fails (new key created, old key delete denied)** → Verify the new key with `sts:GetCallerIdentity` *before* deleting the old one, and surface an explicit "bootstrap key still active — revoke it manually" warning with the direct console link if the delete fails. Never leave the operator believing rotation succeeded when it did not.
- **CloudFormation stack creation fails partway** → The permission gate catches it. Report the stack's failure reason by name and offer delete-and-retry rather than a generic error.
- **Attribute-level HCL surgery corrupts the file** → The existing surgeon targets map entries; top-level scalar attributes are a new locate-and-splice case (quoting, heredocs, inline comments trailing an attribute, an attribute absent entirely). Cover each with fixture-driven tests before wiring any UI, and reuse the existing `restoreRawTfvars()` rollback path on failure.
- **Local-mode write has no versioning or locking, unlike S3 mode** → Add a `.bak` copy immediately before the splice in local mode only, leaving S3 mode's etag optimistic locking untouched.
- **Concurrent edits in S3 mode** → Already handled by the existing `ifMatch` etag check surfacing `OptimisticLockError`; the new top-level write path must route through the same `writeTfvars()` so it inherits that rather than bypassing it.
- **`@cdktf/hcl2json` re-bundled into the Electron main bundle** → Reintroduces the known quit-hang that made every Electron e2e teardown time out. The rollup `external` entry and electron-builder `files` entry must stay; worth an explicit check in the task list.
- **AWS changes the CloudFormation console URL shape or the create-stack flow** → The console URL is constructed in one place in `GuidedIamService` with a unit test pinning its shape, so a fix is one function.
- **Generated policy drifts from the doc** → `iamPolicy.test.ts` already locks `HYVEON_DEPLOY_ALL_ACTIONS` against `docs/docs/setup.md`; extend it to also assert the generated CloudFormation policy document matches the same source.
- **Operator picks the wrong region in the console** → The console URL carries the region selected in the wizard, and the post-rotation `sts:GetCallerIdentity` plus permission gate confirm account and region before bootstrap proceeds.

## Migration Plan

There is no data migration; every existing install already has working credentials.

1. `TfvarsService` and the terraform-env fix land first — both are independently useful and carry no UI dependency.
2. The CloudFormation template plus `GuidedIamService` land next, behind the new wizard step, with the existing profile-picker and paste paths untouched as fallbacks.
3. `docs/docs/setup.md` is rewritten last, once the flow is verifiable end to end, retaining the manual IAM steps under an explicit "manual fallback" heading.

**Reconfigure mode:** the guided-IAM step is omitted from `reconfigureSteps()` (an existing install already has a principal); the deployment-settings step is included, since editing tfvars after first run is a primary use case.

**Rollback:** the guided step is additive. Removing it leaves the profile-picker and paste paths exactly as they are today. The terraform-env change is the only behavioural change to an existing path and is independently revertable.

## Resolved Questions

These were open during design and are now decided. Recorded here so the reasoning is not re-litigated during implementation.

### Does the CloudFormation stack also create the Terraform state bucket and lock table?

**No.** The stack provisions IAM only; `BootstrapService` remains the single implementation of the state bucket, lock table, and tfvars bucket.

Folding them in would save the operator one wizard step, once, and cost three things. Operators who skip guided provisioning still need `BootstrapService`, so its logic would have to exist in both places and would drift. The Terraform state bucket would become a child of a stack with a Delete button, and losing that bucket means Terraform no longer knows what infrastructure exists — recoverable only by importing every resource by hand. And the three resource names are operator-editable in the bootstrap step today, which as stack parameters would have to be fixed at stack-creation time, before that step is reached.

### Does the release pipeline publish the template to a public S3 object for a one-click link?

**No, and no hook is carried for it.** See Decision 2. The upload flow is the only flow, and the codebase carries no build-time constant or dead branch anticipating hosting.

### Is the `HyveonDeploy` IAM statement tightened here?

**No — deferred to its own change.** The generated policy reproduces today's `HYVEON_DEPLOY_ALL_ACTIONS` exactly.

Two of the policy's three statements are already scoped: `HyveonIAM` is limited to `arn:aws:iam::*:role/hyveon-*` and `.../policy/hyveon-*`, and `HyveonTfvarsBucket` is limited to the tfvars bucket. The third, `HyveonDeploy`, grants wildcard actions across thirteen services (`ecs:*`, `ec2:*`, `s3:*`, `lambda:*`, `dynamodb:*`, `secretsmanager:*`, `route53:*`, `logs:*`, `cloudwatch:*`, `events:*`, `cloudfront:*`, `ce:*`, `elasticfilesystem:*`) on `Resource: "*"`.

That is a real and significant exposure — the deploy key can read any secret, delete any bucket, and terminate any instance in the account — and tightening it is the largest security improvement available in this area. It is nonetheless a separate change because the work is not "swap `*` for an ARN": it requires enumerating the specific actions the Terraform module needs across all thirteen services, several of which (most `ec2:Describe*`, all of Cost Explorer, much of CloudFront) have no resource-level permission support and must stay at `*`. The only reliable verification is repeated `terraform apply` runs against a real account until denials stop appearing, which is a comparable body of work to this entire change. Bundling them would mean a mid-apply `AccessDenied` could be caused by either the new policy or the new setup flow, with no way to tell which.

Note for that follow-up: tightening does **not** break existing installs. `IamCheckService` simulates the caller's actual attached policy, and a wider policy still passes a narrower simulation — so an operator on today's `Resource: "*"` policy continues to pass the permission gate unchanged.

## Open Questions

None outstanding.
