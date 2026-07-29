## Why

Getting from a fresh clone to a deployed cluster currently requires roughly fifteen manual steps performed outside the app: create an IAM user in the AWS console, hand-paste the `HyveonDeployAll` inline policy JSON out of `docs/docs/setup.md`, mint an access key, run `aws configure`, then hand-edit `terraform/terraform.tfvars` in a text editor. Every one of those steps is a place a new operator can mistype a policy action, skip a permission, or land on a stale copy of the doc — and none of them are things the desktop app is unable to drive itself.

The app already owns the rest of the flow (prerequisite detection, bootstrap of the state bucket and lock table, `terraform init`), so the manual prologue is the last remaining "leave the app and follow a wiki page" segment. This change closes it: the operator signs into the AWS console once in their browser (root sign-in is fine — it is their own browser session, not a credential the app ever touches), clicks a single pre-filled CloudFormation stack, and returns to the wizard with everything else generated for them.

## What Changes

### Guided IAM provisioning (replaces manual console work)

- Ship a CloudFormation template (`terraform/bootstrap/iam-bootstrap.yaml`) that creates the deploy IAM user, a customer-managed `HyveonDeployAll` policy generated from the **same** `HYVEON_DEPLOY_ALL_ACTIONS` source of truth in `@hyveon/shared`, and a bootstrap access key.
- Add a wizard step that opens the AWS CloudFormation console pre-loaded with that template, waits for the operator, and accepts the resulting Access Key ID / Secret Access Key.
- **Immediately rotate on first use**: once the pasted bootstrap key authenticates, the app mints its own access key via `iam:CreateAccessKey`, stores it in the OS keychain, and deletes the bootstrap key — so the secret exposed in the CloudFormation stack Outputs is dead within seconds of the wizard finishing.
- Keep the existing "pick a profile" and "paste your own keys" paths intact as alternatives; guided setup becomes the default, not the only, option.

### App-owned top-level Terraform settings (replaces hand-editing `terraform.tfvars`)

Per-game editing is already solved: `TfvarsService` reads and writes the `game_servers` map through byte-preserving HCL surgery, `gameServerValidator` enforces the business rules, and a full CRUD UI exists. What remains hand-edited is the top-level variable set, which `docs/docs/setup.md` step 4 still instructs the operator to type into a file.

- Extend `app/packages/shared/src/tfvars.ts` with a typed model for the top-level variables — `project_name`, `aws_region`, `hosted_zone_name`, and the watchdog knobs — alongside the existing `GameServer` types.
- Extend `TfvarsService` with `getTopLevelVars()` / `setTopLevelVars()` siblings to the existing game-server methods, reusing the same source resolution (S3 or local), the same cache, and the same single write path so S3 mode inherits its etag optimistic locking.
- Extend `hclSurgeon.ts` with attribute-level locate-and-splice and `hclEmit.ts` with scalar attribute emission. Writes stay byte-preserving — comments, ordering and formatting outside the edited attribute are untouched.
- New wizard step and matching Settings page section for the top-level variables. The `game_servers` map continues to be edited through the existing game UI, unchanged.
- Close one real gap: local mode currently writes via an unguarded `writeFileSync` with no versioning or locking, where S3 mode has both. Add a `.bak` copy immediately before the splice, in local mode only.

### State-bucket hardening

- `BootstrapService` creates the Terraform state bucket and the tfvars bucket without a public access block, while `terraform/bootstrap/main.tf` — the manual fallback covering the same tfvars bucket — sets all four block settings. Add the missing `PutPublicAccessBlock` call to both, so the SDK path is no weaker than the Terraform path it mirrors. This change makes the SDK path the default route to bucket creation, so it is the right place to close the gap.

### Credential plumbing fix

- `TerraformService.spawnAndStream()` currently passes no `env` to the `terraform` child process, so terraform silently resolves credentials from the ambient AWS chain rather than the profile or pasted keys the operator selected in the wizard. Inject the resolved credentials (or `AWS_PROFILE`) plus region into the subprocess environment. Without this the guided flow dead-ends: the keys CloudFormation creates would never reach `terraform apply`.

### Documentation

- `docs/docs/setup.md` steps 1–2 collapse from manual IAM instructions to "run the app and follow the wizard", with the manual path retained as an explicitly-labelled fallback. The `HyveonDeployAll` policy JSON stays in the doc as the canonical human-readable reference, still assertion-locked to `@hyveon/shared` by `iamPolicy.test.ts`.

### Explicitly out of scope

- **IAM Identity Center / SSO device-authorization login.** It is the only true "log in to AWS with an OIDC token" mechanism, but it presupposes Identity Center is already enabled behind AWS Organizations — which is itself the manual setup this change exists to remove. Deferred to a follow-up for operators who already have it.
- **Anything using root credentials programmatically.** AWS provides no API to authenticate as the root user, and root access keys are blocked on new accounts. The root email is only ever used by the human, in their browser, to sign into the console.
- **Tightening the `HyveonDeploy` IAM statement.** The generated policy reproduces `HYVEON_DEPLOY_ALL_ACTIONS` exactly as it stands today, including its thirteen wildcard service grants on `Resource: "*"`. Narrowing that is the largest security improvement available in this area, but it requires enumerating the specific actions the Terraform module needs across all thirteen services and verifying them by repeated real `terraform apply` runs — a body of work comparable to this entire change, and one whose failures would be indistinguishable from setup-flow failures if bundled. Its own change.
- **Hosting the CloudFormation template for a one-click quick-create link.** AWS requires `TemplateURL` to resolve to an S3 object, so this would mean permanently-online public infrastructure in a maintainer's account that every new operator's setup depends on. The console upload flow is the only flow, and no hook is carried for hosting.
- Collapsing `BootstrapService` into the CloudFormation stack. The stack provisions IAM only.
- Creating the AWS account itself, and Route 53 hosted zone creation.

## Capabilities

### New Capabilities

- `guided-iam-provisioning`: CloudFormation-template-driven creation of the deploy IAM user and policy, the console deep-link handoff, intake of the resulting bootstrap key, and the mint-then-revoke rotation that retires it.
- `terraform-settings-management`: Reading, validating, and byte-preservingly editing the **top-level** variables in `terraform/terraform.tfvars`, so no Terraform variable requires hand-editing a file. Complements the existing `game_servers` read/write path rather than replacing it.

### Modified Capabilities

- `wizard-flow`: The step list gains a guided-IAM step ahead of credentials and a deployment-settings step ahead of `terraform init`; both must participate in the existing resumable-progress and reconfigure-mode behaviour.
- `aws-credentials`: Credential intake gains the guided path and the rotation requirement, and resolved credentials must now be exported into the Terraform subprocess environment rather than being used only by in-process SDK clients.
- `cloud-bootstrap`: IAM permission simulation moves from an advisory post-hoc check to a verification gate run immediately after guided provisioning, so a mis-provisioned stack is caught before bootstrap rather than after; and bucket creation gains a public-access-block requirement.

## Impact

**Code**

- `app/packages/desktop-main/src/services/` — new `GuidedIamService`; changes to `TfvarsService` (top-level variable read/write), `hclSurgeon.ts` and `hclEmit.ts` (attribute-level splice and emission), `AwsProfileService` (key rotation, keychain write), `TerraformService` (subprocess `env`), `BootstrapService` (public access block), `IamCheckService` (gate semantics).
- `app/packages/desktop-main/src/controllers/wizard.controller.ts` — new IPC channels for template URL generation, key intake, rotation, and tfvars read/write.
- `app/packages/web/src/components/first-run-wizard/` — two new step components plus step-list changes in `wizard.utils.ts`; `settings.page.tsx` gains the Terraform settings section.
- `app/packages/shared/src/` — `wizardSteps.ts` additions; `iamPolicy.ts` becomes the generator input for the CloudFormation policy document; `tfvars.ts` gains top-level variable types.
- `app/packages/desktop-preload/src/preload.ts` — bridge surface for the new channels.

**Infrastructure / assets**

- New `terraform/bootstrap/iam-bootstrap.yaml` CloudFormation template, shipped inside the packaged app and written to disk at runtime for the console upload path.

**Dependencies**

- No new runtime dependencies expected; `@cdktf/hcl2json` is already present (and already externalised from the Electron bundle — that constraint must hold, see the known quit-hang regression).

**Security**

- The bootstrap access key secret is briefly visible in CloudFormation stack Outputs inside the operator's own account. The mandatory rotate-and-revoke step is what makes this acceptable and is a hard requirement, not an optimisation.
- The app must never write credentials to disk unencrypted; the existing `SafeStorageService` keychain requirement continues to apply to every new storage path.

**Documentation**

- `docs/docs/setup.md` (steps 1–2 and the manual-fallback section), `docs/docs/components/terraform.md` (variables now app-editable), `CLAUDE.md` (setup narrative).
