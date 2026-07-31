## Why

Getting from a fresh clone to a deployed cluster still requires manual work outside the app: create an IAM user in the AWS console, hand-paste the `HyveonDeployAll` inline policy JSON out of `docs/docs/setup.md`, and mint an access key before the wizard can even start. Every one of those steps is a place a new operator can mistype a policy action, skip a permission, or land on a stale copy of the doc — and none of them are things the desktop app is unable to drive itself.

The app already owns the rest of the flow (prerequisite detection, bootstrap of the state bucket and configuration bucket via the AWS SDK, Pulumi engine provisioning, `pulumi stack init`), so the manual IAM prologue is the last remaining "leave the app and follow a wiki page" segment. This change closes it: the operator signs into the AWS console once in their browser (root sign-in is fine — it is their own browser session, not a credential the app ever touches), clicks a single pre-filled CloudFormation stack, and returns to the wizard with the deploy principal generated for them.

## What Changes

### Guided IAM provisioning (replaces manual console work)

- Ship a CloudFormation template (`app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`) that creates the deploy IAM user, a customer-managed `HyveonDeployAll` policy generated from the **same** `HYVEON_DEPLOY_ALL_ACTIONS` source of truth in `@hyveon/shared` (`app/packages/shared/src/iamPolicy.ts`), and a bootstrap access key. The generated policy reproduces the real current four-statement structure documented in `docs/docs/setup.md` — `HyveonDeploy` (the wildcard service grants), `HyveonIAM` (scoped to `hyveon-*` roles/policies), `HyveonConfigurationBucket` (scoped to the `${project_name}-tfvars` configuration bucket), and `HyveonStateBucket` (scoped to the `${project_name}-tfstate` bucket that backs Pulumi's self-managed S3 state backend — `s3:ListBucket`/`GetObject`/`PutObject`/`DeleteObject` plus the three bucket-hardening actions, and **no DynamoDB lock-table actions**, since Pulumi's DIY S3 backend has no lock table).
- Add a wizard step that opens the AWS CloudFormation console pre-loaded with that template, waits for the operator, and accepts the resulting Access Key ID / Secret Access Key.
- **Immediately rotate on first use**: once the pasted bootstrap key authenticates, the app mints its own access key via `iam:CreateAccessKey`, stores it in the OS keychain, and deletes the bootstrap key — so the secret exposed in the CloudFormation stack Outputs is dead within seconds of the wizard finishing.
- Keep the existing "pick a profile" and "paste your own keys" paths intact as alternatives; guided setup becomes the default, not the only, option.

### State-bucket hardening (one remaining gap)

`BootstrapService.ensureStateBucket()` and `ensureConfigurationBucket()` both already apply all four S3 public-access-block settings and bucket versioning — that hardening work landed as part of `migrate-iac-to-pulumi` and needs no further action here. The one gap still open: `ensureStateBucket()` enables AES256 default encryption (`PutBucketEncryption`) but `ensureConfigurationBucket()` does not, even though it holds the same class of configuration data. Add the same idempotent `PutBucketEncryption` call to `ensureConfigurationBucket()`, applied on the `exists` path as well as `created` so buckets provisioned before this change are brought into line.

### Documentation

- `docs/docs/setup.md`'s "1. Create and authorise an IAM user" section collapses to "run the app and follow the wizard", with the manual console path retained as an explicitly-labelled fallback. The `HyveonDeployAll` policy JSON stays in the doc as the canonical human-readable reference, still assertion-locked to `@hyveon/shared` by `iamPolicy.test.ts`.
- `docs/docs/setup.md`'s "2. Clone, install, and launch the wizard" section and `docs/docs/app/first-run-wizard.md` both currently describe a **four**-step wizard (`pick-cloud` → `credentials` → `bootstrap` → `stack-init`, `Step N of 4`); both need updating to five steps once the guided-IAM step is inserted.

### Explicitly out of scope

- **IAM Identity Center / SSO device-authorization login.** It is the only true "log in to AWS with an OIDC token" mechanism, but it presupposes Identity Center is already enabled behind AWS Organizations — which is itself the manual setup this change exists to remove. Deferred to a follow-up for operators who already have it.
- **Anything using root credentials programmatically.** AWS provides no API to authenticate as the root user, and root access keys are blocked on new accounts. The root email is only ever used by the human, in their browser, to sign into the console.
- **Tightening the `HyveonDeploy` IAM statement.** The generated policy reproduces `HYVEON_DEPLOY_ALL_ACTIONS` exactly as it stands today, including its wildcard service grants on `Resource: "*"` in the `HyveonDeploy` statement (the other three statements — `HyveonIAM`, `HyveonConfigurationBucket`, `HyveonStateBucket` — are already ARN-scoped). Narrowing `HyveonDeploy` is the largest security improvement available in this area, but it requires enumerating the specific actions the infrastructure program needs across every wildcard service and verifying them by repeated real `pulumi up` runs — a body of work comparable to this entire change, and one whose failures would be indistinguishable from setup-flow failures if bundled. Its own change.
- **Hosting the CloudFormation template for a one-click quick-create link.** AWS requires `TemplateURL` to resolve to an S3 object, so this would mean permanently-online public infrastructure in a maintainer's account that every new operator's setup depends on. The console upload flow is the only flow, and no hook is carried for hosting.
- Collapsing `BootstrapService` into the CloudFormation stack. The stack provisions IAM only.
- Creating the AWS account itself, and Route 53 hosted zone creation.

## Capabilities

### New Capabilities

- `guided-iam-provisioning`: CloudFormation-template-driven creation of the deploy IAM user and policy, the console deep-link handoff, intake of the resulting bootstrap key, and the mint-then-revoke rotation that retires it.

### Modified Capabilities

- `wizard-flow`: The step list gains a guided-IAM step ahead of credentials, which must participate in the existing resumable-progress and reconfigure-mode behaviour.
- `aws-credentials`: Credential intake gains the guided path and the in-app rotation requirement.
- `cloud-bootstrap`: IAM permission simulation moves from an advisory post-hoc check to a verification gate run immediately after guided provisioning, so a mis-provisioned stack is caught before bootstrap rather than after; and the configuration bucket gains the same default-encryption requirement the state bucket already has (public-access-block is already applied to both buckets and needs no further change).

## Impact

**Code**

- `app/packages/desktop-main/src/services/` — new `GuidedIamService`; changes to `AwsProfileService` (key rotation, keychain write), `BootstrapService` (configuration-bucket encryption), `IamCheckService` (gate semantics).
- `app/packages/desktop-main/src/controllers/wizard.controller.ts` — new IPC channels for template preparation, console open, bootstrap-key intake, rotation, and revoke.
- `app/packages/web/src/components/first-run-wizard/` — one new step component plus step-list changes in `wizard.utils.ts` / `first-run-wizard.component.tsx`.
- `app/packages/shared/src/` — `wizardSteps.ts` gains the guided-IAM step; `iamPolicy.ts` (`HYVEON_DEPLOY_ALL_ACTIONS`) becomes the generator input for the CloudFormation policy document.
- `app/packages/desktop-preload/src/preload.ts` — bridge surface for the new channels.

Credential resolution for every real Pulumi invocation (`PulumiService` via `PulumiWorkspaceService.getOrCreateStack()`) already reads the wizard's active credential source unconditionally through `PulumiCredentialResolver.resolveCredentialEnvVars()` — nothing in this change touches that path; it needs no new credential plumbing to reach the guided-provisioning-minted key, since that key becomes the active credential source through the existing `ElectronStoreService` state the resolver already reads.

**Infrastructure / assets**

- New `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml` CloudFormation template, shipped inside the packaged app (`electron-builder.yml` `extraResources`) and written to disk at runtime for the console upload path.

**Dependencies**

- No new runtime dependencies expected.

**Security**

- The bootstrap access key secret is briefly visible in CloudFormation stack Outputs inside the operator's own account. The mandatory rotate-and-revoke step is what makes this acceptable and is a hard requirement, not an optimisation.
- The app must never write credentials to disk unencrypted; the existing `SafeStorageService` keychain requirement continues to apply to every new storage path.

**Documentation**

- `docs/docs/setup.md` (the "Create and authorise an IAM user" section and the manual-fallback heading, plus the wizard step-count reference in "Clone, install, and launch the wizard"), `docs/docs/app/first-run-wizard.md` (step count and step table).
