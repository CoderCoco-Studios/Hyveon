#!/usr/bin/env -S npx tsx
/**
 * init-parent.ts
 *
 * Interactive scaffolder for the "private parent repo + Hyveon
 * submodule" deployment pattern documented at
 * https://codercoco.github.io/Hyveon/guides/submodule/.
 *
 * Run from the parent (private) repo root:
 *
 *   cd your-private-games
 *   git submodule add https://github.com/CoderCoco/Hyveon.git
 *   (cd Hyveon/scripts && npm install)
 *   npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
 *
 * The script writes (or refuses to overwrite without --force):
 *   - Makefile           self-contained wrapper — every step (npm install,
 *                        Lambda builds, S3/DynamoDB backend bootstrap,
 *                        terraform init/plan/apply, dev servers) is inlined
 *                        directly in its recipes; it never shells out to a
 *                        script or Makefile inside the submodule
 *   - terraform.tfvars   skeleton populated from your answers
 *   - .gitignore         covers .make/, terraform.tfstate*, etc.
 *   - .hyveon/tfvars-bucket S3 backend marker (only when --s3-tfvars is passed,
 *                        or you answer yes to the interactive prompt)
 *
 * `bootstrap` (this default command) NEVER reads or modifies anything
 * inside the submodule. `migrate --to-local` is the exception — it deletes
 * the gitignored submodule-local .hyveon/tfvars-bucket marker alongside the
 * parent-root one, and `migrate --to-s3` runs `make setup`, whose self-
 * contained recipe bootstraps the S3-backed tfvars store (see
 * renderMakefile's doc comment below for the full `setup` recipe).
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, argv, cwd, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { diffTfvars, pullTfvars, lockStatus, type DiffResult, type StatusReport } from './tfvars-sync.ts';

interface Answers {
  parentDir: string;
  submoduleDir: string;
  submoduleName: string;
  projectName: string;
  awsRegion: string;
  hostedZone: string;
  configureDiscord: boolean;
  discordApplicationId?: string;
  discordBotToken?: string;
  discordPublicKey?: string;
  /** Whether an S3-backed tfvars store was requested (flag or interactive prompt), i.e. whether `.hyveon/tfvars-bucket` was written. */
  s3Tfvars?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatch
// ─────────────────────────────────────────────────────────────────────────────

/** Subcommands `init-parent.ts` dispatches on. `bootstrap` is the default when none is given. */
export type CliCommand = 'bootstrap' | 'migrate';

/** Direction for `migrate` — which way to move the parent repo's tfvars backend. */
export type MigrateDirection = 'to-s3' | 'to-local';

export interface CliArgs {
  command: CliCommand;
  force: boolean;
  /** Pre-seeds an S3 tfvars backend during bootstrap. Only meaningful when `command === 'bootstrap'`. */
  s3Tfvars: boolean;
  /** Skips interactive confirmation prompts. Valid for both subcommands. */
  yes: boolean;
  /** Only meaningful when `command === 'migrate'`; always set once parsing succeeds (migrate requires exactly one direction). */
  direction?: MigrateDirection;
}

/** Thrown by {@link parseCliArgs} for an unrecognized subcommand, an unrecognized flag, or an invalid flag combination. Callers should print `err.message` plus {@link USAGE} to stderr and exit 1. */
export class CliUsageError extends Error {}

export const USAGE = `Usage:
  init-parent.ts [--force] [--s3-tfvars] [--yes]            Interactive bootstrap (default)
  init-parent.ts migrate --to-s3 | --to-local [--yes]        Migrate an existing parent repo's tfvars backend
`;

/**
 * Parses `init-parent.ts`'s CLI args (i.e. `argv.slice(2)`) into a subcommand
 * plus its flags. `bootstrap` is implied when the first token isn't a known
 * subcommand (so existing invocations like `tsx init-parent.ts --force` keep
 * working unchanged), but it can also be given explicitly as the first token
 * (`tsx init-parent.ts bootstrap --s3-tfvars`), matching the docs/Makefile
 * comments that spell out the subcommand. Throws {@link CliUsageError} for an
 * unrecognized subcommand, an unrecognized flag for the resolved subcommand,
 * or (for `migrate`) anything other than exactly one of `--to-s3` /
 * `--to-local`. Pure and side-effect free, so it's directly unit-testable.
 */
export function parseCliArgs(args: string[]): CliArgs {
  const rest = [...args];
  let command: CliCommand = 'bootstrap';

  if (rest[0] === 'migrate') {
    command = 'migrate';
    rest.shift();
  } else if (rest[0] === 'bootstrap') {
    command = 'bootstrap';
    rest.shift();
  } else if (rest[0] !== undefined && rest[0].startsWith('--') === false) {
    throw new CliUsageError(`Unknown subcommand "${rest[0]}".`);
  }

  const knownFlags: readonly string[] =
    command === 'bootstrap' ? ['--force', '--s3-tfvars', '--yes'] : ['--to-s3', '--to-local', '--yes'];

  for (const token of rest) {
    if (!knownFlags.includes(token)) {
      throw new CliUsageError(`Unknown flag "${token}" for ${command === 'bootstrap' ? 'the default bootstrap command' : "'migrate'"}.`);
    }
  }

  const force = rest.includes('--force');
  const s3Tfvars = rest.includes('--s3-tfvars');
  const yes = rest.includes('--yes');

  if (command === 'bootstrap') {
    return { command, force, s3Tfvars, yes };
  }

  const hasS3 = rest.includes('--to-s3');
  const hasLocal = rest.includes('--to-local');
  if (hasS3 === hasLocal) {
    throw new CliUsageError('migrate requires exactly one of --to-s3 | --to-local.');
  }

  return { command, force, s3Tfvars, yes, direction: hasS3 ? 'to-s3' : 'to-local' };
}

/** Mutable so it can be set once `parseCliArgs` has run at entrypoint time; `writeIfSafe` reads it below. */
let FORCE = false;

// ─────────────────────────────────────────────────────────────────────────────
// Path detection
// ─────────────────────────────────────────────────────────────────────────────

/** Walk up from `start` until a directory containing `.gitmodules` is found. */
function findParentRepoRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.gitmodules'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Best-effort guess of the submodule path inside the parent repo. */
function detectSubmodulePath(parentDir: string, scriptDir: string): string {
  // If the script lives at <parent>/<submodule>/scripts/init-parent.ts,
  // the submodule directory name is the immediate parent of `scripts/`.
  const submoduleRoot = dirname(scriptDir);
  const rel = relative(parentDir, submoduleRoot);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;

  // Fall back to parsing .gitmodules.
  const gm = join(parentDir, '.gitmodules');
  if (existsSync(gm)) {
    const m = readFileSync(gm, 'utf8').match(/path\s*=\s*(\S+)/);
    if (m) return m[1];
  }
  return 'Hyveon';
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompting
// ─────────────────────────────────────────────────────────────────────────────

async function ask(rl: Interface, label: string, def?: string): Promise<string> {
  const suffix = def === undefined ? ': ' : ` [${def}]: `;
  const raw = (await rl.question(label + suffix)).trim();
  return raw || def || '';
}

async function askBool(rl: Interface, label: string, def: boolean): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N';
  const raw = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase();
  if (!raw) return def;
  return raw.startsWith('y');
}

async function askRequired(rl: Interface, label: string, def?: string): Promise<string> {
  while (true) {
    const v = await ask(rl, label, def);
    if (v) return v;
    output.write('  ↳ a value is required.\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the structure documented in the Makefile-driven submodule pattern.
 * Every step is inlined directly in the recipes below — this Makefile never
 * shells out to a script or another Makefile inside the submodule:
 *   setup → init submodule, `npm install`, build the Lambda bundles, derive
 *            project_name/aws_region from terraform.tfvars, bootstrap the
 *            Terraform S3 state bucket + DynamoDB lock table if they don't
 *            already exist, optionally bootstrap a versioned S3 bucket for
 *            terraform.tfvars itself via the separate terraform/bootstrap
 *            module, then `terraform init`. Pulls tfvars from S3 afterwards
 *            if a tfvars backend was just bootstrapped.
 *   plan  → auto-pull tfvars from S3 (unless NO_PULL=1), copy tfvars in,
 *            rebuild the Lambda bundles, then `terraform plan` directly.
 *   apply → check tfvars are in sync with S3 first (unless FORCE_APPLY=1),
 *            copy tfvars in, rebuild the Lambda bundles, then
 *            `terraform apply` directly, printing a post-deploy checklist.
 *   update → bump the submodule, then unconditionally `terraform init`
 *            again — cheap and idempotent, so there's no drift-detection
 *            stamp deciding whether to rerun it.
 *   dev   → pull live tfstate into .make/, then `npm run app:dev` directly
 *            in the submodule.
 *
 * Three extra targets — tfvars-pull, tfvars-push, tfvars-diff — wrap
 * scripts/tfvars-sync.ts for manual use. plan/apply's auto-pull/check are
 * gated on TFVARS_BACKEND, which resolves to "s3" or "local" in this order:
 *   1. HYVEON_TFVARS_BACKEND=s3    — force s3, even without a marker file yet
 *   2. HYVEON_TFVARS_BACKEND=local — force local, even if a marker file exists
 *   3. otherwise: "s3" when the `.hyveon/tfvars-bucket` marker file at the
 *      *parent repo root* exists (written up-front by `init-parent bootstrap
 *      --s3-tfvars` / `migrate --to-s3`, before `setup`'s own S3 tfvars
 *      bootstrap step has ever run)
 *   4. otherwise: "s3" when the same-named marker file `setup`'s own S3
 *      tfvars bootstrap step writes *inside the submodule directory* exists,
 *      else "local"
 * The parent-root marker always wins over the submodule marker when both are
 * present. When TFVARS_BACKEND is "local", plan/apply/setup behave exactly as
 * before — no S3 calls are made. setup's post-bootstrap pull applies the
 * same override semantics but re-implements them directly in its shell
 * recipe rather than referencing TFVARS_BACKEND — see the comment on that
 * recipe below for why.
 *
 * Both marker checks above also accept the pre-rename `.gsd/tfvars-bucket`
 * path as a read fallback when the new `.hyveon/tfvars-bucket` path isn't
 * present, so an already-scaffolded parent repo that bootstrapped an S3
 * backend before the `dev.gsd.desktop` → `dev.hyveon.desktop` rename keeps
 * working without a `mv .gsd .hyveon` migration step — this Makefile
 * template never *writes* the legacy path, only reads it (see
 * `renderMakefile`'s own comment on `PARENT_TFVARS_MARKER`/`TFVARS_MARKER`).
 *
 * Only reads `submoduleDir` and `projectName` off `a`, so it accepts a
 * `Pick<Answers, ...>` rather than a full `Answers` — `runMigrate` re-renders
 * the Makefile from an already-scaffolded parent repo without re-collecting
 * every bootstrap answer.
 */
export function renderMakefile(a: Pick<Answers, 'submoduleDir' | 'projectName'>): string {
  return `SHELL      := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REPO_ROOT   := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SUBMODULE   := $(REPO_ROOT)/${a.submoduleDir}
TF_DIR      := $(SUBMODULE)/terraform
TFVARS      := $(REPO_ROOT)/terraform.tfvars
STAMP_DIR   := $(REPO_ROOT)/.make

# ── S3 tfvars backend detection ──────────────────────────────────────────────
# TFVARS_MARKER is the bucket-name marker file setup's own S3 tfvars-bootstrap
# step (below) writes when it bootstraps the versioned S3 tfvars backend.
# PARENT_TFVARS_MARKER is the sibling marker \`init-parent bootstrap
# --s3-tfvars\` (and \`migrate --to-s3\`) write directly at the parent repo
# root — before \`setup\` has ever run — recording an operator's up-front
# choice to run in S3 mode. It always takes priority over TFVARS_MARKER: an
# explicit parent-root marker reflects a deliberate choice, so it should win
# even before \`setup\` gets a chance to write its own submodule-local marker.
# Each resolves to the new \`.hyveon/tfvars-bucket\` path if present, else the
# pre-rename \`.gsd/tfvars-bucket\` path if *that's* present (an already-
# scaffolded parent repo that hasn't run \`mv .gsd .hyveon\` yet — this
# Makefile template only ever *writes* the new path, so an un-migrated repo
# keeps resolving its existing S3 backend instead of silently going local),
# else the new path (so a from-scratch bootstrap still writes/looks up
# \`.hyveon/...\`).
# TFVARS_LOCK is the sidecar lock file tfvars-sync.ts writes after every
# successful pull/push, recording the S3 version id/etag last synced.
PARENT_TFVARS_MARKER := $(firstword $(wildcard $(REPO_ROOT)/.hyveon/tfvars-bucket $(REPO_ROOT)/.gsd/tfvars-bucket) $(REPO_ROOT)/.hyveon/tfvars-bucket)
TFVARS_MARKER := $(firstword $(wildcard $(SUBMODULE)/.hyveon/tfvars-bucket $(SUBMODULE)/.gsd/tfvars-bucket) $(SUBMODULE)/.hyveon/tfvars-bucket)
# Canonical write target for a freshly-bootstrapped submodule marker — always
# the new \`.hyveon\` path, even when TFVARS_MARKER above resolved to the
# legacy \`.gsd\` path for reading. \`setup\`'s S3 bootstrap step (below) writes
# here so every fresh/re-run bootstrap converges on the new location instead
# of perpetually re-writing the legacy one.
TFVARS_MARKER_NEW := $(SUBMODULE)/.hyveon/tfvars-bucket
TFVARS_LOCK   := $(TFVARS).lock

# TFVARS_BACKEND resolves the s3-vs-local decision explicitly, so an operator
# can always force one or the other regardless of what's on disk:
#   - HYVEON_TFVARS_BACKEND=s3    → force s3, even if the marker file is missing
#   - HYVEON_TFVARS_BACKEND=local → force local, even if a marker file is present
#   - unset                    → s3 when the parent-root marker exists, else
#                                 s3 when the submodule marker exists, else
#                                 local
# Recursive ('=', not ':='), so \$(wildcard ...) is re-evaluated whenever this
# variable is referenced from a *separate* \`make\` invocation (plan, apply,
# tfvars-pull, etc. all see current marker-file state that way). It must NOT
# be used to gate \`setup\`'s S3 tfvars-bootstrap step or its post-bootstrap
# pull: GNU Make expands a rule's entire recipe before running the first line
# of that recipe, so a reference to this variable inside the same \`setup\`
# recipe that writes TFVARS_MARKER would still see the pre-bootstrap
# filesystem state even though it appears later in the recipe text. \`setup\`
# re-implements the same override logic directly in its shell recipe instead
# — see below.
TFVARS_BACKEND = $(if $(filter s3,$(HYVEON_TFVARS_BACKEND)),s3,$(if $(filter local,$(HYVEON_TFVARS_BACKEND)),local,$(if $(wildcard $(PARENT_TFVARS_MARKER)),s3,$(if $(wildcard $(TFVARS_MARKER)),s3,local))))

# TFVARS_BUCKET is display-only (used in log messages below); HYVEON_TFVARS_BUCKET
# wins if already set, otherwise the parent-root marker's contents, otherwise
# the submodule marker's contents.
TFVARS_BUCKET = $(if $(HYVEON_TFVARS_BUCKET),$(HYVEON_TFVARS_BUCKET),$(shell cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null))
# TFVARS_SYNC is deliberately just the interpreter invocation with no
# subcommand or flags: tfvars-sync.ts's parseArgs() requires the subcommand
# (pull/push/check/diff) to be argv[0], so every call site must render
# "$(TFVARS_SYNC) <subcommand> $(TFVARS_SYNC_ARGS)" — never put flags before
# the subcommand.
TFVARS_SYNC      = npx --prefix $(SUBMODULE)/scripts tsx $(SUBMODULE)/scripts/tfvars-sync.ts
TFVARS_SYNC_ARGS = --path $(TFVARS) --bucket "$\${HYVEON_TFVARS_BUCKET:-$$(cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null)}"

.PHONY: help setup plan apply update dev copy-tfvars pull-tfvars-if-needed check-tfvars-if-needed tfvars-pull tfvars-push tfvars-diff

# ── Help ─────────────────────────────────────────────────────────────────────
help:
\t@echo "${a.projectName} — submodule deployment wrapper"
\t@echo ""
\t@echo "  make setup         One-time bootstrap: init submodule, install deps, build lambdas,"
\t@echo "                     create the Terraform S3 state backend, terraform init"
\t@echo "                     (pulls terraform.tfvars from S3 afterwards if this bootstrapped a tfvars backend)"
\t@echo "  make plan          Copy tfvars into submodule then terraform plan"
\t@echo "                     (auto-pulls tfvars from S3 first when a backend is detected; NO_PULL=1 to skip)"
\t@echo "  make apply         Copy tfvars into submodule then terraform apply"
\t@echo "                     (checks tfvars are in sync with S3 first when a backend is detected; FORCE_APPLY=1 to skip)"
\t@echo "  make update        Pull latest ${a.submoduleDir}/main; re-init terraform"
\t@echo "  make dev           Launch the Hyveon desktop app in dev mode (electron-vite)"
\t@echo "  make tfvars-pull   Pull terraform.tfvars from the S3 backend (requires one to be configured)"
\t@echo "  make tfvars-push   Push terraform.tfvars to the S3 backend"
\t@echo "  make tfvars-diff   Show a unified diff between local and remote terraform.tfvars"
\t@echo ""
\t@echo "  S3 tfvars backend detection: HYVEON_TFVARS_BACKEND=s3|local overrides;"
\t@echo "  otherwise inferred from $(PARENT_TFVARS_MARKER), falling back to $(TFVARS_MARKER)."

# ── Stamp dir ────────────────────────────────────────────────────────────────
$(STAMP_DIR):
\t@mkdir -p $@

# ── One-time setup ───────────────────────────────────────────────────────────
# Fully self-contained: no external setup.sh, no delegating to a Makefile
# inside the submodule. Every step below is inlined directly.
setup: | $(STAMP_DIR)
\tgit submodule update --init --recursive
\tcd $(SUBMODULE) && npm install
\tcd $(SUBMODULE) && npm run app:build:lambdas
# Copy the parent's terraform.tfvars into the submodule *before* deriving
# the project name/region below (mirroring the copy-tfvars target further
# down), so the S3 state bucket, DynamoDB lock table, and (if requested) S3
# tfvars bucket this recipe creates are all named after the same
# project_name PARENT_TFVARS_MARKER (if any) was derived from, rather than
# whatever project_name happens to already be checked into
# $(TF_DIR)/terraform.tfvars.
# Guarded: a parent repo that migrated to S3 a while ago may have no local
# $(TFVARS) at all (see docs/docs/guides/submodule.md) — a fresh clone of
# such a parent must still be able to run \`make setup\` under -eu. We
# deliberately do NOT fall back to terraform.tfvars.example here: its
# checked-in project_name ("${a.projectName}") is unrelated to this parent
# repo's actual project and would silently win over the correct fallback
# below. terraform init doesn't need terraform.tfvars to exist — only
# plan/apply do, by which point the post-bootstrap S3 pull further down has
# had a chance to seed $(TFVARS) for real.
\tif [ -f $(TFVARS) ]; then cp $(TFVARS) $(TF_DIR)/terraform.tfvars; fi
# Derive project_name/aws_region from terraform.tfvars when we just copied a
# real one in — the same grep/sed extraction the old setup.sh used —
# falling back to this Makefile's own known project name / setup.sh's own
# us-east-1 default when $(TFVARS) doesn't exist yet or a key is genuinely
# absent. Cached under $(STAMP_DIR) so later recipe lines (each its own
# shell invocation) don't have to re-derive them.
\t@if [ -f $(TF_DIR)/terraform.tfvars ]; then \\
\t  PROJECT=$$(grep -E '^[[:space:]]*project_name[[:space:]]*=' $(TF_DIR)/terraform.tfvars | head -1 | sed -E 's/.*=[[:space:]]*"(.*)".*/\\1/' || true); \\
\t  REGION=$$(grep -E '^[[:space:]]*aws_region[[:space:]]*=' $(TF_DIR)/terraform.tfvars | head -1 | sed -E 's/.*=[[:space:]]*"(.*)".*/\\1/' || true); \\
\t else \\
\t  PROJECT=""; REGION=""; \\
\t fi; \\
\t if [ -z "$$PROJECT" ]; then PROJECT="${a.projectName}"; fi; \\
\t if [ -z "$$REGION" ]; then REGION="us-east-1"; fi; \\
\t echo "$$PROJECT" > $(STAMP_DIR)/tf-project; \\
\t echo "$$REGION" > $(STAMP_DIR)/tf-region
# Create the Terraform state S3 bucket + DynamoDB lock table if they don't
# already exist yet — same aws s3api/dynamodb commands and flags setup.sh
# used.
\t@TF_PROJECT=$$(cat $(STAMP_DIR)/tf-project); TF_REGION=$$(cat $(STAMP_DIR)/tf-region); \\
\t TF_STATE_BUCKET="$$TF_PROJECT-tf-state"; TF_LOCK_TABLE="$$TF_PROJECT-tf-locks"; \\
\t echo "Bootstrapping S3 backend (bucket: $$TF_STATE_BUCKET, region: $$TF_REGION)..."; \\
\t if aws s3api head-bucket --bucket "$$TF_STATE_BUCKET" --region "$$TF_REGION" 2>/dev/null; then \\
\t   echo "   S3 bucket $$TF_STATE_BUCKET already exists — skipping."; \\
\t else \\
\t   echo "   Creating S3 bucket $$TF_STATE_BUCKET..."; \\
\t   if [ "$$TF_REGION" = us-east-1 ]; then \\
\t     aws s3api create-bucket --bucket "$$TF_STATE_BUCKET" --region "$$TF_REGION"; \\
\t   else \\
\t     aws s3api create-bucket --bucket "$$TF_STATE_BUCKET" --region "$$TF_REGION" --create-bucket-configuration "LocationConstraint=$$TF_REGION"; \\
\t   fi; \\
\t   aws s3api put-bucket-versioning --bucket "$$TF_STATE_BUCKET" --versioning-configuration Status=Enabled --region "$$TF_REGION"; \\
\t   aws s3api put-public-access-block --bucket "$$TF_STATE_BUCKET" --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" --region "$$TF_REGION"; \\
\t   aws s3api put-bucket-encryption --bucket "$$TF_STATE_BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' --region "$$TF_REGION"; \\
\t fi; \\
\t if aws dynamodb describe-table --table-name "$$TF_LOCK_TABLE" --region "$$TF_REGION" >/dev/null 2>&1; then \\
\t   echo "   DynamoDB table $$TF_LOCK_TABLE already exists — skipping."; \\
\t else \\
\t   echo "   Creating DynamoDB lock table $$TF_LOCK_TABLE..."; \\
\t   aws dynamodb create-table --table-name "$$TF_LOCK_TABLE" --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region "$$TF_REGION"; \\
\t   echo "   Waiting for DynamoDB table to become ACTIVE..."; \\
\t   aws dynamodb wait table-exists --table-name "$$TF_LOCK_TABLE" --region "$$TF_REGION"; \\
\t fi
# Bootstrap the versioned S3 tfvars bucket via the separate
# $(SUBMODULE)/terraform/bootstrap module (same logic as the old setup.sh's
# bootstrap_tfvars_backend()), gated on HYVEON_TFVARS_BACKEND=s3 or the
# parent-root marker already being present. Writes the resulting bucket name
# to TFVARS_MARKER_NEW ($(SUBMODULE)/.hyveon/tfvars-bucket) — always the new
# path, even on a repo that resolved TFVARS_MARKER to the legacy \`.gsd\` path
# above, so every bootstrap run converges the submodule marker onto the new
# location — so PARENT_TFVARS_MARKER (written up-front by \`init-parent
# bootstrap --s3-tfvars\`/\`migrate --to-s3\`, if present) still takes priority
# over it, per TFVARS_BACKEND/TFVARS_BUCKET's own precedence documented above.
\t@TF_PROJECT=$$(cat $(STAMP_DIR)/tf-project); TF_REGION=$$(cat $(STAMP_DIR)/tf-region); \\
\t BACKEND="$\${HYVEON_TFVARS_BACKEND:-}"; \\
\t if [ -z "$$BACKEND" ] && [ -f $(PARENT_TFVARS_MARKER) ]; then BACKEND=s3; fi; \\
\t if [ "$$BACKEND" != s3 ]; then \\
\t   echo "   tfvars backend: local (skipping S3 tfvars-bucket bootstrap)"; \\
\t else \\
\t   echo ""; \\
\t   echo "Bootstrapping tfvars S3 bucket ($(SUBMODULE)/terraform/bootstrap)..."; \\
\t   terraform -chdir=$(SUBMODULE)/terraform/bootstrap init -input=false; \\
\t   terraform -chdir=$(SUBMODULE)/terraform/bootstrap apply -auto-approve -input=false -var="project_name=$$TF_PROJECT" -var="aws_region=$$TF_REGION"; \\
\t   BUCKET=$$(terraform -chdir=$(SUBMODULE)/terraform/bootstrap output -raw tfvars_bucket_name); \\
\t   mkdir -p $(SUBMODULE)/.hyveon; \\
\t   echo "$$BUCKET" > $(TFVARS_MARKER_NEW); \\
\t   echo "   Bucket name recorded at $(TFVARS_MARKER_NEW): $$BUCKET"; \\
\t   if [ -f $(TFVARS) ]; then \\
\t     if aws s3api head-object --bucket "$$BUCKET" --key terraform.tfvars --region "$$TF_REGION" >/dev/null 2>&1; then \\
\t       echo "   s3://$$BUCKET/terraform.tfvars already exists — skipping upload."; \\
\t     else \\
\t       echo "   Uploading local terraform.tfvars to s3://$$BUCKET/terraform.tfvars..."; \\
\t       aws s3 cp $(TFVARS) "s3://$$BUCKET/terraform.tfvars" --region "$$TF_REGION"; \\
\t     fi; \\
\t   fi; \\
\t fi
# terraform init with the same -backend-config flags setup.sh used. If a
# local terraform.tfstate is already sitting in $(TF_DIR) (a pre-existing
# local-backend deployment), migrate it into the new S3 backend the same way
# setup.sh did, auto-confirming so this doesn't hang waiting on stdin.
\t@TF_PROJECT=$$(cat $(STAMP_DIR)/tf-project); TF_REGION=$$(cat $(STAMP_DIR)/tf-region); \\
\t TF_STATE_BUCKET="$$TF_PROJECT-tf-state"; TF_LOCK_TABLE="$$TF_PROJECT-tf-locks"; \\
\t echo ""; \\
\t echo "Initializing Terraform..."; \\
\t if [ -f $(TF_DIR)/terraform.tfstate ]; then \\
\t   echo "   Local terraform.tfstate detected — migrating state to S3..."; \\
\t   echo yes | terraform -chdir=$(TF_DIR) init -migrate-state -backend-config="bucket=$$TF_STATE_BUCKET" -backend-config="key=$$TF_PROJECT/terraform.tfstate" -backend-config="region=$$TF_REGION" -backend-config="dynamodb_table=$$TF_LOCK_TABLE" -backend-config="encrypt=true"; \\
\t else \\
\t   terraform -chdir=$(TF_DIR) init -backend-config="bucket=$$TF_STATE_BUCKET" -backend-config="key=$$TF_PROJECT/terraform.tfstate" -backend-config="region=$$TF_REGION" -backend-config="dynamodb_table=$$TF_LOCK_TABLE" -backend-config="encrypt=true"; \\
\t fi
# Runtime (not parse-time) check, evaluated entirely inside this shell
# command: GNU Make expands a rule's whole recipe — including any
# $(wildcard ...)/$(shell ...) calls hiding inside TFVARS_BACKEND/
# TFVARS_BUCKET — before running the first line of that recipe, so a
# make-variable-based check here would still see the filesystem from before
# the S3 tfvars bootstrap step (above) ran, even though it's written later
# in the recipe text. Mirror TFVARS_BACKEND's own HYVEON_TFVARS_BACKEND override
# semantics by hand, and defer both marker-file tests and their \`cat\` to the
# shell so they see whatever the bootstrap step above just wrote. The
# parent-root marker (if any) is checked first, same precedence as
# TFVARS_BACKEND/TFVARS_BUCKET above.
\t@if [ "$\${HYVEON_TFVARS_BACKEND:-}" = s3 ] || { [ "$\${HYVEON_TFVARS_BACKEND:-}" != local ] && { [ -f $(PARENT_TFVARS_MARKER) ] || [ -f $(TFVARS_MARKER) ]; }; }; then \\
\t  bucket="$\${HYVEON_TFVARS_BUCKET:-$$(cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null)}"; \\
\t  if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — skipping S3 pull to avoid clobbering them (commit or stash them, then run 'make tfvars-pull')." >&2; \\
\t  else \\
\t    echo "S3 tfvars backend detected (s3://$$bucket) — pulling terraform.tfvars..."; \\
\t    if pull_out=$$($(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS) 2>&1); then \\
\t      echo "$$pull_out"; \\
\t    elif echo "$$pull_out" | grep -qi 'NoSuchKey\\|specified key does not exist'; then \\
\t      echo "no tfvars object found in s3://$$bucket yet — run 'make tfvars-push' to seed the bucket" >&2; \\
\t    else \\
\t      echo "$$pull_out" >&2; \\
\t      echo "tfvars pull failed — aborting setup; check credentials/network, then run 'make tfvars-pull' once resolved" >&2; \\
\t      exit 1; \\
\t    fi; \\
\t  fi; \\
\t fi

# ── Copy tfvars into the submodule terraform dir ─────────────────────────────
$(TF_DIR)/terraform.tfvars: $(TFVARS)
\tcp $(TFVARS) $@

# Force a fresh copy on every plan/apply so stale vars can't slip through.
copy-tfvars: $(TFVARS)
\tcp $(TFVARS) $(TF_DIR)/terraform.tfvars

# ── Terraform targets ────────────────────────────────────────────────────────
# Internal gates: silently no-op in local mode (TFVARS_BACKEND=local) so
# plan/apply behave exactly as they did before S3 sync existed.
# pull-tfvars-if-needed guards against clobbering uncommitted local edits the
# same way the manual tfvars-pull target does below: a pull overwrites
# $(TFVARS) in place, so if git sees it as dirty we abort instead of silently
# discarding the operator's changes (NO_PULL=1 still skips the pull entirely).
pull-tfvars-if-needed:
\t@if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$\${NO_PULL:-}" ]; then \\
\t  if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — commit or stash them before pulling from S3 (or rerun with NO_PULL=1)." >&2; exit 1; fi; \\
\t  $(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS); \\
\t fi

check-tfvars-if-needed:
\t@if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$\${FORCE_APPLY:-}" ]; then $(TFVARS_SYNC) check $(TFVARS_SYNC_ARGS); fi

# plan auto-pulls the latest tfvars from S3 first (skip with NO_PULL=1), so a
# stale local copy can't silently drive \`terraform plan\`. In local mode
# pull-tfvars-if-needed is a no-op and this is unchanged from before. Rebuilds
# the Lambda bundles first — archive_file reads the CJS bundles at plan time.
plan: pull-tfvars-if-needed copy-tfvars
\tcd $(SUBMODULE) && npm run app:build:lambdas
\tterraform -chdir=$(TF_DIR) plan

# apply checks tfvars are still in sync with S3 first (skip with
# FORCE_APPLY=1), so drift can't silently drive \`terraform apply\`. In local
# mode check-tfvars-if-needed is a no-op and this is unchanged from before.
apply: check-tfvars-if-needed copy-tfvars
\tcd $(SUBMODULE) && npm run app:build:lambdas
\tterraform -chdir=$(TF_DIR) apply
\t@echo ""
\t@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
\t@echo "  Post-deploy checklist"
\t@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
\t@INVOKE_URL=$$(terraform -chdir=$(TF_DIR) output -raw interactions_invoke_url 2>/dev/null || true); \\
\t  echo ""; \\
\t  echo "  Interactions Endpoint URL (copy this):"; \\
\t  echo "    $\${INVOKE_URL:-(not available - did apply succeed?)}"; \\
\t  echo ""; \\
\t  echo "  1. Paste the URL above into the Discord Developer Portal:"; \\
\t  echo "     App -> General Information -> Interactions Endpoint URL"; \\
\t  echo ""; \\
\t  echo "  2. Enter bot token + public key in the management app Credentials tab"; \\
\t  echo "     (skip if already pre-seeded in terraform.tfvars)"; \\
\t  echo ""; \\
\t  echo "  3. Click 'Register commands' in the management app for each guild"
\t@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Manual remote tfvars sync (gated on TFVARS_BACKEND) ─────────────────────
# Unlike the internal gates above, these fail fast with a pointer to
# configure a backend instead of silently no-opping — they're operator-driven.
# tfvars-pull additionally refuses to clobber uncommitted local edits: a pull
# overwrites $(TFVARS) in place, so if git sees it as dirty we abort instead
# of silently discarding the operator's changes.
tfvars-pull:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set HYVEON_TFVARS_BACKEND=s3 (with HYVEON_TFVARS_BUCKET) or run 'make setup' with an S3 tfvars backend requested." >&2; exit 1; fi
\t@if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — commit or stash them before pulling from S3." >&2; exit 1; fi
\t$(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS)

tfvars-push:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set HYVEON_TFVARS_BACKEND=s3 (with HYVEON_TFVARS_BUCKET) or run 'make setup' with an S3 tfvars backend requested." >&2; exit 1; fi
\t$(TFVARS_SYNC) push $(TFVARS_SYNC_ARGS)

tfvars-diff:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set HYVEON_TFVARS_BACKEND=s3 (with HYVEON_TFVARS_BUCKET) or run 'make setup' with an S3 tfvars backend requested." >&2; exit 1; fi
\t$(TFVARS_SYNC) diff $(TFVARS_SYNC_ARGS)

# ── Submodule update ──────────────────────────────────────────────────────────
# Bumps the submodule then unconditionally re-runs \`terraform init\` — cheap
# and idempotent, so there's no need for setup.sh-style sha-based
# drift-detection to decide whether to rerun it. Re-supplies the same
# -backend-config flags \`setup\` used (from the tf-project/tf-region stamps
# it wrote, not a bare \`terraform init\` relying on the .terraform/ cache) —
# \`update\` is exactly the target most likely to need a reconfigure, since
# the submodule bump on the line above is what could change the backend
# block, and a bare init against an already-configured partial backend can
# hang or fail waiting on stdin if the cache is ever cleared.
update: | $(STAMP_DIR)
\tgit submodule update --remote --merge $(SUBMODULE)
\t@if [ ! -f $(STAMP_DIR)/tf-project ]; then echo "Run 'make setup' first." >&2; exit 1; fi
\tTF_PROJECT=$$(cat $(STAMP_DIR)/tf-project); TF_REGION=$$(cat $(STAMP_DIR)/tf-region); \\
\tterraform -chdir=$(TF_DIR) init -input=false -backend-config="bucket=$$TF_PROJECT-tf-state" -backend-config="key=$$TF_PROJECT/terraform.tfstate" -backend-config="region=$$TF_REGION" -backend-config="dynamodb_table=$$TF_PROJECT-tf-locks" -backend-config="encrypt=true"
\t@echo ""
\t@echo "Submodule updated. Commit the new pointer when ready:"
\t@echo "  git add ${a.submoduleDir} && git commit -m 'chore: bump ${a.submoduleDir}'"

# ── Dev server ───────────────────────────────────────────────────────────────
# Pull live tfstate into a temp file and point ConfigService at it via
# TF_STATE_PATH; falls back to null when the backend isn't reachable yet
# (e.g. before the first apply).
dev: | $(STAMP_DIR)
\tterraform -chdir=$(TF_DIR) state pull > $(STAMP_DIR)/tfstate.json 2>/dev/null || echo 'null' > $(STAMP_DIR)/tfstate.json
\trm -f $(SUBMODULE)/app/packages/*/tsconfig*.tsbuildinfo
\tcd $(SUBMODULE) && TF_STATE_PATH=$(STAMP_DIR)/tfstate.json npm run app:dev
`;
}

/**
 * Skeleton tfvars derived from the public terraform.tfvars.example shape. We
 * fill in the few things we just asked the user about and leave the rest as
 * commented examples.
 */
export function renderTfvars(a: Answers): string {
  const discordBlock =
    a.configureDiscord && a.discordApplicationId && a.discordBotToken && a.discordPublicKey
      ? `discord_application_id = "${a.discordApplicationId}"
discord_bot_token      = "${a.discordBotToken}"
discord_public_key     = "${a.discordPublicKey}"
`
      : `# discord_application_id = "1234567890"
# discord_bot_token      = "MTIz...xyz"
# discord_public_key     = "0123abc..."
`;

  return `# ${a.projectName} — Terraform variables.
# Commit this file to your private parent repo. The wrapper Makefile copies it
# into ${a.submoduleDir}/terraform/terraform.tfvars on every plan/apply, where
# the submodule's own .gitignore prevents it from being committed back.

aws_region   = "${a.awsRegion}"
project_name = "${a.projectName}"

# Hosted zone in Route 53. {game}.${a.hostedZone} records are managed by Lambda.
hosted_zone_name = "${a.hostedZone}"

# Watchdog: auto-shuts down idle servers after (interval × idle_checks) minutes.
watchdog_interval_minutes = 15
watchdog_idle_checks      = 4
watchdog_min_packets      = 100

# acm_certificate_domain = "*.${a.hostedZone}"

# Discord bot credentials (optional — leave commented out to configure via the web UI).
${discordBlock}
# base_allowed_guilds  = ["123456789012345678"]
# base_admin_user_ids  = ["987654321098765432"]
# base_admin_role_ids  = []

# Game server definitions. See ${a.submoduleDir}/terraform/terraform.tfvars.example
# for the full schema.
game_servers = {
  # palworld = {
  #   image  = "thijsvanloef/palworld-server-docker:latest"
  #   cpu    = 2048
  #   memory = 8192
  #   ports = [
  #     { container = 8211,  protocol = "udp" },
  #     { container = 27015, protocol = "udp" },
  #   ]
  #   environment = [
  #     { name = "PLAYERS",     value = "8" },
  #     { name = "SERVER_NAME", value = "My Palworld Server" },
  #   ]
  #   volumes = [
  #     { name = "saves", container_path = "/palworld" },
  #   ]
  #   https = false
  # }
}
`;
}

export function renderGitignore(a: Answers): string {
  return `# ${a.projectName} — parent repo .gitignore

# Local environment overrides, if you ever add any
.env
.env.*
!.env.example

# Make stamp dir (cached tf-project/tf-region/tfstate.json, ...)
.make/

# Terraform local state, if you ever fall off the S3 backend
terraform.tfstate
terraform.tfstate.backup
*.tfvars.local

# tfvars-sync.ts sidecar lock file (S3 version/etag metadata, not a secret,
# but machine-local and irrelevant to commit)
*.tfvars.lock

# Editor / OS noise
.DS_Store
.vscode/
.idea/
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IO helpers
// ─────────────────────────────────────────────────────────────────────────────

function writeIfSafe(path: string, contents: string): 'wrote' | 'skipped' | 'overwrote' {
  if (existsSync(path) && !FORCE) {
    return 'skipped';
  }
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return existed ? 'overwrote' : 'wrote';
}

function status(path: string, action: 'wrote' | 'skipped' | 'overwrote' | 'deleted', parentDir: string): void {
  const rel = relative(parentDir, path) || path;
  const tag =
    action === 'wrote'
      ? '  +'
      : action === 'overwrote'
        ? '  ~'
        : action === 'deleted'
          ? '  -'
          : '  ·';
  const note = action === 'skipped' ? '  (exists — use --force to overwrite)' : '';
  output.write(`${tag} ${rel}${note}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function isValidProjectName(s: string): boolean {
  // Used as part of S3 bucket names by the generated Makefile's `setup`
  // recipe — keep it conservative.
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s);
}

function isValidRegion(s: string): boolean {
  return /^[a-z]{2,3}-[a-z]+-\d$/.test(s);
}

function isValidDomain(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap (the pre-existing interactive flow, unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/** Flags from {@link parseCliArgs} that {@link runBootstrap} cares about. */
export interface BootstrapOptions {
  /** Pre-answers the "bootstrap an S3-backed tfvars store?" prompt with yes, skipping it. */
  s3Tfvars: boolean;
  /** Skips the interactive prompt entirely when `s3Tfvars` wasn't already passed, defaulting to no. */
  yes: boolean;
  /** Overwrites existing Makefile/terraform.tfvars/.gitignore instead of skipping them. Mirrors the module-level `FORCE` flag so callers of the exported API (not just the CLI entrypoint) can drive `--force` behaviour. */
  force?: boolean;
}

/** The interactive bootstrap flow: prompts for parent-repo details and writes Makefile/terraform.tfvars/.gitignore (and, when requested, the `.hyveon/tfvars-bucket` S3 backend marker). Exported so the entrypoint guard below can invoke it after CLI parsing. */
export async function runBootstrap(options: BootstrapOptions = { s3Tfvars: false, yes: false }): Promise<void> {
  FORCE = options.force ?? FORCE;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const guessedParent = findParentRepoRoot(cwd()) ?? findParentRepoRoot(scriptDir) ?? cwd();

  output.write('\n');
  output.write('  Hyveon — submodule deployment scaffolder\n');
  output.write('  ────────────────────────────────────────────────────\n');
  output.write('\n');
  output.write(`  Parent repo:  ${guessedParent}\n`);
  output.write(`  Script:       ${relative(guessedParent, fileURLToPath(import.meta.url)) || fileURLToPath(import.meta.url)}\n`);
  output.write('\n');
  output.write('  This will write Makefile, terraform.tfvars, and .gitignore in\n');
  output.write('  the parent repo. Existing files are skipped unless you pass --force.\n');
  output.write('\n');

  const rl = createInterface({ input, output });
  try {
    const parentDir = await ask(rl, 'Parent repo path', guessedParent);

    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
      output.write(`\n  ✗ ${parentDir} is not a directory.\n`);
      exit(1);
    }

    const submoduleDir = await ask(
      rl,
      'Submodule path (relative to parent repo)',
      detectSubmodulePath(parentDir, scriptDir),
    );
    const submoduleName = submoduleDir.split('/').pop() || 'Hyveon';

    let projectName = '';
    while (!isValidProjectName(projectName)) {
      projectName = await askRequired(rl, 'Project name (S3 bucket prefix; lowercase, dashes ok)', 'hyveon');
      if (!isValidProjectName(projectName)) output.write('  ↳ must be 3–32 chars, lowercase letters/numbers/dashes.\n');
    }

    let awsRegion = '';
    while (!isValidRegion(awsRegion)) {
      awsRegion = await askRequired(rl, 'AWS region', 'us-east-1');
      if (!isValidRegion(awsRegion)) output.write('  ↳ must look like "us-east-1".\n');
    }

    let hostedZone = '';
    while (!isValidDomain(hostedZone)) {
      hostedZone = await askRequired(rl, 'Route 53 hosted zone (e.g. example.com)');
      if (!isValidDomain(hostedZone)) output.write('  ↳ must be a valid domain.\n');
    }

    const configureDiscord = await askBool(rl, 'Seed Discord credentials in tfvars now?', false);

    // A --s3-tfvars flag pre-answers this and skips the prompt; --yes without
    // --s3-tfvars also skips the prompt but defaults to "no" (an explicit
    // opt-in is required to write the marker).
    const wantsS3Tfvars = options.s3Tfvars
      ? true
      : options.yes
        ? false
        : await askBool(rl, 'Bootstrap an S3-backed tfvars store now? (records the target bucket for `make setup` to create)', false);

    let discordApplicationId: string | undefined;
    let discordBotToken: string | undefined;
    let discordPublicKey: string | undefined;
    if (configureDiscord) {
      discordApplicationId = await askRequired(rl, '  Discord Application ID');
      discordBotToken = await askRequired(rl, '  Discord Bot Token');
      discordPublicKey = await askRequired(rl, '  Discord Public Key');
    }

    const answers: Answers = {
      parentDir,
      submoduleDir,
      submoduleName,
      projectName,
      awsRegion,
      hostedZone,
      configureDiscord,
      discordApplicationId,
      discordBotToken,
      discordPublicKey,
      s3Tfvars: wantsS3Tfvars,
    };

    output.write('\n  Writing files…\n');
    status(join(parentDir, 'Makefile'), writeIfSafe(join(parentDir, 'Makefile'), renderMakefile(answers)), parentDir);
    status(join(parentDir, 'terraform.tfvars'), writeIfSafe(join(parentDir, 'terraform.tfvars'), renderTfvars(answers)), parentDir);
    status(join(parentDir, '.gitignore'), writeIfSafe(join(parentDir, '.gitignore'), renderGitignore(answers)), parentDir);
    // The marker records the S3 bucket the generated Makefile's `setup`
    // recipe's S3 tfvars-bootstrap step will create (see
    // terraform/bootstrap/main.tf's coalesce default) — it's written
    // up-front, before `setup` has ever run, so PARENT_TFVARS_MARKER in the
    // generated Makefile can force HYVEON_TFVARS_BACKEND=s3 for `make setup`.
    if (wantsS3Tfvars) {
      status(
        join(parentDir, '.hyveon', 'tfvars-bucket'),
        writeIfSafe(join(parentDir, '.hyveon', 'tfvars-bucket'), `${projectName}-tfvars\n`),
        parentDir,
      );
    }

    output.write('\n  ✓ Done.\n\n');
    output.write('  Next steps:\n');
    output.write(`    1. Review terraform.tfvars and add at least one entry under game_servers.\n`);
    output.write(`    2. Run \`make setup\` to bootstrap the submodule and Terraform.\n`);
    output.write(`    3. Run \`make plan\` then \`make apply\`.\n`);
    output.write(`    4. \`make dev\` to launch the desktop app in dev mode.\n\n`);

    if (wantsS3Tfvars) {
      output.write(`  S3-backed tfvars store requested — .hyveon/tfvars-bucket recorded (${projectName}-tfvars).\n`);
      output.write(`  \`make setup\` will bootstrap that S3 bucket automatically before running terraform init,\n`);
      output.write(`  and \`make tfvars-push\` to seed the bucket if setup reports it empty.\n\n`);
    }

    if (existsSync(join(parentDir, '.gitmodules'))) {
      const gm = readFileSync(join(parentDir, '.gitmodules'), 'utf8');
      if (!gm.includes(submoduleDir)) {
        output.write(`  Note: ${submoduleDir} is not in .gitmodules. Add it with:\n`);
        output.write(`    git submodule add https://github.com/CoderCoco/Hyveon.git ${submoduleDir}\n\n`);
      }
    } else {
      output.write(`  Note: no .gitmodules found. Add the submodule with:\n`);
      output.write(`    git submodule add https://github.com/CoderCoco/Hyveon.git ${submoduleDir}\n\n`);
    }
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrate
// ─────────────────────────────────────────────────────────────────────────────

/** Flags from {@link parseCliArgs} that {@link runMigrate} cares about. */
export interface MigrateOptions {
  /** Skips the interactive confirmation prompt, proceeding immediately. */
  yes: boolean;
}

/**
 * The subset of {@link Answers} `runMigrate` can recover by inspecting an
 * already-scaffolded parent repo (as opposed to `runBootstrap`, which
 * collects the full set interactively). `renderMakefile` only ever reads
 * these two fields.
 */
type ExistingParentInfo = Pick<Answers, 'parentDir' | 'submoduleDir' | 'projectName'>;

/**
 * The subset of {@link ExistingParentInfo} recoverable from the Makefile
 * alone, without requiring `terraform.tfvars` to already exist locally.
 * `migrate --to-local` uses this looser lookup because its whole point is
 * that the parent repo may currently be sourcing `terraform.tfvars` from S3
 * with no local copy on disk yet — see {@link runMigrateToLocal}, which
 * pulls one down first when needed.
 */
type ParentLocation = Pick<Answers, 'parentDir' | 'submoduleDir'>;

/**
 * Locates an already-scaffolded parent repo (a directory containing a
 * `Makefile`, as written by `runBootstrap`) starting from `cwd()` — walking
 * up to the nearest `.gitmodules` first, same as `runBootstrap`'s guess, and
 * falling back to `cwd()` itself. Pulls `submoduleDir` out of the existing
 * Makefile's `SUBMODULE` line. Throws a plain `Error` (message intended for
 * stderr) if the Makefile is missing.
 */
function locateExistingParent(scriptDir: string): ParentLocation {
  const parentDir = findParentRepoRoot(cwd()) ?? cwd();
  const makefilePath = join(parentDir, 'Makefile');

  if (!existsSync(makefilePath)) {
    throw new Error(
      `${parentDir} doesn't look like a scaffolded parent repo (missing Makefile) — run \`init-parent.ts\` (bootstrap) first.`,
    );
  }

  const makefile = readFileSync(makefilePath, 'utf8');
  const submoduleMatch = makefile.match(/^SUBMODULE\s*:=\s*\$\(REPO_ROOT\)\/(.+)$/m);
  const submoduleDir = submoduleMatch ? submoduleMatch[1] : detectSubmodulePath(parentDir, scriptDir);

  return { parentDir, submoduleDir };
}

/**
 * Locates an already-scaffolded parent repo the same way
 * {@link locateExistingParent} does, additionally requiring
 * `terraform.tfvars` to exist locally and pulling `projectName` out of its
 * `project_name` key. Used by `migrate --to-s3`, which needs a local
 * `terraform.tfvars` as the source of truth to push up to the new bucket.
 * `migrate --to-local` deliberately does *not* use this — see
 * {@link ParentLocation}.
 */
function readExistingParent(scriptDir: string): ExistingParentInfo {
  const { parentDir, submoduleDir } = locateExistingParent(scriptDir);
  const tfvarsPath = join(parentDir, 'terraform.tfvars');

  if (!existsSync(tfvarsPath)) {
    throw new Error(
      `${parentDir} doesn't look like a scaffolded parent repo (missing terraform.tfvars) — run \`init-parent.ts\` (bootstrap) first.`,
    );
  }

  const tfvars = readFileSync(tfvarsPath, 'utf8');
  const projectMatch = tfvars.match(/^project_name\s*=\s*"([^"]+)"/m);
  if (!projectMatch) {
    throw new Error(`Couldn't find "project_name" in ${tfvarsPath} — is it a valid terraform.tfvars?`);
  }

  return { parentDir, submoduleDir, projectName: projectMatch[1] };
}

/**
 * Migrates an already-scaffolded parent repo's tfvars backend.
 *
 * `--to-s3`: (re)writes the `.hyveon/tfvars-bucket` marker unconditionally (same
 * `${projectName}-tfvars` naming `runBootstrap`'s `--s3-tfvars` path uses —
 * unlike `runBootstrap`, this always overwrites any pre-existing marker
 * rather than skipping, since `migrate` doesn't accept `--force` and the
 * whole point of the command is to make the marker match the freshly
 * computed bucket name), rewrites the Makefile with
 * the s3-aware targets (identical output to a fresh `runBootstrap` render —
 * the Makefile is always s3-aware, only the marker's presence flips
 * `TFVARS_BACKEND`), then runs `make setup` with `HYVEON_TFVARS_BACKEND=s3` so
 * `terraform/bootstrap/` provisions the bucket. `terraform.tfvars` itself is
 * never read for anything other than `project_name`, nor written — the
 * one-time pull to fetch it back down from S3 is left to the operator via the
 * printed `make tfvars-pull` note (and to `make setup`'s own post-bootstrap
 * pull, which no-ops the first time since the bucket starts empty).
 *
 * `--to-local`: delegates to {@link runMigrateToLocal} — see its doc comment
 * for the drift check and deletion behaviour.
 */
export async function runMigrate(direction: MigrateDirection, options: MigrateOptions = { yes: false }): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));

  if (direction === 'to-local') {
    // Deliberately uses the looser locateExistingParent (Makefile only, no
    // terraform.tfvars requirement) — runMigrateToLocal pulls tfvars down
    // from S3 itself when it's missing locally, so requiring it up front
    // here would make that codepath unreachable.
    const location = locateExistingParent(scriptDir);
    await runMigrateToLocal(location, options);
    return;
  }

  const info = readExistingParent(scriptDir);
  const markerPath = join(info.parentDir, '.hyveon', 'tfvars-bucket');
  const bucketName = `${info.projectName}-tfvars`;

  output.write('\n');
  output.write('  Hyveon — migrate tfvars backend to S3\n');
  output.write('  ────────────────────────────────────────────────────\n');
  output.write('\n');
  output.write(`  Parent repo:  ${info.parentDir}\n`);
  output.write(`  Submodule:    ${info.submoduleDir}\n`);
  output.write(`  Bucket:       ${bucketName}\n`);
  output.write('\n');
  output.write('  This will:\n');
  output.write(`    1. Write .hyveon/tfvars-bucket recording the target bucket name.\n`);
  output.write(`    2. Rewrite Makefile with the s3-aware targets.\n`);
  output.write(`    3. Run \`make setup\` (HYVEON_TFVARS_BACKEND=s3) to bootstrap the bucket.\n`);
  output.write('\n');
  output.write('  terraform.tfvars itself is left untouched.\n');
  output.write('\n');

  if (!options.yes) {
    const rl = createInterface({ input, output });
    let proceed: boolean;
    try {
      proceed = await askBool(rl, 'Proceed?', false);
    } finally {
      rl.close();
    }
    if (!proceed) {
      output.write('\n  Aborted — no files were changed.\n\n');
      return;
    }
  }

  output.write('  Writing files…\n');
  // Migrate always (re)writes the marker and the Makefile it's migrating —
  // that's the whole point of the command — regardless of the global
  // --force flag, which only governs runBootstrap's skip-if-exists
  // behaviour and isn't even accepted by the migrate subcommand (see
  // parseCliArgs). Using writeIfSafe here would silently keep a
  // pre-existing marker (possibly recording a different bucket) and print
  // an unactionable "use --force" hint, so write unconditionally instead.
  const markerExisted = existsSync(markerPath);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${bucketName}\n`);
  status(markerPath, markerExisted ? 'overwrote' : 'wrote', info.parentDir);

  const makefilePath = join(info.parentDir, 'Makefile');
  mkdirSync(dirname(makefilePath), { recursive: true });
  writeFileSync(makefilePath, renderMakefile({ submoduleDir: info.submoduleDir, projectName: info.projectName }));
  status(makefilePath, 'overwrote', info.parentDir);

  output.write('\n  Running `make setup` (HYVEON_TFVARS_BACKEND=s3)…\n\n');
  const result = spawnSync('make', ['setup'], {
    cwd: info.parentDir,
    stdio: 'inherit',
    env: { ...process.env, HYVEON_TFVARS_BACKEND: 's3' },
  });

  if (result.error) {
    process.stderr.write(`\n  ✗ failed to run \`make setup\`: ${result.error.message}\n`);
    process.stderr.write(
      `  .hyveon/tfvars-bucket and the rewritten Makefile are already in place — no need to redo the\n` +
        `  confirmation, marker, or Makefile steps. Fix the underlying issue and just re-run \`make setup\`.\n`,
    );
    exit(1);
    return;
  }
  if (result.status !== 0) {
    process.stderr.write(`\n  ✗ \`make setup\` failed (exit ${result.status ?? 'unknown'}).\n`);
    process.stderr.write(
      `  .hyveon/tfvars-bucket and the rewritten Makefile are already in place — no need to redo the\n` +
        `  confirmation, marker, or Makefile steps. Fix the underlying issue and just re-run \`make setup\`.\n`,
    );
    exit(1);
    return;
  }

  output.write('\n  ✓ Migrated to the S3 tfvars backend.\n\n');
  output.write(`  Your tfvars are now in S3 (s3://${bucketName}) — this is a one-time note:\n`);
  output.write(`  run \`make tfvars-pull\` any time you need to refresh your local terraform.tfvars\n`);
  output.write(`  from the bucket (e.g. after editing it from another machine).\n\n`);
}

/**
 * Implements `migrate --to-local`: drops an already-scaffolded parent repo's
 * S3 tfvars backend markers, reverting `make plan`/`make apply` to reading
 * `terraform.tfvars` straight off disk (the same behaviour as a parent repo
 * that never opted into S3 at all).
 *
 * Steps:
 *   1. Resolve the target bucket — `HYVEON_TFVARS_BUCKET` wins if set (matching
 *      the Makefile's own `TFVARS_BUCKET` precedence and `resolveBucket()`'s
 *      env-first behaviour in `tfvars-sync.ts`), otherwise the parent-root
 *      `.hyveon/tfvars-bucket` marker, otherwise the submodule-local one. If
 *      none resolve, exit 1 — there's nothing to migrate.
 *   2. If `terraform.tfvars` doesn't exist locally yet (the parent repo may
 *      currently be sourcing it purely from S3), pull it down via
 *      `pullTfvars()` first so there's something to compare/leave behind.
 *   3. Check whether the remote S3 object exists at all via `lockStatus()`
 *      first. If it was never seeded (a real state after `bootstrap
 *      --s3-tfvars` + `make setup` when the initial push/pull was skipped),
 *      there is nothing remote to strand — skip straight to deleting the
 *      markers with a note instead of comparing against empty content.
 *      Otherwise compare the (now-guaranteed-present) local
 *      `terraform.tfvars` against the remote object byte-for-byte via
 *      `diffTfvars()` (the same comparison the `tfvars diff` subcommand
 *      uses) and abort — leaving every file untouched — if they've drifted,
 *      since deleting the markers would otherwise silently strand whichever
 *      side lost the race.
 *   4. On success, delete, if present: the `.hyveon/tfvars-bucket` marker at the
 *      parent repo root, the sibling marker the generated Makefile's `setup`
 *      recipe writes inside the submodule directory, and the
 *      `terraform.tfvars.lock` sidecar
 *      `tfvars-sync.ts` maintains. `terraform.tfvars` itself is never
 *      written beyond the step-2 pull (if that ran) — it's already the
 *      source of truth for local mode once the markers are gone.
 *   5. Note that the S3 bucket itself is left standing (this command never
 *      deletes it) and point at `terraform -chdir=<submodule>/terraform/bootstrap
 *      destroy` for operators who want to tear it down.
 */
async function runMigrateToLocal(info: ParentLocation, options: MigrateOptions): Promise<void> {
  const parentMarkerPath = join(info.parentDir, '.hyveon', 'tfvars-bucket');
  const submoduleMarkerPath = join(info.parentDir, info.submoduleDir, '.hyveon', 'tfvars-bucket');
  const tfvarsPath = join(info.parentDir, 'terraform.tfvars');
  const lockPath = `${tfvarsPath}.lock`;
  const bootstrapDir = join(info.submoduleDir, 'terraform', 'bootstrap');

  const parentMarkerExists = existsSync(parentMarkerPath);
  const submoduleMarkerExists = existsSync(submoduleMarkerPath);

  output.write('\n');
  output.write('  Hyveon — migrate tfvars backend to local\n');
  output.write('  ────────────────────────────────────────────────────\n');
  output.write('\n');
  output.write(`  Parent repo:  ${info.parentDir}\n`);
  output.write(`  Submodule:    ${info.submoduleDir}\n`);
  output.write('\n');

  // HYVEON_TFVARS_BUCKET wins over both marker files, then the parent-root
  // marker wins over the submodule marker — same precedence resolveBucket()
  // uses in tfvars-sync.ts and TFVARS_BUCKET uses in the generated Makefile
  // (see renderMakefile's comment on PARENT_TFVARS_MARKER).
  const bucketName =
    (process.env.HYVEON_TFVARS_BUCKET || undefined) ??
    (parentMarkerExists ? readFileSync(parentMarkerPath, 'utf8').trim() : undefined) ??
    (submoduleMarkerExists ? readFileSync(submoduleMarkerPath, 'utf8').trim() : undefined);

  if (!bucketName) {
    process.stderr.write(
      '  No HYVEON_TFVARS_BUCKET env var and no .hyveon/tfvars-bucket marker found — already in local mode, nothing to migrate.\n\n',
    );
    exit(1);
    return;
  }

  output.write(`  Bucket:       ${bucketName}\n`);
  output.write('\n');
  output.write('  This will:\n');
  output.write(`    1. Pull terraform.tfvars from s3://${bucketName}/terraform.tfvars first if it's missing locally.\n`);
  output.write(`    2. Compare local terraform.tfvars against s3://${bucketName}/terraform.tfvars — abort on drift.\n`);
  output.write(`    3. Delete the .hyveon/tfvars-bucket marker(s).\n`);
  output.write(`    4. Delete the terraform.tfvars.lock sidecar, if present.\n`);
  output.write('\n');
  output.write('  terraform.tfvars itself is left in place (aside from the pull-if-missing step above).\n');
  output.write('\n');

  if (!options.yes) {
    const rl = createInterface({ input, output });
    let proceed: boolean;
    try {
      proceed = await askBool(rl, 'Proceed?', false);
    } finally {
      rl.close();
    }
    if (!proceed) {
      output.write('\n  Aborted — no files were changed.\n\n');
      return;
    }
  }

  // Tracks whether step 1 actually wrote terraform.tfvars, so the abort
  // messages below (steps 2 and 3) can accurately describe what's on disk —
  // once the pull has run, "Nothing was changed." would be false:
  // terraform.tfvars and its .lock sidecar were written by pullTfvars(),
  // while the markers are still untouched.
  let pulled = false;

  if (!existsSync(tfvarsPath)) {
    output.write(`  terraform.tfvars not found locally — pulling from s3://${bucketName}/terraform.tfvars…\n`);
    try {
      await pullTfvars({ bucket: bucketName, path: tfvarsPath });
    } catch (err) {
      process.stderr.write(
        `\n  ✗ failed to pull s3://${bucketName}/terraform.tfvars: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stderr.write('  Nothing was changed.\n\n');
      exit(1);
      return;
    }
    pulled = true;
    status(tfvarsPath, 'wrote', info.parentDir);
  }

  const recoveryMessage = pulled
    ? '  terraform.tfvars and its .lock sidecar were written by the pull from S3; markers are unchanged.\n\n'
    : '  Nothing was changed.\n\n';

  output.write('  Checking for drift against the remote tfvars object…\n');
  let remoteStatus: StatusReport;
  try {
    remoteStatus = await lockStatus({ bucket: bucketName, path: tfvarsPath });
  } catch (err) {
    process.stderr.write(
      `\n  ✗ failed to check s3://${bucketName}/terraform.tfvars: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(recoveryMessage);
    exit(1);
    return;
  }

  if (!remoteStatus.remote.exists) {
    // The bucket was created but never seeded (e.g. `bootstrap --s3-tfvars`
    // followed by `make setup` with the initial pull skipped). There is
    // nothing remote to strand or reconcile — `make tfvars-pull` would just
    // fail with NoSuchKey, and `make tfvars-push` would seed a bucket the
    // operator is about to abandon. Proceed straight to deleting the
    // markers.
    output.write(
      `  ✓ s3://${bucketName}/terraform.tfvars was never seeded — nothing remote to compare, safe to migrate.\n\n`,
    );
  } else {
    let diff: DiffResult;
    try {
      diff = await diffTfvars({ bucket: bucketName, path: tfvarsPath });
    } catch (err) {
      process.stderr.write(
        `\n  ✗ failed to compare against s3://${bucketName}/terraform.tfvars: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stderr.write(recoveryMessage);
      exit(1);
      return;
    }

    if (!diff.matches) {
      process.stderr.write(`\n  ✗ local terraform.tfvars has drifted from s3://${bucketName}/terraform.tfvars — aborting.\n`);
      process.stderr.write('  Run `make tfvars-pull` or `make tfvars-push` to reconcile them first, then re-run this migration.\n');
      process.stderr.write(recoveryMessage);
      exit(1);
      return;
    }

    output.write('  ✓ local and remote match — safe to migrate.\n\n');
  }
  output.write('  Deleting files…\n');
  if (parentMarkerExists) {
    unlinkSync(parentMarkerPath);
    status(parentMarkerPath, 'deleted', info.parentDir);
  }
  if (submoduleMarkerExists) {
    unlinkSync(submoduleMarkerPath);
    status(submoduleMarkerPath, 'deleted', info.parentDir);
  }
  // Re-check at deletion time rather than trusting an up-front snapshot —
  // pullTfvars() above writes this sidecar as a side effect when
  // terraform.tfvars was missing locally, so a value captured before that
  // pull would miss the freshly created lock and strand it behind.
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
    status(lockPath, 'deleted', info.parentDir);
  }

  output.write('\n  ✓ Migrated to the local tfvars backend.\n\n');
  output.write('  terraform.tfvars is unchanged — `make plan`/`make apply` will use it directly, with no S3 involved.\n\n');
  output.write(`  Note: the S3 bucket (s3://${bucketName}) itself is retained — this command never deletes it.\n`);
  output.write(`  If you no longer need it, destroy it with:\n`);
  output.write(`    terraform -chdir=${bootstrapDir} destroy\n\n`);
}

// Only run when this file is the entry point — keeps the renderers importable
// from tests without auto-launching the prompt loop. Compare normalized
// absolute paths so relative invocations (e.g. `tsx init-parent.ts`) still
// match.
const isEntrypoint =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1]);

if (isEntrypoint) {
  // Wrapped in an IIFE (rather than left as bare top-level statements) so the
  // catch block below can `return;` immediately after `exit(1)` — top-level
  // `return` isn't legal in an ES module, and without it a mocked `exit()` in
  // tests would fall through to `CLI.command` while `CLI` is still
  // unassigned.
  (function dispatchCli(): void {
    let CLI: CliArgs;
    try {
      CLI = parseCliArgs(argv.slice(2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n  ✗ ${message}\n\n${USAGE}`);
      exit(1);
      return;
    }

    if (CLI.command === 'migrate') {
      // parseCliArgs guarantees exactly one of --to-s3 | --to-local by the time
      // command === 'migrate' is returned, so direction is always defined here.
      runMigrate(CLI.direction as MigrateDirection, { yes: CLI.yes }).catch((err) => {
        process.stderr.write(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
        exit(1);
      });
    } else {
      runBootstrap({ s3Tfvars: CLI.s3Tfvars, yes: CLI.yes, force: CLI.force }).catch((err) => {
        process.stderr.write(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
        exit(1);
      });
    }
  })();
}
