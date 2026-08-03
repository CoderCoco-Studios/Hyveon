## 1. CloudFormation template generation

- [x] 1.1 Add a generator that builds the four-statement managed-policy document from `HYVEON_DEPLOY_ALL_ACTIONS` (`app/packages/shared/src/iamPolicy.ts`), reproducing the real current `HyveonDeploy` / `HyveonIAM` / `HyveonConfigurationBucket` / `HyveonStateBucket` statement structure documented in `docs/docs/setup.md` — including `HyveonStateBucket`'s exact action set (`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:PutBucketVersioning`, `s3:PutEncryptionConfiguration`, `s3:PutBucketPublicAccessBlock`, scoped to `${project_name}-tfstate` and its `/*`) with **no DynamoDB action of any kind** — Pulumi's self-managed S3 backend has no lock table
- [x] 1.2 Author `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml` with `AWS::IAM::ManagedPolicy`, `AWS::IAM::User` (name from a stack parameter defaulting to `hyveon`), and `AWS::IAM::AccessKey` carrying `DeletionPolicy: Retain`
- [x] 1.3 Add stack outputs for user name, policy ARN, access key ID, and secret access key
- [x] 1.4 Extend `iamPolicy.test.ts` (or a new generator-specific test) to assert the generated CloudFormation policy document's four statements match `docs/docs/setup.md`'s JSON exactly, Sid-for-Sid and action-for-action, alongside the existing `HYVEON_DEPLOY_ALL_ACTIONS` assertion
- [x] 1.5 Include the template in the packaged app's resources (`electron-builder.yml` `extraResources`, alongside the existing `build/icon.png` entry) and confirm it resolves at runtime from both a dev run and a packaged build

## 2. GuidedIamService (main process)

- [x] 2.1 Implement template rendering plus writing the template to a known path under `userData`, returning that path
- [x] 2.2 Implement CloudFormation console URL construction in a single function, region-scoped, with a unit test pinning the URL shape
- [x] 2.3 Implement browser launch with a graceful fallback that returns the URL as text when launching fails
- [x] 2.4 Implement bootstrap key intake: validate via `sts:GetCallerIdentity`, record the account ID, reject invalid credentials with the underlying AWS error, and never persist an unvalidated secret
- [x] 2.5 Implement rotation: `iam:CreateAccessKey` → safeStorage persist → `sts:GetCallerIdentity` verify → `iam:DeleteAccessKey` on the bootstrap key, in that order
- [x] 2.6 Handle the rotation failure modes distinctly — verification failure leaves the bootstrap key intact and retries; deletion failure reports "bootstrap key still active" with a console link and does not report success
- [x] 2.7 Refuse all credential storage when `SafeStorageService` reports encryption unavailable, directing the operator to the alternative paths
- [x] 2.8 Ensure no code path logs the secret access key
- [x] 2.9 Unit tests for each of 2.4–2.8, with `aws-sdk-client-mock` covering the IAM/STS calls

## 3. Credential rotation in AwsProfileService

- [x] 3.1 Add a rotation method to `AwsProfileService` that replaces the stored key for the active credential source using the verify-before-delete ordering
- [x] 3.2 Ensure a failed verification leaves the previously stored key active and in the keychain
- [x] 3.3 Unit tests for successful rotation and for verification failure preserving the old key

## 4. Configuration-bucket encryption (state-bucket hardening's one remaining gap)

- [x] 4.1 Add an idempotent `PutBucketEncryption` call (AES256 default server-side encryption) to `BootstrapService.ensureConfigurationBucket()`, mirroring what `ensureStateBucket()` already does — public-access-block and versioning are already applied to both buckets and need no further change
- [x] 4.2 Apply the call on the `exists` path as well as `created`, consistent with the existing `ensurePublicAccessBlock()` pattern, so a configuration bucket provisioned before this change is brought into line without changing the reported status
- [x] 4.3 Report a denied or failed `PutBucketEncryption` call as a bootstrap `failed` result carrying the underlying error, never as success
- [x] 4.4 Unit tests: encryption applied on create, applied on a pre-existing configuration bucket while still reporting `exists`, and failure surfaced as `failed`

## 5. IAM permission gate

- [x] 5.1 Extend `IamCheckService` results to carry the credential-source origin so callers can decide gating
- [x] 5.2 Make a `missing` result block progression on the guided path, listing denied actions with a re-run action
- [x] 5.3 Keep `missing` advisory on the profile-picker and paste paths, and keep `warning` non-blocking on every path
- [x] 5.4 Run the gate automatically after rotation, against the rotated key
- [x] 5.5 Unit tests covering all four combinations of (guided, manual) × (missing, warning)

## 6. IPC surface

- [x] 6.1 Add `wizard.guidedIam.*` channels to `wizard.controller.ts`: prepare template, open console, submit bootstrap key, rotate, revoke bootstrap key
- [x] 6.2 Expose the new namespace on the preload bridge in `desktop-preload/src/preload.ts`
- [x] 6.3 Confirm no channel returns a secret value to the renderer; intake is renderer→main only
- [x] 6.4 Integration specs (tier 2) dispatching the new controller methods through the real `AppModule` container

## 7. Wizard UI

- [x] 7.1 Add the guided-IAM step to `WIZARD_STEPS` in `app/packages/shared/src/wizardSteps.ts`, positioned between `pick-cloud` and `credentials`
- [x] 7.2 Update `wizard.utils.ts` / `first-run-wizard.component.tsx` — including `RECONFIGURE_PRE_COMPLETED_STEPS` — to add the guided-IAM step so it renders pre-completed (with an "Edit" affordance) in reconfigure mode, gated on a persisted deploy-principal record rather than on credentials merely being configured
- [x] 7.3 Build `guided-iam-step.component.tsx`: guided path as default with an "I already have credentials" alternative, template path with copy and reveal actions, console-open action, key intake form, rotation progress, and the distinct rotation failure states
- [x] 7.4 Render the credentials step as satisfied (resolved principal + region, with a switch-source affordance) when guided provisioning already established a source
- [x] 7.5 Persist rotation-pending state through `FirstRunWizardService` so a relaunch resumes into the rotation step
- [x] 7.6 Component tests (Vitest + jsdom + RTL) for the new step component: each rendering branch, every callback prop, and the rotation failure states

## 8. End-to-end coverage

- [x] 8.1 Add a page object for the new wizard step under `app/packages/web/e2e/pages/`
- [x] 8.2 Electron e2e spec for the guided path happy case, driven through `window.hyveon.__test.mock()`
- [x] 8.3 Electron e2e spec for the rotation-pending resume case
- [x] 8.4 Confirm `@pulumi/pulumi`/`@pulumi/aws`/`@grpc/grpc-js` remain externalized from the Electron main bundle (`electron.vite.config.ts` `external` entries, `electron-builder.yml`'s `node_modules/**` allowlist) and that adding the new CloudFormation-template resource doesn't regress Electron e2e teardown

## 9. Documentation

- [x] 9.1 Rewrite `docs/docs/setup.md`'s "1. Create and authorise an IAM user" section as "run the app and follow the wizard", retaining today's manual console steps under an explicit "Manual fallback" heading
- [x] 9.2 Update `docs/docs/setup.md`'s "2. Clone, install, and launch the wizard" section from "Four steps" to "Five steps" with the guided-IAM step inserted before AWS credentials
- [x] 9.3 Update `docs/docs/app/first-run-wizard.md`, which currently documents a **four**-step wizard and says `Step N of 4` throughout (step table, header prose, and per-step walkthrough numbering), to five steps with the new guided-IAM step documented

## 10. Verification

- [x] 10.1 `npm run app:test` green
- [x] 10.2 `npm run app:lint` clean
- [x] 10.3 `npm run app:test:integration` green
- [x] 10.4 `npm run app:test:e2e` green
- [ ] 10.5 Manual run against a real AWS account: create the stack, complete rotation, confirm the bootstrap key is dead and the stack outputs authenticate nothing, then reach a successful `pulumi preview`
