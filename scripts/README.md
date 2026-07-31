# scripts/

Helper scripts for `Hyveon`. These are intentionally **not** part
of the `app/` workspace — they exist to be run from a *parent* repo that
vendors `Hyveon` as a git submodule, before any of the app's
dependencies have been installed.

## `init-parent.ts`

Interactive scaffolder for the [private parent + submodule deployment
pattern](https://codercoco.github.io/Hyveon/guides/submodule/). It generates
a self-contained `Makefile`, `terraform.tfvars`, and `.gitignore` in your
parent repo, wired to three wrapper Make targets (`setup`, `update`, `dev`).
The generated Makefile never shells out to a script or another Makefile
inside the submodule, and it does not orchestrate any infrastructure step —
no backend bootstrap, no `terraform`/Pulumi init/plan/apply. The app's own
first-run wizard and its Plan/Apply page do that directly, from the packaged
Electron app, via the AWS SDK and the Pulumi Automation API (see the
`migrate-iac-to-pulumi` OpenSpec change). Earlier revisions of this script
also had a `migrate --to-s3`/`--to-local` subcommand and a `--s3-tfvars`
bootstrap flag for switching a parent repo between a local `terraform.tfvars`
file and a maintainer-synced S3 copy of it; both were removed (task 12.3/
12.4). That S3 bucket (`${project_name}-tfvars` by default) is still very
much alive — it's the SAME bucket the app's own first-run wizard provisions
as its configuration bucket — but the *object key* those targets synced,
`terraform.tfvars`, has no consumers left now that the Terraform tree is
gone: the app exclusively reads/writes a different key,
`deployment-config.json`, as JSON. There was nothing left worth syncing.

### Usage

```bash
init-parent.ts [--force] [--yes]            Interactive bootstrap
```

From the parent (private) repo root, after adding the submodule:

```bash
git submodule add https://github.com/CoderCoco/Hyveon.git
(cd Hyveon/scripts && npm install)
node --import tsx Hyveon/scripts/init-parent.ts
# or, equivalently:
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
```

An optional leading `bootstrap` token is accepted (and ignored) for
backwards compatibility with older invocations that spelled it out
explicitly — there is only one flow now. Only a genuinely unrecognized first
token (one that isn't `bootstrap` or a `--` flag) exits `1` with
`Unknown subcommand "<token>"`.

### Flags

- `--force` — overwrite existing files instead of skipping them.
- `--yes` — accepted but currently inert. Its only prior effect was
  pre-answering the "bootstrap an S3-backed tfvars store?" prompt, removed
  along with the rest of the tfvars-sync backend (task 12.3/12.4). Kept for
  forward-compatibility; every remaining prompt (parent repo path, submodule
  path, project name, AWS region, hosted zone, Discord credentials) always
  runs interactively.

An unrecognized subcommand or an unrecognized flag prints a usage error to
stderr and exits `1`.

From inside this repo's own workspace (e.g. while developing the scaffolder
itself), the `scripts:init-parent` npm script is an equivalent way to invoke
it — pass flags after `--`:

```bash
npm run scripts:init-parent -- --force
```

`init-parent.ts` never reads or modifies anything inside the submodule, and
is safe to re-run; without `--force` it leaves existing files alone.

### Requirements

- Node.js 24+ (the same minimum the rest of the project enforces).
- `git` on `$PATH` (used to detect `.gitmodules` and to run `make setup`/
  `make update`'s submodule commands).
- Windows users should run this under WSL or Git Bash — the generated
  `Makefile` uses `bash` and `cp`, which mirrors standard Unix shell
  expectations.

## `tfvars-sync.ts`

Standalone CLI for syncing a local `terraform.tfvars`-style file with a
versioned S3 bucket: pulls, pushes, diffs, and reports status. Note that the
*bucket* it talks to is typically the SAME bucket the app itself uses as its
configuration bucket (same default name, `${project_name}-tfvars`, and both
this CLI and the app's `ConfigService.getConfigurationBucket()` read the same
`HYVEON_TFVARS_BUCKET` override) — but the *object key* is different and has
no consumers anymore. This CLI reads/writes the key `terraform.tfvars` (HCL
text); the app exclusively reads/writes a different key,
`deployment-config.json`, as JSON, via `RemoteFileStore` (see `TfvarsService`
in `desktop-main`), with no local-file fallback. Nothing reads the
`terraform.tfvars` key anymore now that the Terraform tree is gone — this
tool is only useful now for a legacy/manual copy of that dead key, not for
touching the app's real configuration.

### Usage

```bash
tsx scripts/tfvars-sync.ts pull   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts push   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts diff   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts status [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts check  [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
```

### Subcommands

- **`pull`** — downloads the remote tfvars object to `--path`, creating parent
  directories as needed, and writes a sidecar lock file recording the version
  just pulled.
- **`push`** — uploads the local `--path` file to the remote bucket/key.
  Refuses to overwrite the remote object if the local lock is missing (never
  pulled) or stale (the remote object's current version id doesn't match the
  lock's recorded version) — run `pull` again to resolve, then retry `push`.
- **`diff`** — prints a unified diff (`remote → local`) between the remote
  object and the local file. Prints `✓ local and remote match` and exits `0`
  when the contents are byte-for-byte identical; otherwise prints
  `✗ local and remote differ` and **exits `1`**.
- **`status`** — prints the bucket/key/path, whether the local file exists,
  the sidecar lock's recorded version/etag/pulled-at timestamp (or "none —
  never pulled"), the remote object's current version/etag/last-modified (or
  "object does not exist"), and whether the local lock is in sync with the
  remote version.
- **`check`** — drift gate intended for `make apply` (or any CI/pre-flight
  step): compares the local lock's recorded version id against the remote
  object's current version id. Prints `✓ in sync: ...` and **exits `0`** when
  they match; prints `✗ drift detected: <reason>` and **exits `1`** otherwise
  (no lock file, remote object missing, the bucket lacking S3 versioning, or
  a version mismatch), with a clear, specific reason in each case.

### Flags

- `--bucket <name>` — target S3 bucket. See resolution order below.
- `--path <file>` — local file to read from / write to. Defaults to
  `terraform/terraform.tfvars`.
- `--key <key>` — S3 object key. Always defaults to the fixed key
  `terraform.tfvars`, regardless of `--path` — pass it explicitly if the
  bucket should hold the object under a different key.
- `--region <region>` — AWS region override; falls back to the AWS SDK's
  default provider chain when omitted.

### `--bucket` resolution order

`--bucket` is resolved through a fallback chain when the flag is omitted:

1. The `--bucket` flag, if passed.
2. The `HYVEON_TFVARS_BUCKET` environment variable.
3. The contents of the nearest `.hyveon/tfvars-bucket` marker file, found by
   walking up from the current working directory.
4. The legacy `.gsd/tfvars-bucket` marker at the same directory (pre-rename,
   accepted with a one-time warning — run `mv .gsd .hyveon` to migrate).

The CLI exits with an error (`--bucket is required (or set
HYVEON_TFVARS_BUCKET, or create a .hyveon/tfvars-bucket or legacy
.gsd/tfvars-bucket marker file)`) if none of these resolve.

### Lock-file mechanism

A sidecar lock file (`${path}.lock`, e.g. `terraform/terraform.tfvars.lock`)
records the S3 version id, etag, size, last-modified timestamp, and
pulled-at timestamp from the last successful `pull` or `push`. On `pull`,
`lastModified` and `pulledAt` reflect the object's `LastModified` value as
observed from S3. On `push`, both fields are instead the client-side write
timestamp (`new Date().toISOString()` in `tfvars-sync.ts`, line ~393),
recorded right after the upload completes rather than read back from S3.
It is JSON and safe to inspect or commit-ignore alongside the tfvars file
it tracks.

`push` uses the lock as an optimistic-concurrency check before uploading:

- If the remote object exists but no lock file is present locally, `push`
  throws (`Run "pull" first.`) rather than overwriting an object it has
  never seen.
- If the remote object exists and the lock's `versionId` doesn't match the
  remote object's current `versionId` (i.e. someone else pushed since the
  last local `pull`), `push` throws (`Run "pull" to refresh before
  pushing.`) instead of clobbering the newer remote version.
- If the remote object doesn't exist yet, `push` proceeds without a lock
  check (first push).

On success, both `pull` and `push` (re)write the lock file with the new
version — `pull` from the version it observed on S3, `push` from the
response returned by its own upload — so the next `push` is validated
against it.

### Diff exit codes

`diff` sets `process.exitCode`:

- **`0`** — local and remote are byte-for-byte identical (`matches: true`).
- **`1`** — local and remote differ (`matches: false`); the unified diff is
  printed to stdout before the exit code is set.

### Check exit codes

`check` sets `process.exitCode`:

- **`0`** — the local lock's version id matches the remote object's current
  version id (`inSync: true`).
- **`1`** — the versions don't match, printing the specific reason: no local
  lock file was found, the remote object doesn't exist, the bucket doesn't
  appear to have S3 versioning enabled (`HeadObject` returned no
  `VersionId`, so drift can't be detected), or the lock's recorded version
  id differs from the remote's current version id. Wire this into
  `make apply` (or CI) as a pre-flight drift gate so an apply never runs
  against a `terraform.tfvars` that has silently drifted from the version
  stored in S3.

### Requirements

- Node.js 24+.
- AWS credentials resolvable by the AWS SDK v3's default credential
  provider chain (env vars, shared credentials file, IAM role, etc.).
- A region, resolved via `--region` or the SDK's own region config —
  this only selects the region and is unrelated to credential resolution.
