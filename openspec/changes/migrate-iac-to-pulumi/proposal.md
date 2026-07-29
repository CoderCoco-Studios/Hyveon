# Migrate infrastructure-as-code from Terraform to Pulumi

## Why

Hyveon is a packaged desktop app, but it cannot provision anything until the
operator has manually installed the `terraform` binary and put it on `PATH`.
`TerraformService.resolveBinaryPath()` shells out to `which terraform` and
throws `TerraformNotFoundError` when that fails, and the first-run wizard hard
blocks on the result. Telling a desktop-app user to go install a CLI before the
app works is the single largest onboarding cliff we have.

The AWS CLI is a second, weaker instance of the same problem: nothing in the app
actually uses it — every AWS call already goes through `@aws-sdk/*` — yet
`wizard.utils.ts` still refuses to advance unless `aws` is found on `PATH`.

Removing both prerequisites is the goal. Pulumi is the way we get there without
giving up multi-cloud:

- **Pulumi can install its own engine.** `PulumiCommand.install()` from
  `@pulumi/pulumi/automation` downloads a version-matched CLI from inside our
  Node process, into an install root this app owns under Electron `userData`.
  (`~/.pulumi/versions/<version>` is the SDK's default, which we override so the
  app never depends on, nor writes to, a shared user-level tool directory.) The
  operator installs nothing.
- **It keeps the multi-cloud door open.** AWS CDK would close it: there is no
  Google equivalent to migrate to later. Google Cloud Deployment Manager lost
  support on 2026-04-01 and shuts down 2027-06-30, and Google's replacement
  (Infrastructure Manager) is managed Terraform. CDK for Terraform — the one
  tool that would have spanned both — was archived by HashiCorp on 2025-12-10.
  Pulumi is the only remaining option that is multi-cloud, imports natively into
  TypeScript, and exposes a programmatic engine.
- **It deletes a layer we only maintain because infra is HCL.** The app has to
  read and write `terraform.tfvars`, so it carries `@cdktf/hcl2json` (plus a
  `patch-package` patch, plus a mandatory `external` marking in
  `electron.vite.config.ts` because bundling it prevents Electron from quitting)
  and hand-rolled `hclSurgeon.ts` / `hclEmit.ts` for surgical text edits, because
  the JSON round-trip is lossy. With a TypeScript infra program the `game_servers`
  config becomes an ordinary shared type and all of that disappears.

Now is the cheapest this will ever be: Hyveon is pre-release, so no operator has
a Terraform deployment to preserve. The only one that exists is the maintainer's
own development stack, so we migrate by destroying and redeploying rather than
importing 69 resources into a new state model.

## What Changes

- **BREAKING**: The `terraform/` tree (21 `.tf` files, 2837 lines, 69 `resource`
  blocks) is replaced by a TypeScript Pulumi program in a new
  `app/packages/infra` workspace. No state is migrated. Tearing down the
  maintainer's pre-existing Terraform stack is a one-off **maintainer** task
  performed out of band; it is explicitly not an operator workflow and MUST NOT
  appear in operator documentation, which would contradict the app-only operator
  boundary this same change establishes.
- **BREAKING**: `terraform.tfvars` stops being the configuration source of
  truth. `game_servers` and the top-level deployment settings become a typed
  object in `@hyveon/shared` persisted as JSON, and the versioned-S3 tfvars
  bucket becomes a versioned-S3 JSON config object.
- **BREAKING**: `TfvarsService`'s local-file mode is removed, not ported. The S3
  configuration bucket becomes the only configuration source. No file on the
  operator's machine is load-bearing, so there is no supported way to change
  what gets deployed by hand-editing a file — and no unguarded `writeFileSync`
  path that bypasses the remote store's optimistic locking and version history.
- **BREAKING**: State moves from the Terraform S3 backend + DynamoDB lock table
  to a Pulumi DIY backend (`s3://`) in the same bucket. No Pulumi Cloud account
  or access token is required.
- The `terraform` prerequisite is removed. `PulumiEngineService` resolves the
  engine from a cache under Electron `userData`, downloading and verifying it on
  first use via `PulumiCommand.install()`.
- The AWS CLI prerequisite is removed. The `aws` PATH probe and its wizard gate
  are deleted, and the `aws s3api` / `aws dynamodb` calls in the Makefile emitted
  by `scripts/init-parent.ts` are ported to `@aws-sdk/client-s3` and
  `@aws-sdk/client-dynamodb`.
- `TerraformService` (2741 lines) is replaced by `PulumiService` driving the
  Automation API. Plan becomes `preview`, apply becomes `up`, destroy stays
  `destroy`, and `output -json` becomes `stack.outputs()`.
- Run summaries stop being scraped out of stdout with regexes
  (`PLAN_SUMMARY_PATTERN`, `APPLY_SUMMARY_PATTERN`, `DESTROY_SUMMARY_PATTERN`)
  and are read from the structured `changeSummary` the Automation API returns.
- `@cdktf/hcl2json`, its patch, its `external` marking, its `electron-builder`
  unpacked-files entries, `hclSurgeon.ts`, and `hclEmit.ts` are all removed.
- Every bucket the bootstrap service creates gains all four S3
  public-access-block settings. The SDK bootstrap path currently applies none,
  while the `terraform/bootstrap/` module it mirrors applies all four — this
  change makes the SDK path the only path, so it is the right moment to close
  the gap.
- The packaging defect is fixed as a side effect: `electron-builder.yml`
  currently ships only `terraform.tfstate` and the icon in `extraResources` and
  none of the 21 `.tf` files, so `getTerraformDir()` seeds a directory with no
  HCL in it. The Pulumi program compiles into the main-process bundle instead.

### Non-goals

- Adding a GCP provider. This change only preserves the *option*; no
  `@pulumi/gcp` resources are written.
- Importing existing Terraform state into Pulumi. Explicitly out of scope
  because there is nothing deployed that needs preserving.
- Renaming the `terraform-*` capability specs to `iac-*`. Their requirements
  change here; the rename is deferred to a follow-up to keep this change's diff
  reviewable.
- Renaming the `terraform.*` IPC channels, the `hyveon.terraform` preload
  namespace, or the `/terraform` route. They keep their names through this
  change for the same reason, and are renamed in the same follow-up as the
  specs. Renaming them here would touch the controller, preload, typed API,
  every page object, and every e2e mock for no behavioral gain.

## Capabilities

### New Capabilities

- `pulumi-engine-runtime`: Resolving, downloading, version-pinning, and caching
  the Pulumi engine inside the app, plus the Automation API seam
  (`LocalWorkspace`, inline program, DIY S3 backend, secrets provider) that
  every IaC operation goes through.
- `pulumi-infra-program`: The TypeScript infrastructure program that replaces
  the HCL — stack structure, the typed `game_servers` configuration model, and
  the resource-level parity contract with the retired Terraform module.

### Modified Capabilities

- `prerequisite-detection`: Both binary probes are removed. `terraform` is no
  longer detected or required because the app manages the engine itself, and
  `aws` is no longer detected or required because nothing uses it.
- `cloud-bootstrap`: The Terraform lock table is no longer created (Pulumi's DIY
  backend locks with objects in the state bucket). The state bucket and the
  config bucket remain, with the latter holding JSON instead of tfvars.
- `wizard-flow`: The "Install prerequisites" step is removed and the
  "Terraform init step with live log" step becomes a Pulumi stack-select and
  engine-provisioning step.
- `terraform-plan-apply-page`: Plan is driven by `stack.preview()` and its
  summary comes from structured `changeSummary` data rather than scraped stdout.
  The plan-hash gate is rebased onto the preview's structured diff.
- `terraform-destroy-flow`: Destroy is driven by `stack.destroy()`. The
  confirmation-token gate and type-to-confirm UI are unchanged.
- `terraform-rollback`: Version listing and rollback operate on versions of the
  JSON config object rather than of `terraform.tfvars`.
- `terraform-run-history`: Persisted run records carry structured change
  summaries instead of regex-derived counts.
- `desktop-only-operator-surface`: Extends the existing "the desktop app is the
  whole operator surface" guarantee from transport and deployment artifacts to
  configuration and tooling — no operator-editable configuration files, and
  nothing but the app itself needs to be run in a terminal.

`aws-credentials` is deliberately **not** modified. It already specifies how
credentials are discovered, encrypted, and selected, and none of that changes.
What changes is that the selected credentials must actually reach the engine —
today they do not, because `spawn()` in `TerraformService` passes no `env`,
`AWS_PROFILE` is never set anywhere in the repo, and safeStorage-pasted keys are
unreachable by the subprocess, so Terraform silently resolves credentials
through its own default chain instead of the operator's choice. That guarantee
belongs to the engine, so it is specified once in `pulumi-engine-runtime` rather
than duplicated here.

## Relationship to `add-one-click-aws-bootstrap`

That change (proposed, unimplemented) targets the same goal — zero manual steps
outside the app — and overlaps this one directly. This change lands first, and
`add-one-click-aws-bootstrap` is then re-proposed against a Pulumi codebase:

- Its `terraform-settings-management` capability is **dropped entirely**. It
  exists to extend `hclSurgeon.ts` and `hclEmit.ts` with attribute-level
  splicing so top-level variables can be edited without hand-editing HCL. This
  change deletes both files and makes the whole configuration a typed object, so
  editing top-level settings becomes a form binding. Building the HCL surgery
  first would mean discarding it weeks later.
- Its credential-plumbing fix to `TerraformService.spawnAndStream()` is
  **dropped**, because `TerraformService` is deleted. The underlying bug is real
  and is fixed here instead, in `pulumi-engine-runtime`'s "Wizard-selected
  credentials reach the engine" requirement.
- Its public-access-block hardening is **absorbed** into this change's
  `cloud-bootstrap` delta, since bucket creation moves here.
- Its `guided-iam-provisioning` capability **survives unchanged in shape** — the
  CloudFormation template, the console handoff, and the mint-then-revoke key
  rotation are all orthogonal to which IaC engine runs. Only the generated
  policy's contents shift: the four DIY-backend S3 actions are added, and the
  lock-table DynamoDB actions are removed.

## Impact

**New workspace**: `app/packages/infra` (`@hyveon/infra`) holding the Pulumi
program. New dependencies `@pulumi/pulumi` 3.255.0 and `@pulumi/aws` 7.39.0.
`@pulumi/aws` is 60 MB unpacked and `@pulumi/pulumi` is 15 MB, so both must be
marked `external` in `electron.vite.config.ts` and listed in
`electron-builder.yml` `files`, following the precedent already set for
`@cdktf/hcl2json`.

**Removed**: the `terraform/` tree; `TerraformService.ts` (2741 lines) and its
spec; `TfvarsService`'s HCL paths, `hclSurgeon.ts`, `hclEmit.ts`;
`@cdktf/hcl2json` and `patches/@cdktf+hcl2json+0.21.0.patch`; the `terraform`
and `aws` branches of `PrerequisiteService`; `terraform/bootstrap/`;
`terraform/moved.tf` (376 lines of `moved` blocks with nothing left to move).

**Rewritten**: `terraform.controller.ts` IPC surface (9 channels);
`terraform.page.tsx` including its three duplicated summary regexes;
`ConfigService.getTfOutputs()` / `getTfStatePath()` / `getTerraformDir()` /
`seedTerraformWorkspace()`; `BootstrapService`'s lock-table path;
`scripts/init-parent.ts`'s generated Makefile.

**Test surface**: `app/test/fake-terraform.mjs` and the
`terraform-shim.ts` / `terraform-fixtures.ts` Playwright fixtures need Pulumi
equivalents. Automation API operations are in-process, which removes the need to
shim a binary onto `PATH` for most specs.

**Docs**: `docs/docs/setup.md` (prerequisites table, "Configure the AWS CLI"
section, the bootstrap-tfvars CLI walkthrough), `docs/docs/components/terraform.md`
(full rewrite), `docs/docs/architecture.md`, `docs/docs/guides/user.md`,
`docs/docs/guides/submodule.md`, `README.md`, and the `HyveonDeployAll` IAM
policy, which no longer needs DynamoDB lock-table permissions.

**Deferred risk**: the Automation API drives the engine as a subprocess. We
already know from `@cdktf/hcl2json` that a misbehaving native/bundled dependency
can prevent Electron from quitting, so engine-process lifecycle and teardown
under Playwright must be verified early rather than at the end.
