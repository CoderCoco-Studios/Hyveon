/**
 * Render-function smoke test for init-parent.ts. Run with:
 *   npx tsx init-parent.test.ts
 *
 * No assertion library — fails loudly via `process.exit(1)` if any check
 * doesn't hold.
 */

import { renderMakefile, renderTfvars, renderGitignore } from './init-parent.ts';

const a = {
  parentDir: '/tmp/parent',
  submoduleDir: 'Hyveon',
  submoduleName: 'Hyveon',
  projectName: 'mygames',
  awsRegion: 'us-west-2',
  hostedZone: 'example.com',
  configureDiscord: false,
};

const errors: string[] = [];
const expect = (label: string, ok: boolean): void => {
  if (!ok) errors.push(label);
};

const mk = renderMakefile(a);
expect('Makefile sets SUBMODULE', mk.includes('SUBMODULE   := $(REPO_ROOT)/Hyveon'));
expect('Makefile has dev target with state pull', mk.includes('terraform -chdir=$(TF_DIR) state pull'));
expect('Makefile dev target runs npm run app:dev directly in the submodule', mk.includes('cd $(SUBMODULE) && TF_STATE_PATH=$(STAMP_DIR)/tfstate.json npm run app:dev'));
expect('Makefile copy-tfvars uses cp', mk.includes('cp $(TFVARS) $(TF_DIR)/terraform.tfvars'));
expect('Makefile uses bash shell', mk.startsWith('SHELL      := /usr/bin/env bash'));

// ── No more .env / API_TOKEN / setup.sh delegation ──────────────────────────
expect('Makefile does NOT inline API_TOKEN', !/API_TOKEN\s*:?=\s*[a-f0-9]{40,}/.test(mk));
expect('Makefile does NOT reference API_TOKEN at all', !mk.includes('API_TOKEN'));
expect('Makefile does NOT include .env', !mk.includes('include $(REPO_ROOT)/.env'));
expect('Makefile does NOT reference a .env file', !/\.env\b/.test(mk));
// Comments may still mention "the old setup.sh" for historical context (see
// the setup recipe's doc comments), but nothing may actually invoke it.
expect('Makefile does NOT shell out to setup.sh', !mk.includes('bash $(SUBMODULE)/setup.sh') && !mk.includes('./setup.sh'));
expect('Makefile does NOT delegate to a Makefile inside the submodule', !mk.includes('$(MAKE) -C $(SUBMODULE)'));
expect('Makefile does NOT use a SETUP_STAMP/sha256 drift-detection mechanism', !mk.includes('SETUP_STAMP') && !mk.includes('sha256sum'));

// ── setup recipe is self-contained ──────────────────────────────────────────
const setupRecipeMatch = /^setup:.*\n(?:(?:\t|#).*\n?)*/m.exec(mk);
const setupRecipe = setupRecipeMatch ? setupRecipeMatch[0] : '';
expect('Makefile has a setup: recipe to inspect', setupRecipe !== '');
expect('Makefile setup runs npm install in the submodule', setupRecipe.includes('cd $(SUBMODULE) && npm install'));
expect('Makefile setup builds the Lambda bundles', setupRecipe.includes('cd $(SUBMODULE) && npm run app:build:lambdas'));
expect('Makefile setup derives project_name/aws_region via grep/sed from terraform.tfvars', setupRecipe.includes("grep -E '^[[:space:]]*project_name[[:space:]]*='") && setupRecipe.includes("grep -E '^[[:space:]]*aws_region[[:space:]]*='"));
expect('Makefile setup falls back to the known project name when project_name is absent', setupRecipe.includes('PROJECT="mygames"'));
expect('Makefile setup creates the Terraform state S3 bucket idempotently', setupRecipe.includes('aws s3api head-bucket') && setupRecipe.includes('aws s3api create-bucket'));
expect('Makefile setup enables versioning/public-access-block/encryption on the state bucket', setupRecipe.includes('put-bucket-versioning') && setupRecipe.includes('put-public-access-block') && setupRecipe.includes('put-bucket-encryption'));
expect('Makefile setup creates the DynamoDB lock table idempotently', setupRecipe.includes('aws dynamodb describe-table') && setupRecipe.includes('aws dynamodb create-table'));
expect('Makefile setup bootstraps the tfvars S3 bucket via the separate terraform/bootstrap module', setupRecipe.includes('terraform -chdir=$(SUBMODULE)/terraform/bootstrap init') && setupRecipe.includes('terraform -chdir=$(SUBMODULE)/terraform/bootstrap apply -auto-approve'));
expect('Makefile setup reads the tfvars bucket name via terraform output -raw', setupRecipe.includes('terraform -chdir=$(SUBMODULE)/terraform/bootstrap output -raw tfvars_bucket_name'));
expect('Makefile setup writes the tfvars bucket name to TFVARS_MARKER_NEW (always the new .hyveon path)', setupRecipe.includes('echo "$$BUCKET" > $(TFVARS_MARKER_NEW)'));
expect('Makefile setup runs terraform init with the expected backend-config flags', setupRecipe.includes('terraform -chdir=$(TF_DIR) init') && setupRecipe.includes('-backend-config="bucket=$$TF_STATE_BUCKET"') && setupRecipe.includes('-backend-config="dynamodb_table=$$TF_LOCK_TABLE"'));
expect(
  'Makefile setup copies the parent tfvars into the submodule before deriving project/region, so the bucket names match PARENT_TFVARS_MARKER',
  setupRecipe.includes('cp $(TFVARS) $(TF_DIR)/terraform.tfvars') &&
    setupRecipe.indexOf('cp $(TFVARS) $(TF_DIR)/terraform.tfvars') < setupRecipe.indexOf("grep -E '^[[:space:]]*project_name"),
);

// ── S3 tfvars backend detection block ───────────────────────────────────────
// Both markers resolve to the new `.hyveon` path if present, else fall back
// to reading the pre-rename `.gsd` path (so an already-scaffolded parent repo
// that hasn't run `mv .gsd .hyveon` keeps resolving its S3 backend), else
// default to the new path for a from-scratch bootstrap.
expect(
  'Makefile defines TFVARS_MARKER with a legacy .gsd fallback',
  mk.includes(
    'TFVARS_MARKER := $(firstword $(wildcard $(SUBMODULE)/.hyveon/tfvars-bucket $(SUBMODULE)/.gsd/tfvars-bucket) $(SUBMODULE)/.hyveon/tfvars-bucket)',
  ),
);
expect('Makefile defines TFVARS_LOCK', mk.includes('TFVARS_LOCK   := $(TFVARS).lock'));
expect(
  'Makefile defines PARENT_TFVARS_MARKER at the parent repo root with a legacy .gsd fallback',
  mk.includes(
    'PARENT_TFVARS_MARKER := $(firstword $(wildcard $(REPO_ROOT)/.hyveon/tfvars-bucket $(REPO_ROOT)/.gsd/tfvars-bucket) $(REPO_ROOT)/.hyveon/tfvars-bucket)',
  ),
);
expect('Makefile defines TFVARS_MARKER_NEW as the canonical write target', mk.includes('TFVARS_MARKER_NEW := $(SUBMODULE)/.hyveon/tfvars-bucket'));
expect(
  'Makefile defines TFVARS_BACKEND gated on HYVEON_TFVARS_BACKEND override, then the parent-root marker, then the submodule marker',
  mk.includes(
    'TFVARS_BACKEND = $(if $(filter s3,$(HYVEON_TFVARS_BACKEND)),s3,$(if $(filter local,$(HYVEON_TFVARS_BACKEND)),local,$(if $(wildcard $(PARENT_TFVARS_MARKER)),s3,$(if $(wildcard $(TFVARS_MARKER)),s3,local))))',
  ),
);
expect('Makefile routes TFVARS_SYNC --bucket through TFVARS_MARKER', mk.includes('cat $(TFVARS_MARKER)'));

// ── Parent-root marker precedence (prefers parent, falls back to submodule) ─
expect(
  'Makefile TFVARS_BACKEND checks the parent-root marker before the submodule marker',
  mk.indexOf('$(wildcard $(PARENT_TFVARS_MARKER))') < mk.indexOf('$(wildcard $(TFVARS_MARKER))') &&
    mk.indexOf('$(wildcard $(PARENT_TFVARS_MARKER))') !== -1,
);
expect(
  'Makefile TFVARS_BACKEND falls back to the submodule marker when no parent-root marker exists',
  mk.includes('$(if $(wildcard $(TFVARS_MARKER)),s3,local)'),
);
expect(
  'Makefile TFVARS_BUCKET prefers the parent-root marker contents, falling back to the submodule marker',
  mk.includes(
    'TFVARS_BUCKET = $(if $(HYVEON_TFVARS_BUCKET),$(HYVEON_TFVARS_BUCKET),$(shell cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null))',
  ),
);
expect(
  'Makefile TFVARS_SYNC_ARGS resolves --bucket from the parent-root marker before the submodule marker',
  mk.includes('cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null'),
);
expect(
  'Makefile help text mentions the parent-root marker before the submodule marker fallback',
  /otherwise inferred from \$\(PARENT_TFVARS_MARKER\), falling back to \$\(TFVARS_MARKER\)/.test(mk),
);

// ── Gated tfvars-* targets ───────────────────────────────────────────────────
expect('Makefile phonies list tfvars-pull/push/diff (not tfvars-status)', mk.includes('tfvars-pull tfvars-push tfvars-diff'));
expect('Makefile has tfvars-pull target', /^tfvars-pull:$/m.test(mk));
expect('Makefile has tfvars-push target', /^tfvars-push:$/m.test(mk));
expect('Makefile has tfvars-diff target wired to tfvars-sync.ts diff', /^tfvars-diff:$/m.test(mk) && mk.includes('$(TFVARS_SYNC) diff'));
expect('Makefile does NOT have a tfvars-status target', !/^tfvars-status:$/m.test(mk));
expect('Makefile tfvars-* targets gate on TFVARS_BACKEND != s3', mk.includes('if [ "$(TFVARS_BACKEND)" != s3 ]'));
expect(
  'Makefile tfvars-pull aborts on a dirty TFVARS before pulling',
  /tfvars-pull:\n(?:\t.*\n)*?\t@if \[ -n "\$\$\(git -C \$\(REPO_ROOT\) status --porcelain -- \$\(TFVARS\)\)" \]; then echo .* >&2; exit 1; fi\n\t\$\(TFVARS_SYNC\) pull/.test(mk),
);

// ── plan/apply/setup gating ──────────────────────────────────────────────────
expect(
  'Makefile gates plan auto-pull on TFVARS_BACKEND and NO_PULL',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${NO_PULL:-}" ]; then'),
);
expect(
  'Makefile pull-tfvars-if-needed aborts on a dirty TFVARS before auto-pulling, same as tfvars-pull',
  /pull-tfvars-if-needed:\n(?:\t.*\n)*?\t\s*if \[ -n "\$\$\(git -C \$\(REPO_ROOT\) status --porcelain -- \$\(TFVARS\)\)" \]; then echo .* >&2; exit 1; fi;/.test(
    mk,
  ),
);
expect('Makefile plan depends on pull-tfvars-if-needed', mk.includes('plan: pull-tfvars-if-needed copy-tfvars'));
expect(
  'Makefile gates apply check on TFVARS_BACKEND and FORCE_APPLY',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${FORCE_APPLY:-}" ]; then $(TFVARS_SYNC) check $(TFVARS_SYNC_ARGS); fi'),
);
expect('Makefile apply depends on check-tfvars-if-needed', mk.includes('apply: check-tfvars-if-needed copy-tfvars'));
// setup's post-bootstrap check must NOT reference the TFVARS_BACKEND/TFVARS_BUCKET make
// variables: GNU Make expands a rule's whole recipe (including any $(wildcard ...)/
// $(shell ...) calls hiding inside those variables) before running the recipe's first
// line, so a make-variable-based check would still see the filesystem from before
// the S3 tfvars bootstrap step ran. The check must be shell-native instead.
expect(
  'Makefile setup runtime-pulls tfvars post-bootstrap via a shell-native (not make-variable) S3 backend check that also honors the parent-root marker',
  setupRecipe.includes(
    '[ "$${HYVEON_TFVARS_BACKEND:-}" = s3 ] || { [ "$${HYVEON_TFVARS_BACKEND:-}" != local ] && { [ -f $(PARENT_TFVARS_MARKER) ] || [ -f $(TFVARS_MARKER) ]; }; }',
  ) &&
    setupRecipe.includes('$(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS) 2>&1') &&
    !/if \[ "\$\(TFVARS_BACKEND\)" = s3 \]/.test(setupRecipe),
);

// ── setup's own S3 tfvars-bootstrap step is gated the same way the runtime pull is ──
expect(
  'Makefile setup gates its S3 tfvars-bootstrap step on HYVEON_TFVARS_BACKEND then the parent-root marker',
  setupRecipe.includes('BACKEND="$${HYVEON_TFVARS_BACKEND:-}"') &&
    setupRecipe.includes('if [ -z "$$BACKEND" ] && [ -f $(PARENT_TFVARS_MARKER) ]; then BACKEND=s3; fi'),
);
expect(
  'Makefile setup tolerates a first-time pull against an empty bucket instead of aborting',
  /\$\(TFVARS_SYNC\) pull \$\(TFVARS_SYNC_ARGS\) 2>&1\); then[\s\S]*?run 'make tfvars-push' to seed the bucket/.test(mk),
);
// ── tfvars-sync.ts argv order: subcommand MUST be argv[0] (parseArgs()
// throws its usage error otherwise) — every $(TFVARS_SYNC) call site must
// render "<subcommand> $(TFVARS_SYNC_ARGS)", never flags before the
// subcommand. Regression coverage for the blocker where --path/--bucket
// were rendered ahead of pull|check|push|diff.
expect(
  'Makefile never renders TFVARS_SYNC flags before the subcommand',
  !/\$\(TFVARS_SYNC\)\s+--(path|bucket|key|region)\b/.test(mk),
);
expect(
  'Makefile renders TFVARS_SYNC_ARGS (--path/--bucket) after the pull|push|check|diff subcommand at every call site',
  (mk.match(/\$\(TFVARS_SYNC\)\s+(pull|push|check|diff)\b/g) ?? []).length ===
    (mk.match(/\$\(TFVARS_SYNC\)\s+(?:pull|push|check|diff)\s+\$\(TFVARS_SYNC_ARGS\)/g) ?? []).length &&
    (mk.match(/\$\(TFVARS_SYNC\)\s+(pull|push|check|diff)\b/g) ?? []).length === 6,
);

// ── Updated help text ────────────────────────────────────────────────────────
expect('Makefile help mentions tfvars-diff', mk.includes('make tfvars-diff'));
expect('Makefile help mentions HYVEON_TFVARS_BACKEND override', mk.includes('HYVEON_TFVARS_BACKEND=s3|local'));
expect('Makefile help does NOT mention tfvars-status', !mk.includes('tfvars-status'));
expect('Makefile help describes update as re-init terraform (not rerunning setup.sh)', mk.includes('re-init terraform'));

// ── plan/apply/update/dev call terraform directly, not a delegated Makefile ──
expect(
  'Makefile plan rebuilds lambdas then calls terraform plan directly',
  /plan: pull-tfvars-if-needed copy-tfvars\n\tcd \$\(SUBMODULE\) && npm run app:build:lambdas\n\tterraform -chdir=\$\(TF_DIR\) plan/.test(mk),
);
expect(
  'Makefile apply rebuilds lambdas then calls terraform apply directly, printing a post-deploy checklist',
  /apply: check-tfvars-if-needed copy-tfvars\n\tcd \$\(SUBMODULE\) && npm run app:build:lambdas\n\tterraform -chdir=\$\(TF_DIR\) apply/.test(mk) && mk.includes('Post-deploy checklist') && mk.includes('interactions_invoke_url'),
);
const updateRecipeMatch = /^update:.*\n(?:(?:\t|#).*\n?)*/m.exec(mk);
const updateRecipe = updateRecipeMatch ? updateRecipeMatch[0] : '';
expect('Makefile has an update: recipe to inspect', updateRecipe !== '');
expect(
  'Makefile update bumps the submodule then unconditionally re-inits terraform',
  updateRecipe.includes('git submodule update --remote --merge $(SUBMODULE)') &&
    updateRecipe.includes('terraform -chdir=$(TF_DIR) init') &&
    updateRecipe.indexOf('git submodule update --remote --merge $(SUBMODULE)') <
      updateRecipe.indexOf('terraform -chdir=$(TF_DIR) init'),
);
expect(
  'Makefile update re-inits terraform with the same -backend-config flags setup used, not a bare init relying on the .terraform/ cache',
  updateRecipe.includes('-backend-config="bucket=$$TF_PROJECT-tf-state"') &&
    updateRecipe.includes('-backend-config="dynamodb_table=$$TF_PROJECT-tf-locks"') &&
    updateRecipe.includes('-input=false'),
);
expect(
  'Makefile update fails fast with a pointer to `make setup` when the tf-project stamp is missing, instead of hanging on a partial backend',
  updateRecipe.includes("if [ ! -f $(STAMP_DIR)/tf-project ]; then echo \"Run 'make setup' first.\" >&2; exit 1; fi"),
);
expect('Makefile setup still runs git submodule update --init --recursive', mk.includes('git submodule update --init --recursive'));

const tfv = renderTfvars(a);
expect('tfvars sets project_name', tfv.includes('project_name = "mygames"'));
expect('tfvars sets aws_region', tfv.includes('aws_region   = "us-west-2"'));
expect('tfvars sets hosted_zone_name', tfv.includes('hosted_zone_name = "example.com"'));
expect('tfvars has game_servers map', tfv.includes('game_servers = {'));
expect('tfvars Discord left commented when not configured', tfv.includes('# discord_application_id'));

const gi = renderGitignore(a);
expect('gitignore covers .env', gi.includes('.env\n'));
expect('gitignore covers .make/', gi.includes('.make/'));
expect('gitignore covers tfstate', gi.includes('terraform.tfstate'));
expect('gitignore covers tfvars-sync.ts lock sidecar', gi.includes('*.tfvars.lock'));
expect('gitignore does NOT mention a bearer token', !/bearer token/i.test(gi));

const aDiscord = { ...a, configureDiscord: true, discordApplicationId: '111', discordBotToken: 'btok', discordPublicKey: 'pkey' };
const tfvD = renderTfvars(aDiscord);
expect('tfvars writes Discord values when configured', tfvD.includes('discord_bot_token      = "btok"'));
expect('tfvars writes Discord public key', tfvD.includes('discord_public_key     = "pkey"'));

if (errors.length) {
  process.stderr.write(`\n✗ ${errors.length} render check(s) failed:\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write('✓ All render checks passed.\n');
