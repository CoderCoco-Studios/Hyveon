## Context

Hyveon provisions AWS infrastructure from a packaged Electron desktop app. Today
that requires the operator to install the `terraform` binary manually:
`TerraformService.resolveBinaryPath()` runs `which terraform` (or `where.exe`),
throws `TerraformNotFoundError` on failure, and the first wizard step blocks
progression on the result. A second, spurious gate blocks on `aws` being present
on `PATH` even though no code path in the app has ever invoked the AWS CLI.

The infrastructure itself is 21 `.tf` files, 2837 lines, 69 `resource` blocks,
across a thin root composer, a `terraform/aws/` module, and a standalone
`terraform/bootstrap/` module. The app couples to it in three ways: it spawns
`terraform` for init/plan/apply/destroy/output, it parses `terraform.tfstate`
from disk to discover deployed resources, and it reads and writes
`terraform.tfvars` as the canonical `game_servers` configuration.

That last coupling is expensive. Because configuration is HCL, the app carries
`@cdktf/hcl2json` (with a `patch-package` patch, and a mandatory `external`
marking in `electron.vite.config.ts` because bundling it prevents Electron from
quitting) plus hand-rolled `hclSurgeon.ts` / `hclEmit.ts`, because the
JSON round-trip is lossy and the write path cannot use it.

Two constraints shape the solution. First, multi-cloud must remain possible:
`CloudProviderModule` binds four DI tokens against cloud-agnostic contracts in
`@hyveon/shared/cloud.ts`, and the intent to add a second provider is explicit
even though `active_cloud` currently validates to `"aws"` only. Second, Hyveon
is pre-release — nothing is deployed that needs its state preserved, so this is
the cheapest moment to change IaC systems.

## Goals / Non-Goals

**Goals:**

- Remove the `terraform` install prerequisite. The app provisions and caches its
  own engine.
- Remove the `aws` CLI prerequisite, including the `aws s3api` / `aws dynamodb`
  calls in the Makefile emitted by `scripts/init-parent.ts`.
- Keep multi-cloud IaC possible without writing any of it now.
- Delete the HCL-handling layer (`@cdktf/hcl2json`, its patch, `hclSurgeon.ts`,
  `hclEmit.ts`) by making configuration typed TypeScript persisted as JSON.
- Preserve the operator-facing safety model exactly: approve gate, 15-minute
  approval window, plan-hash gate, durable apply lock, type-to-confirm destroy,
  run history, rollback.
- Fix the packaging defect where `electron-builder.yml` ships no `.tf` files, so
  a packaged build has no infrastructure source to operate on.

**Non-Goals:**

- Writing any GCP resources. This change preserves the option only.
- Importing existing Terraform state. Out of scope because nothing is deployed.
- Changing the AWS architecture. Resource parity with the retired module is a
  requirement, not an opportunity to redesign.

## Decisions

### Pulumi over AWS CDK and over CDK for Terraform

CDK for Terraform was the natural "one language, both clouds" answer and is
gone: HashiCorp archived `hashicorp/terraform-cdk` on 2025-12-10, last release
0.21.0. It also never removed the binary requirement — it synthesized JSON and
shelled out to `terraform`.

AWS CDK would genuinely remove every binary, but it closes the multi-cloud door.
There is no Google equivalent to migrate to later: Google Cloud Deployment
Manager lost support on 2026-04-01 and shuts down 2027-06-30, and Google's
replacement, Infrastructure Manager, is managed Terraform. Choosing CDK means
committing to writing CDK for AWS and something else entirely for GCP — two IaC
systems, two state models.

Pulumi is the only remaining option that is multi-cloud, imports natively into
TypeScript, and exposes a programmatic engine. Versions pinned: `@pulumi/pulumi`
3.255.0, `@pulumi/aws` 7.39.0.

**Alternative kept on the table:** auto-downloading an OpenTofu binary and
keeping all the HCL. That achieves the prerequisite goal for a fraction of the
cost, but keeps the HCL-handling layer and the lossy config round-trip. It
remains the fallback if the Electron spikes below fail.

### No operator-editable files on disk

The operator surface is the app. Nothing on the operator's machine may be
load-bearing configuration, for two reasons: a hand-edited file can silently
diverge from what the app believes is deployed, and `TfvarsService`'s local mode
writes through an unguarded synchronous `writeFileSync` with none of the
optimistic locking or version history the S3 path carries — so the rollback
capability is quietly unavailable in that mode.

Local mode is therefore **removed, not ported**. The S3 configuration bucket
becomes the only source; when no bucket is configured the app reports incomplete
setup and routes to the wizard rather than falling back to a file. A silent
fallback would reintroduce precisely the hand-editable file this is meant to
eliminate.

This is deliberately framed as a **supportability boundary, not a security
boundary**. The application bundle is an asar archive, which `npx asar extract`
opens in seconds, and any credential the app can decrypt a local user on the
same OS account can decrypt too. Claiming tamper-proofing would be false. The
honest guarantee is narrower and still worth having: there is no *supported*
path by which editing a local file changes what gets deployed.

**Alternative considered:** keep local mode and harden it — the
`add-one-click-aws-bootstrap` proposal suggests writing a `.bak` copy before
each splice. That treats the symptom. It leaves a second write path with weaker
guarantees than the primary one, and leaves a file whose edits the app cannot
detect.

### Inline program, not a `workDir` program

The Automation API offers `LocalWorkspace.createOrSelectStack` with either an
inline `PulumiFn` closure or a `workDir` pointing at a real project directory.

Inline is the right choice for a packaged app, for two independent reasons. The
mechanical one: a `workDir` program needs a real, writable directory containing
`Pulumi.yaml` and a `node_modules` the CLI populates with `npm install` — all
hostile to an asar bundle. Inline needs nothing on disk, because provider SDKs
resolve through our own module graph.

The second reason follows from the previous decision. A seeded `workDir` is, by
construction, a directory of editable infrastructure source sitting in
`userData` — exactly the class of load-bearing local file this change is
removing. Shipping the program inside the bundle keeps it out of the operator's
way. This makes the inline approach a design commitment rather than merely a
convenience, which raises the stakes on the asar spike below.

The mechanism is worth stating precisely because it drives several decisions
below. Inline does **not** mean in-process end to end. The SDK stands up an
in-process gRPC `LanguageRuntimeService` on `127.0.0.1:0`, spawns the `pulumi`
CLI as a child process with `--client=127.0.0.1:<port> --exec-kind inline`, and
the CLI engine calls back into our process to execute the closure. So our
program runs in our heap and is debuggable, but there is always a child process
and always an ephemeral loopback listener for the duration of an operation.

**Constraint to respect:** Pulumi documents that an inline program's lifecycle
must be fully contained in the closure — work performed outside it is unsafe.

### Engine cached under `userData`, not `~/.pulumi`

`PulumiCommand.install({ version, root, skipVersionCheck })` accepts a `root`,
threaded through to the installer as `--install-root` / `-InstallRoot`, with the
binary landing at `<root>/bin/pulumi`. We point it at a directory under Electron
`userData` rather than the default `~/.pulumi/versions/<version>`, so the app
owns its engine and does not collide with an operator's own Pulumi install.

`install()` calls `get()` first and returns early when a compatible CLI already
exists at that root, so it is cheap and idempotent to call before every
operation.

Two things must be set explicitly or the custom root is silently useless:

- `LocalWorkspaceOptions.pulumiCommand` must receive the returned
  `PulumiCommand`. Omitted, the workspace falls back to `pulumi` on `PATH` —
  reintroducing exactly the dependency this change removes.
- `LocalWorkspaceOptions.pulumiHome` must also point under `userData`. The
  install root holds only the binary; plugins, credentials, and workspace
  metadata go to `$PULUMI_HOME`.

The installer downloads and executes a shell script from `get.pulumi.com`
(`install.sh` via `/bin/sh`, or `install.ps1` via `powershell.exe`). It passes
`--no-edit-path`, so it will not modify the operator's `PATH`.

### DIY S3 backend, configured by environment variable

State goes in the operator's own S3 bucket — the one `BootstrapService` already
creates — via `PULUMI_BACKEND_URL` in `LocalWorkspaceOptions.envVars`, avoiding
any interactive `pulumi login`. No Pulumi Cloud account and no access token:
`PULUMI_ACCESS_TOKEN` is a Pulumi Cloud concern, and the S3 backend authenticates
through the standard AWS credential chain.

**Verified empirically** (spike, 2026-07-28) against a `file://` backend: with a
fresh, empty `PULUMI_HOME` and no prior login, `stack init`, `stack ls`, and
`whoami` all succeed, and **no `credentials.json` is ever written** —
`PULUMI_HOME` afterwards contains only `logs/` and `workspaces/`. The identity
`whoami` reports is derived from the OS user, not from stored credentials. So
the login-less mechanism works and leaves no credential state behind.

The S3-specific half is still unverified: the spike machine had no S3 buckets,
and creating one was out of scope. What remains open is narrow — whether the S3
backend driver authenticates through the AWS credential chain without a login,
not whether `PULUMI_BACKEND_URL` alone is honoured.

The backend needs exactly four IAM actions: `s3:ListBucket` on the bucket, and
`s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on objects. It writes under a
`.pulumi/` prefix: `meta.yaml`, `stacks/`, `locks/`, `history/`.

**Stack naming is a trap.** Non-legacy DIY backends accept
`organization/<project>/<stack>` where `org` must be the literal string
`organization`, or a bare stack name. Getting this wrong silently creates the
wrong stack rather than erroring. We use bare stack names and pin the choice in
one constant.

### Keep secrets out of the stack, then take the free secrets provider

`LocalWorkspaceOptions.secretsProvider` is a plain string passed through to
`--secrets-provider`, and it is only applied on the `stack init` path — it is a
no-op when selecting an existing stack. `pulumi stack change-secrets-provider`
is not exposed through the Automation API in 3.255.0, so this must be right the
first time.

The framing that matters is not "which provider" but "how much secret material
is in state at all". Auditing the current module answers it: the only genuinely
secret values are `discord_bot_token` and `discord_public_key`
(`terraform/aws/variables.tf`), which flow into `secret_string` on the two
`aws_secretsmanager_secret_version` resources (`terraform/aws/discord_store.tf`).
Both default to `""`, both carry `ignore_changes = [secret_string]`, and both
are documented "Optional; empty to configure via UI" — so on the documented path
state holds the literal string `"placeholder"`. The only other `sensitive = true`
marking is `applied_game_servers`, which is ports, images, and memory limits,
marked sensitive to keep diffs quiet rather than because it is secret.

**Decision: drop both Discord variables from the infrastructure program.** The
app's `DiscordConfigService` already writes these to Secrets Manager over the
AWS SDK, and the standing rule is that neither secret is ever sent to the
client. Making the SDK path the *only* path removes the one route by which a
real token could reach state, and removes a configuration input that duplicates
a UI the app already ships. The program declares the secrets and their
placeholder versions; it never carries their values.

With no secret material in the stack, the provider choice is low-stakes and we
take the free `passphrase` provider, generating a passphrase and storing it via
the existing `SafeStorageService` — the same mechanism that already encrypts
pasted AWS keys.

**The spike confirmed how unforgiving the passphrase requirement is.** With no
`PULUMI_CONFIG_PASSPHRASE` set, `stack init` under `--non-interactive` — which
the Automation API always passes — is a hard exit-1:

```
error: could not create secrets manager for new stack: passphrase must be set
with PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE environment
variables
```

Under a TTY it prompts and hangs instead. Passing `--secrets-provider=passphrase`
explicitly changes nothing — it is already the DIY default — and
`--secrets-provider=default` produces the identical error. There is no
"no secrets provider" escape hatch on a DIY backend. The passphrase must
therefore be generated and placed in `envVars` *before* the first stack is
created, and must remain available for every subsequent operation.

**Alternative considered:** a customer-managed KMS key created by
`BootstrapService`, at roughly $1/month. It buys a recovery path that survives
losing the machine, which `safeStorage` does not. Rejected because the audit
shows nothing in the stack needs encrypting, and because standing idle cost is
the thing this project's entire architecture exists to avoid — no persistent ECS
service, no ALB, on-demand tasks only. Paying monthly to encrypt the string
`"placeholder"` would be incoherent with that.

**The residual risk must not be inherited silently.** A passphrase still
encrypts any secret added to the stack later, and `safeStorage` is machine-bound
with no recovery. Any future change that introduces genuine stack secrets must
revisit this decision rather than assume it still holds — recorded as a spec
requirement, not just a note here, so the constraint is testable.

### Update plans preserve the existing apply gate

This is the decision that changed most on investigation. Pulumi does have a
plan-file equivalent: `PreviewOptions.plan` emits `--save-plan <path>` and
`UpOptions.plan` emits `--plan <path>`, and a plan-constrained `up` fails
immediately if reality diverges from what was reviewed.

That maps almost exactly onto the existing seven-step gate, including
`hasPlanArtifact` and `computePlanHash` re-hashing the on-disk artifact — the
two methods that looked unmappable before this was verified.

**Verified empirically against CLI 3.255.0** (spike, 2026-07-28): neither flag
requires `PULUMI_EXPERIMENTAL`. `preview --save-plan` and `up --plan` both exit
0 without it, and the constraint is genuinely enforced — adding a resource to
the program and re-running `up --plan` against the stale plan fails with
`error: create is not allowed by the plan: no steps were expected for this
resource`. The env var only affects *discoverability*: `--plan` is hidden from
`pulumi up --help` unless it is set. The flag works either way, so we do not set
it, and we avoid the other experimental behaviour it would switch on.

Four caveats drive the spec:

1. **The plan format carries no stability guarantee.** Pulumi documents it as
   experimental and subject to change. So the hash additionally covers the
   configuration object's version id, and the staleness check must not depend on
   the plan file being parseable.
2. **The plan is stamped with the engine version.** `plan.json`'s top-level
   `manifest` carries `version: "v3.255.0"` alongside `resourcePlans`. A plan
   saved by one engine version is not guaranteed to be honoured by another, so
   the engine version must participate in plan validity — an engine upgrade
   between plan and apply must invalidate the plan rather than risk it being
   reinterpreted.
3. **A plan-constrained apply is not all-or-nothing.** Operations run in batches
   as the program executes, so a divergence found partway through leaves earlier
   changes applied. Unlike `terraform apply tfplan`, "the plan was rejected"
   does not imply "nothing happened". Run states must distinguish a partial
   apply, and the UI must direct the operator to re-plan rather than retry.
4. **Destroy cannot be plan-constrained.** `pulumi destroy` exposes neither
   `--plan` nor `--save-plan` at 3.255.0. The destroy path therefore relies
   entirely on the confirmation-token gate and the type-to-confirm UI for its
   safety, with no plan artifact behind it. This is not a regression — the
   Terraform destroy path used `-auto-approve` with the same token gate as its
   only guard — but it means the token gate is load-bearing in a way the apply
   path's is not.

### Structured summaries, not scraped stdout

`PreviewResult.changeSummary` is an `OpMap` — counts keyed by `OpType`
(`create`, `update`, `replace`, `delete`, `same`, …). `UpResult` and
`DestroyResult` carry the same counts at `summary.resourceChanges`. These come
from the engine's `summaryEvent` captured over `onEvent`, not from parsing
stdout, which retires `PLAN_SUMMARY_PATTERN`, `APPLY_SUMMARY_PATTERN`,
`DESTROY_SUMMARY_PATTERN` and their duplicates in `terraform.page.tsx`.

**One sharp edge:** when the SDK misses the summary event it logs a warning and
returns `{}`. An empty `changeSummary` is therefore indistinguishable from "no
changes", and the UI must not treat it as such.

Note also that `PreviewOptions` has no `json` option, so `stdout` is
human-readable text. Resource-level diffs come from `onEvent`
(`StepEventMetadata.detailedDiff`), not from parsing output.

### Streaming and cancellation

`onOutput` / `onError` deliver raw stdout/stderr chunks from the child process —
**unbounded chunks, not lines**. The existing line-splitting logic in
`spawnAndStream` (accumulate, split on `/\r?\n/`, hold back the trailing
partial, flush on close) is reused rather than rewritten.

Cancellation has two independent mechanisms and they are not interchangeable:

- **`AbortSignal`** on the operation options is the user-facing Cancel. It sends
  `SIGINT` to the CLI child with `forceKillAfterTimeout: false` — it never
  escalates to `SIGKILL`. A wedged engine would keep the Electron main process
  alive forever, so we add our own escalation timer.
- **`stack.cancel()`** shells out `pulumi cancel` against the backend. Pulumi
  documents it as "very dangerous" and liable to leave the stack inconsistent.
  We reserve it exclusively for clearing a stale DIY lock, behind explicit
  operator confirmation.

Stale locks need first-class handling. DIY locks have no server-side expiry, so
a crash or force-quit leaves a lock that blocks everything indefinitely. The SDK
surfaces this as a typed `ConcurrentUpdateError`, matched on `"[409] Conflict"`
or `"the stack is currently locked by"`.

### `@pulumi/pulumi` must be `external`, not bundled

The repo has already been burned by this exact failure mode: bundling
`@cdktf/hcl2json` into the Electron main bundle prevented Electron from quitting
and broke every e2e teardown, fixed by marking it `external` in the rollup
config plus listing it in `electron-builder.yml` `files`.

`@pulumi/pulumi` pulls in `@grpc/grpc-js`, which owns sockets, and the repo
already carries a `@grpc/proto-loader` dependency note from an earlier CI
incident. We follow the established precedent from the start rather than
discovering it in CI.

Sizes: `@pulumi/aws` is 60 MB unpacked, `@pulumi/pulumi` 15 MB. Both ship
unpacked via `electron-builder.yml` `files`.

### Rename terraform-* specs, IPC channels, preload namespace, and route now

An earlier draft of this change deferred renaming the `terraform-*` capability
specs (to `iac-*`) and the `terraform.*` IPC channels / `hyveon.terraform`
preload namespace / `/terraform` route to a follow-up change, reasoning that
the rename touched the controller, preload, typed API, every page object, and
every e2e mock for no behavioral gain, and would bloat this change's diff.

That reasoning held only as long as the rename was optional. It stopped being
optional once the alternative was implementing `TerraformController` and the
`terraform-plan-apply-page` spec against Pulumi-era behavior, only to rename
both again in the very next change — real rework, not diff hygiene. Doing the
rename in the same change that already rewrites every one of those call sites
(Phase 8 rewrites the controllers regardless; Phase 9 rewrites the routed
page regardless) costs the rename itself, not a second pass through files this
change already touches.

**Renaming scheme:**

- Capability specs: `terraform-plan-apply-page` → `iac-plan-apply-page`,
  `terraform-rollback` → `iac-rollback`, `terraform-destroy-flow` →
  `iac-destroy-flow`, `terraform-run-history` → `iac-run-history`.
  `pulumi-engine-runtime` and `pulumi-infra-program` keep their Pulumi-specific
  names — they describe Pulumi-specific mechanics (engine provisioning, the
  TypeScript program), not the generic plan/apply/destroy/history behavior the
  renamed specs cover, so tool-agnostic naming doesn't fit them.
- IPC channel namespace: `terraform.*` / `terraform.runs.*` → `iac.*` /
  `iac.runs.*`.
- Preload namespace: `hyveon.terraform` → `hyveon.iac`.
- Route: `/terraform` → `/iac`.
- Controller identifiers: `TerraformController` → `IacController`,
  `TerraformRunsController` → `IacRunsController`. `PulumiService` stays as-is
  — it is the genuinely Pulumi-specific engine driver, not the generic
  controller layer above it.

**Alternative rejected:** a new capability spec narrating "why Terraform was
retired." That is a rationale narrative (WHY, not WHEN/THEN behavior), which
does not fit OpenSpec's Requirement/Scenario format. The rationale already
lives in this document's Decisions section, which is archived permanently
with the change, and a short historical note belongs in
`docs/docs/architecture.md` instead — already in scope via Phase 12's
existing docs tasks.

## Risks / Trade-offs

**Inline program inside `app.asar` is unverified** → No Pulumi documentation
covers running an inline program from a bundler's output. Mechanically it should
work, since the CLI reads nothing from disk and reaches back over gRPC. Spike
this before any other implementation work; if it fails, fall back to seeding a
program directory into `userData` (the pattern `seedTerraformWorkspace()`
already implements) or to the OpenTofu alternative.

**Electron may not quit cleanly after an operation** → Source review found no
daemon, no persistent listener, and no polling timer between operations; every
gRPC server and temp resource is torn down in a `finally`. But this is exactly
the class of failure the hcl2json incident produced. Mark `@pulumi/pulumi`
external from the first commit and add an explicit "app quits cleanly after an
`up`" e2e check early, not at the end.

**First run downloads hundreds of megabytes** → The engine plus the AWS provider
plugin are both fetched on first use. Reported as distinct wizard phases so it
does not read as a hang; the operation itself must not appear to stall.

**Partial applies are a new failure mode** → `terraform apply tfplan` was
all-or-nothing; a plan-constrained `up` is not. Run states and UI copy must make
"failed partway through" legible, or operators will retry into a worse state.

**Stale DIY locks block everything with no expiry** → Detect
`ConcurrentUpdateError`, distinguish it from in-app busy, and offer explicit
operator-confirmed recovery. Never clear automatically.

**The passphrase secrets provider has no recovery path** → It is stored via
`safeStorage`, which is machine-bound; losing the machine means losing it. This
is acceptable only because the stack holds no secret material, which is itself
enforced by the "No secret material enters the stack" requirement. The two
constraints are load-bearing together: weaken either and state becomes
unrecoverable. Any change that adds secrets to the stack must revisit the
provider first.

**`process.setMaxListeners` is mutated globally** → `LanguageServer.run` raises
the Electron main process's global listener limit for the process lifetime.
Benign, but it will look like a leak if anyone audits listener counts.

**Temp workspace directories leak** → A `LocalWorkspace` created with no
`workDir` makes an `os.tmpdir()/automation-*` directory that is never removed.
Passing an explicit `workDir` under `userData` only relocates the leak unless
lifecycle is also defined, so the workspace is one stable directory per stack,
reused across operations rather than created per operation. Repeated
previews/applies must not grow the directory count.

**Leaked-promise check throws on the success path** → If the inline program
leaves dangling promises, `onPulumiExit` throws *after* an otherwise successful
operation. Handle "succeeded then threw" so a successful apply is not reported
as a failure.

**Scope** → This is a large change: 69 resources, a 2741-line service, 13 IPC
channels, and the test fixtures that shim a fake binary onto `PATH`. It should
land as a sequence of PRs behind the phases in `tasks.md`, not one merge.

## Migration Plan

No state import. Hyveon is pre-release, so no operator has a Terraform
deployment to preserve; the only one that exists is the maintainer's own
development stack.

Tearing that stack down is `terraform destroy` followed by a fresh deploy, and
it is a **maintainer task performed out of band, once**. It must not be written
into `docs/docs/setup.md` or any other operator-facing page: this change's
`desktop-only-operator-surface` requirement forbids instructing an operator to
run an infrastructure CLI, and there is no operator for whom the step would even
apply. It belongs in maintainer/contributor notes, which the operator-surface
requirement explicitly scopes out.

The reason it must be recorded *somewhere* is that the two systems share no
state, so deploying the Pulumi stack without first destroying the Terraform one
produces duplicate infrastructure silently — two VPCs, two EFS file systems, two
of every Lambda. That is a maintainer-facing hazard, not an operator-facing one.

Rollback strategy during development: the `terraform/` tree is deleted only in
the final phase, so every phase before that can be abandoned by reverting the
branch with working infrastructure still described in HCL.

## Open Questions

1. **Does the S3 backend driver authenticate without a prior login?** The
   login-less mechanism itself is verified — `PULUMI_BACKEND_URL` alone works
   with a fresh `PULUMI_HOME` and writes no `credentials.json` (see the DIY
   backend decision). What is untested is the `s3://` driver specifically,
   because the spike machine had no bucket and creating one was out of scope.
   Close this during the first bootstrap run: point `PULUMI_BACKEND_URL` at the
   bucket `BootstrapService` just created and run a read-only `stack ls`. If it
   fails, the workspace seam needs a login step before any stack operation.
2. **Does the inline program work from inside `app.asar`?** See Risks. This is
   the highest-value spike and gates the rest of the work. Note that the
   "no operator-editable files" decision removed the obvious fallback: seeding a
   `workDir` into `userData` would put editable infrastructure source back on
   disk. If the spike fails, the fallback is a seeded workDir *and* an accepted
   weakening of that guarantee, or the OpenTofu alternative — either way it is a
   decision to bring back, not a silent substitution.
3. **Is `pulumi refresh --preview-only` still locking DIY state**
   (pulumi/pulumi#22384) at 3.255.0? Only matters if a refresh path is added;
   note it before adding one.
4. **Does the runs table belong in the Pulumi stack at all?** It stores run
   records for the tool that manages the stack, which is a mild circularity that
   already exists under Terraform. Worth revisiting, but not in this change.

*(Two earlier open questions are now resolved. The `PULUMI_EXPERIMENTAL`
question is answered — the flags do not require it; see the update-plans
decision. The secrets-provider question is resolved — see "Keep secrets out
of the stack, then take the free secrets provider" under Decisions. The audit it
called for was done: the only secret values in the module are the two optional
Discord variables, which default to placeholders on the documented path, so the
answer was to remove the inputs rather than pay to encrypt them.)*
