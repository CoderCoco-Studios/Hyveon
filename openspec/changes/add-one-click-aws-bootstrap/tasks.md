## 1. Terraform subprocess credentials (independent, ships first)

- [ ] 1.1 Add a `resolveTerraformEnv()` helper in `desktop-main` that returns the child-process environment for a terraform spawn: base `process.env` plus `AWS_REGION`, and either `AWS_PROFILE` (profile source) or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` read from the keychain at call time (pasted/guided source)
- [ ] 1.2 Make `resolveTerraformEnv()` throw an explicit "credentials not configured" error when no active credential source is stored, rather than returning a bare environment
- [ ] 1.3 Wire the helper into `TerraformService.spawnAndStream()` so every terraform invocation (`init`/`plan`/`apply`/`destroy`/`output`) receives the resolved environment
- [ ] 1.4 Extend the terraform log sanitiser so access key IDs and secret access keys are redacted from both the streamed UI output and the application log
- [ ] 1.5 Unit tests: profile source sets `AWS_PROFILE`; keychain source sets key/secret; missing source throws; sanitiser strips credential values from a log line containing them

## 2. Top-level tfvars variables (extends the existing TfvarsService)

- [ ] 2.1 Add a top-level variable model to `app/packages/shared/src/tfvars.ts` — `project_name`, `aws_region`, `hosted_zone_name`, watchdog knobs — alongside the existing `GameServer` types, leaving those untouched
- [ ] 2.2 Add validation for the top-level model: non-empty conforming `project_name`, valid `aws_region` identifier, valid DNS `hosted_zone_name`, in-range watchdog values — returning per-field errors, not a boolean. Do not duplicate `gameServerValidator`
- [ ] 2.3 Extend `hclSurgeon.ts` with attribute-level locate-and-splice for top-level scalar attributes (the existing helpers target map entries), including the absent-attribute insert case at a deterministic position
- [ ] 2.4 Extend `hclEmit.ts` with scalar attribute emission, reusing the existing identifier and quoting rules
- [ ] 2.5 Add `getTopLevelVars()` to `TfvarsService`, reusing `fetchRawTfvars()` source resolution (S3 vs local) and the existing TTL cache
- [ ] 2.6 Add `setTopLevelVars()` routed through the existing `writeTfvars()` / `putRawTfvars()` path so S3 mode inherits etag optimistic locking unchanged
- [ ] 2.7 Add a `.bak` copy immediately before the splice in local-file mode only; leave S3 mode's semantics untouched
- [ ] 2.8 Return model defaults for a missing file; report a named parse error (never defaults) for a malformed one
- [ ] 2.9 Fixture-driven tests for the surgery edge cases before any UI is wired: attribute with a trailing inline comment, quoted vs unquoted values, heredoc neighbours, absent attribute, and a file with a populated `game_servers` map that must come through byte-identical
- [ ] 2.10 Unit tests: S3 vs local read source, optimistic-lock error on stale etag, `.bak` written in local mode and absent in S3 mode, validation blocks the write and names the field, rollback restores on failed splice

## 3. CloudFormation template generation

- [ ] 3.1 Add a generator that builds the managed-policy document from `HYVEON_DEPLOY_ALL_ACTIONS`, preserving the `HyveonDeploy` / `HyveonIAM` / `HyveonTfvarsBucket` statement structure
- [ ] 3.2 Author `terraform/bootstrap/iam-bootstrap.yaml` with `AWS::IAM::ManagedPolicy`, `AWS::IAM::User` (name from a stack parameter defaulting to `hyveon`), and `AWS::IAM::AccessKey` carrying `DeletionPolicy: Retain`
- [ ] 3.3 Add stack outputs for user name, policy ARN, access key ID, and secret access key
- [ ] 3.4 Extend `iamPolicy.test.ts` to assert the generated CloudFormation policy document matches `HYVEON_DEPLOY_ALL_ACTIONS` exactly, alongside the existing `docs/docs/setup.md` assertion
- [ ] 3.5 Include the template in the packaged app's resources and confirm it resolves at runtime from both a dev run and a packaged build

## 4. GuidedIamService (main process)

- [ ] 4.1 Implement template rendering plus writing the template to a known path under `userData`, returning that path
- [ ] 4.2 Implement CloudFormation console URL construction in a single function, region-scoped, with a unit test pinning the URL shape
- [ ] 4.3 Implement browser launch with a graceful fallback that returns the URL as text when launching fails
- [ ] 4.4 Implement bootstrap key intake: validate via `sts:GetCallerIdentity`, record the account ID, reject invalid credentials with the underlying AWS error, and never persist an unvalidated secret
- [ ] 4.5 Implement rotation: `iam:CreateAccessKey` → safeStorage persist → `sts:GetCallerIdentity` verify → `iam:DeleteAccessKey` on the bootstrap key, in that order
- [ ] 4.6 Handle the rotation failure modes distinctly — verification failure leaves the bootstrap key intact and retries; deletion failure reports "bootstrap key still active" with a console link and does not report success
- [ ] 4.7 Refuse all credential storage when `SafeStorageService` reports encryption unavailable, directing the operator to the alternative paths
- [ ] 4.8 Ensure no code path logs the secret access key
- [ ] 4.9 Unit tests for each of 4.4–4.8, with `aws-sdk-client-mock` covering the IAM/STS calls

## 5. Credential rotation in AwsProfileService

- [ ] 5.1 Add a rotation method to `AwsProfileService` that replaces the stored key for the active credential source using the verify-before-delete ordering
- [ ] 5.2 Ensure a failed verification leaves the previously stored key active and in the keychain
- [ ] 5.3 Unit tests for successful rotation and for verification failure preserving the old key

## 6. State-bucket hardening

- [ ] 6.1 Add an idempotent `PutPublicAccessBlock` call (all four settings enabled) to `BootstrapService.ensureStateBucket()`, mirroring `terraform/bootstrap/main.tf`
- [ ] 6.2 Add the same call to `BootstrapService.ensureTfvarsBucket()`
- [ ] 6.3 Apply the block on the `exists` path as well as `created`, so buckets provisioned before this change are brought into line without changing the reported status
- [ ] 6.4 Report a denied or failed `PutPublicAccessBlock` as a bootstrap `failed` result carrying the underlying error, never as success
- [ ] 6.5 Add AES256 encryption to `ensureTfvarsBucket()` — the state bucket sets it, the tfvars bucket currently sets neither encryption nor a public access block despite holding the same configuration data
- [ ] 6.6 Unit tests: block applied on create, applied on pre-existing bucket while still reporting `exists`, failure surfaced as `failed`, and tfvars bucket encryption configured

## 7. IAM permission gate

- [ ] 7.1 Extend `IamCheckService` results to carry the credential-source origin so callers can decide gating
- [ ] 7.2 Make a `missing` result block progression on the guided path, listing denied actions with a re-run action
- [ ] 7.3 Keep `missing` advisory on the profile-picker and paste paths, and keep `warning` non-blocking on every path
- [ ] 7.4 Run the gate automatically after rotation, against the rotated key
- [ ] 7.5 Unit tests covering all four combinations of (guided, manual) × (missing, warning)

## 8. IPC surface

- [ ] 8.1 Add `wizard.guidedIam.*` channels to `wizard.controller.ts`: prepare template, open console, submit bootstrap key, rotate, revoke bootstrap key
- [ ] 8.2 Add `wizard.tfvars.*` channels for the top-level variables: read, validate, write
- [ ] 8.3 Expose both namespaces on the preload bridge in `desktop-preload/src/preload.ts`
- [ ] 8.4 Confirm no channel returns a secret value to the renderer; intake is renderer→main only
- [ ] 8.5 Integration specs (tier 2) dispatching the new controller methods through the real `AppModule` container

## 9. Wizard UI

- [ ] 9.1 Add the guided-IAM step to `wizardSteps.ts` in `@hyveon/shared`, positioned between pick-cloud and credentials
- [ ] 9.2 Add the deployment-settings step to `wizardSteps.ts`, positioned between bootstrap and terraform-init
- [ ] 9.3 Update `wizard.utils.ts` — including `reconfigureSteps()` — to omit guided-IAM and include deployment-settings in reconfigure mode
- [ ] 9.4 Build `guided-iam-step.component.tsx`: guided path as default with an "I already have credentials" alternative, template path with copy and reveal actions, console-open action, key intake form, rotation progress, and the distinct rotation failure states
- [ ] 9.5 Build `deployment-settings-step.component.tsx`: top-level variable form prefilled from `getTopLevelVars()`, with per-field validation errors
- [ ] 9.6 Leave `game_servers` editing to the existing add-game wizard and edit-game form — the new step covers top-level variables only
- [ ] 9.7 Render the credentials step as satisfied (resolved principal + region, with a switch-source affordance) when guided provisioning already established a source
- [ ] 9.8 Persist rotation-pending state through `FirstRunWizardService` so a relaunch resumes into the rotation step
- [ ] 9.9 Add the Terraform settings section to `settings.page.tsx`, driven by the same components and service
- [ ] 9.10 Component tests (Vitest + jsdom + RTL) for both new step components: each rendering branch, every callback prop, and the rotation failure states

## 10. End-to-end coverage

- [ ] 10.1 Add a page object for each new wizard step under `app/packages/web/e2e/pages/`
- [ ] 10.2 Electron e2e spec for the guided path happy case, driven through `window.hyveon.__test.mock()`
- [ ] 10.3 Electron e2e spec for the deployment-settings step writing tfvars and advancing to init
- [ ] 10.4 Electron e2e spec for the rotation-pending resume case
- [ ] 10.5 Confirm `@cdktf/hcl2json` is still externalised from the Electron bundle (rollup `external` + electron-builder `files`) and that Electron e2e teardown does not hang

## 11. Documentation

- [ ] 11.1 Rewrite `docs/docs/setup.md` steps 1–2 as "run the app and follow the wizard", retaining the manual IAM steps under an explicit "Manual fallback" heading
- [ ] 11.2 Rewrite `docs/docs/setup.md` step 4 to point at the deployment-settings step for top-level variables and the existing game UI for `game_servers`, keeping the variable reference intact
- [ ] 11.3 Update `docs/docs/components/terraform.md` to mark app-editable variables as such
- [ ] 11.4 Update `CLAUDE.md`'s setup narrative, and update `docs/docs/app/first-run-wizard.md`, which documents a five-step wizard and says "Step N of 5"
- [ ] 11.5 Reconcile the existing state-bucket / lock-table naming drift between `setup.md` (`{project_name}-tf-state` / `-tf-locks`) and `defaultBootstrapResourceNames()` (`hyveon-tfstate` / `hyveon-tflock`), documenting whichever names win

## 12. Verification

- [ ] 12.1 `npm run app:test` green
- [ ] 12.2 `npm run app:lint` clean
- [ ] 12.3 `npm run app:test:integration` green
- [ ] 12.4 `npm run app:test:e2e` green
- [ ] 12.5 Manual run against a real AWS account: create the stack, complete rotation, confirm the bootstrap key is dead and the stack outputs authenticate nothing, then reach a successful `terraform plan`
