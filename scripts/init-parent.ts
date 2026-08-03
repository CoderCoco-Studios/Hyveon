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
 *   - Makefile           self-contained wrapper — every step it still owns
 *                        (submodule init, npm install, Lambda builds, dev
 *                        server) is inlined directly in its recipes; it
 *                        never shells out to a script or Makefile inside the
 *                        submodule. It does NOT orchestrate any
 *                        infrastructure step — no backend bootstrap, no
 *                        `terraform`/Pulumi init/plan/apply. The app's own
 *                        first-run wizard (`BootstrapService`) and its
 *                        Plan/Apply page do that directly via the AWS SDK
 *                        and the Pulumi Automation API, with zero dependency
 *                        on this Makefile or a host-installed CLI (see the
 *                        `migrate-iac-to-pulumi` OpenSpec change).
 *   - terraform.tfvars   skeleton populated from your answers
 *   - .gitignore         covers .make/, terraform.tfstate*, etc.
 *
 * This script NEVER reads or modifies anything inside the submodule.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, argv, cwd, exit } from 'node:process';

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
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  /** Overwrites existing Makefile/terraform.tfvars/.gitignore instead of skipping them. */
  force: boolean;
  /**
   * Accepted and threaded through to {@link runBootstrap} for
   * forward-compatibility, but currently inert: its only prior consumer was
   * the "bootstrap an S3-backed tfvars store?" prompt, removed along with
   * the rest of the tfvars-sync backend. Every remaining
   * `runBootstrap` prompt (parent repo path, submodule path, project name,
   * AWS region, hosted zone, Discord credentials) always runs interactively
   * regardless of this flag.
   */
  yes: boolean;
}

/** Thrown by {@link parseCliArgs} for an unrecognized subcommand or an unrecognized flag. Callers should print `err.message` plus {@link USAGE} to stderr and exit 1. */
export class CliUsageError extends Error {}

export const USAGE = `Usage:
  init-parent.ts [--force] [--yes]            Interactive bootstrap
`;

/**
 * Parses `init-parent.ts`'s CLI args (i.e. `argv.slice(2)`). There is only
 * one flow (interactive bootstrap) — an optional leading `bootstrap` token is
 * still accepted (and ignored) for backwards compatibility with older docs/
 * scripts that spelled it out explicitly, but there is no longer a `migrate`
 * subcommand: the S3-backed tfvars-sync backend it used to switch between
 * local and S3 modes was retired (see {@link renderMakefile}'s doc comment).
 * Throws {@link CliUsageError} for an unrecognized subcommand or an
 * unrecognized flag. Pure and side-effect free, so it's directly
 * unit-testable.
 */
export function parseCliArgs(args: string[]): CliArgs {
  const rest = [...args];

  if (rest[0] === 'bootstrap') {
    rest.shift();
  } else if (rest[0] !== undefined && rest[0].startsWith('--') === false) {
    throw new CliUsageError(`Unknown subcommand "${rest[0]}".`);
  }

  const knownFlags: readonly string[] = ['--force', '--yes'];

  for (const token of rest) {
    if (!knownFlags.includes(token)) {
      throw new CliUsageError(`Unknown flag "${token}".`);
    }
  }

  return { force: rest.includes('--force'), yes: rest.includes('--yes') };
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
 * Fully self-contained wrapper — every step below is inlined directly in the
 * recipes; it never shells out to a script or another Makefile inside the
 * submodule:
 *   setup  → init submodule, `npm install`, build the Lambda bundles. That's
 *            it — no S3/DynamoDB backend bootstrap, no `terraform`/Pulumi
 *            init/plan/apply. The app's own first-run wizard
 *            (`BootstrapService`, Phase 5 of the `migrate-iac-to-pulumi`
 *            OpenSpec change) provisions the AWS backend, and its Plan/Apply
 *            page (Phase 10) deploys the stack via the Pulumi Automation
 *            API — both directly from the packaged Electron app, with zero
 *            dependency on this Makefile or a host-installed `terraform`/
 *            `pulumi`/`aws` CLI.
 *   update → bump the submodule to the tip of `main`. No re-init step
 *            follows it: there is no longer a local Terraform working
 *            directory for a bump to invalidate.
 *   dev    → `npm run app:dev` directly in the submodule. No local state to
 *            pull — the app reads deployed state via the Pulumi Automation
 *            API at runtime, not a file on disk.
 *
 * `plan`/`apply` (which used to shell out to `terraform -chdir=$(TF_DIR)
 * plan/apply` directly) are gone entirely — the app's own Plan/Apply page
 * does this now. The `tfvars-pull`/`tfvars-push`/`tfvars-diff`/
 * `copy-tfvars` targets (and the internal `pull-tfvars-if-needed`/
 * `check-tfvars-if-needed` gates that fed `plan`/`apply`) are gone too: they
 * existed to sync a maintainer's local `terraform.tfvars` file to/from an S3
 * bucket named `${project}-tfvars` — the SAME bucket (and default name) the
 * app's own first-run wizard provisions via `BootstrapService
 * .ensureConfigurationBucket()`, still very much alive; `HYVEON_TFVARS_BUCKET`
 * is even read by both this CLI's sync logic and the app's own
 * `ConfigService.getConfigurationBucket()`. What's actually dead is the
 * OBJECT KEY, not the bucket: `scripts/tfvars-sync.ts` reads/writes the key
 * `terraform.tfvars` (HCL-ish text), while the app exclusively reads/writes
 * a different key, `deployment-config.json` (JSON), via `RemoteFileStore`'s
 * conditional-put path (see `TfvarsService`'s doc comment). Nothing anywhere
 * reads the `terraform.tfvars` key anymore now that the Terraform tree is
 * gone — so these targets were keeping a versioned copy of a
 * file with zero consumers. Per `openspec/specs/desktop-only-operator-
 * surface`'s "No operator-editable configuration files" requirement ("There
 * MUST NOT be a local-file configuration mode"), that dead-key sync isn't
 * worth reviving even as a maintainer-only convenience. `scripts/
 * tfvars-sync.ts` itself is untouched (still usable directly, without a
 * Makefile wrapper, by anyone who wants to read/write the `terraform.tfvars`
 * key by hand) — only the Makefile targets and the `migrate --to-s3`/
 * `--to-local` CLI subcommand that switched between local/S3 tfvars modes
 * were removed, since there is no longer an S3 tfvars mode to switch to.
 *
 * Only reads `submoduleDir` and `projectName` off `a`, so it accepts a
 * `Pick<Answers, ...>` rather than a full `Answers`.
 */
export function renderMakefile(a: Pick<Answers, 'submoduleDir' | 'projectName'>): string {
  return `SHELL      := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REPO_ROOT   := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SUBMODULE   := $(REPO_ROOT)/${a.submoduleDir}

.PHONY: help setup update dev

# ── Help ─────────────────────────────────────────────────────────────────────
help:
\t@echo "${a.projectName} — submodule deployment wrapper"
\t@echo ""
\t@echo "  make setup   One-time bootstrap: init submodule, install deps, build lambdas"
\t@echo "               (AWS backend bootstrap and stack deploy are handled by the app itself"
\t@echo "               — see the first-run wizard and the Plan/Apply page)"
\t@echo "  make update  Pull latest ${a.submoduleDir}/main"
\t@echo "  make dev     Launch the Hyveon desktop app in dev mode (electron-vite)"

# ── One-time setup ───────────────────────────────────────────────────────────
# Fully self-contained: no external setup.sh, no delegating to a Makefile
# inside the submodule, and no infra orchestration — the app's own first-run
# wizard bootstraps the AWS backend and its Plan/Apply page deploys the
# stack, both directly via the AWS SDK and the Pulumi Automation API.
setup:
\tgit submodule update --init --recursive
\tcd $(SUBMODULE) && npm install
\tcd $(SUBMODULE) && npm run app:build:lambdas

# ── Submodule update ──────────────────────────────────────────────────────────
# Bumps the submodule to the tip of main. Nothing else to re-run afterwards —
# there is no local Terraform/Pulumi working directory this could invalidate.
update:
\tgit submodule update --remote --merge $(SUBMODULE)
\t@echo ""
\t@echo "Submodule updated. Commit the new pointer when ready:"
\t@echo "  git add ${a.submoduleDir} && git commit -m 'chore: bump ${a.submoduleDir}'"

# ── Dev server ───────────────────────────────────────────────────────────────
# No local state to pull — the app reads deployed state via the Pulumi
# Automation API at runtime, so this just launches the app.
dev:
\trm -f $(SUBMODULE)/app/packages/*/tsconfig*.tsbuildinfo
\tcd $(SUBMODULE) && npm run app:dev
`;
}

/**
 * Skeleton tfvars mirroring the shape the now-deleted `terraform.tfvars.example`
 * used to document. We fill in the few things we just asked the user about and
 * leave the rest as commented examples.
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
# Commit this file to your private parent repo. It's a starting point for the
# values the app's first-run wizard and Settings page ask for — the wrapper
# Makefile no longer copies it anywhere; the app reads/writes its live
# deployment configuration itself, in its own versioned S3 configuration
# bucket, once you've walked through the wizard.

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

# Game server definitions — declare these via the app's Games page instead;
# see ${a.submoduleDir}/app/packages/shared/src/tfvars.ts (GameServerConfig)
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

# Make stamp dir (tfstate.json, written by \`make dev\`)
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

function status(path: string, action: 'wrote' | 'skipped' | 'overwrote', parentDir: string): void {
  const rel = relative(parentDir, path) || path;
  const tag = action === 'wrote' ? '  +' : action === 'overwrote' ? '  ~' : '  ·';
  const note = action === 'skipped' ? '  (exists — use --force to overwrite)' : '';
  output.write(`${tag} ${rel}${note}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function isValidProjectName(s: string): boolean {
  // Seeds terraform.tfvars's project_name, which the app's own first-run
  // wizard defaults its S3 bucket names from (see
  // defaultBootstrapResourceNames() in the web wizard) — keep it
  // conservative. The generated Makefile itself no longer names any buckets.
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

/** Flags from {@link parseCliArgs} passed through to {@link runBootstrap}. */
export interface BootstrapOptions {
  /**
   * Currently inert (see {@link CliArgs.yes}) — kept for
   * forward-compatibility and to match {@link CliArgs}'s shape. Every
   * `runBootstrap` prompt runs interactively regardless of this value.
   */
  yes: boolean;
  /** Overwrites existing Makefile/terraform.tfvars/.gitignore instead of skipping them. Mirrors the module-level `FORCE` flag so callers of the exported API (not just the CLI entrypoint) can drive `--force` behaviour. */
  force?: boolean;
}

/** The interactive bootstrap flow: prompts for parent-repo details and writes Makefile/terraform.tfvars/.gitignore. Exported so the entrypoint guard below can invoke it after CLI parsing. */
export async function runBootstrap(options: BootstrapOptions = { yes: false }): Promise<void> {
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
    };

    output.write('\n  Writing files…\n');
    status(join(parentDir, 'Makefile'), writeIfSafe(join(parentDir, 'Makefile'), renderMakefile(answers)), parentDir);
    status(join(parentDir, 'terraform.tfvars'), writeIfSafe(join(parentDir, 'terraform.tfvars'), renderTfvars(answers)), parentDir);
    status(join(parentDir, '.gitignore'), writeIfSafe(join(parentDir, '.gitignore'), renderGitignore(answers)), parentDir);

    output.write('\n  ✓ Done.\n\n');
    output.write('  Next steps:\n');
    output.write(`    1. Review terraform.tfvars and add at least one entry under game_servers.\n`);
    output.write(`    2. Run \`make setup\` to install the submodule and build the Lambda bundles.\n`);
    output.write(`    3. Launch the app (\`make dev\`, or the packaged build) and complete the first-run\n`);
    output.write(`       wizard — it bootstraps the AWS backend and deploys the stack for you.\n\n`);

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
  // tests would fall through to `runBootstrap` while `CLI` is still
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

    runBootstrap({ yes: CLI.yes, force: CLI.force }).catch((err) => {
      process.stderr.write(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      exit(1);
    });
  })();
}
