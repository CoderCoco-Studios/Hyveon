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
expect('Makefile dev target does NOT shell out to terraform', !mk.includes('terraform'));
expect('Makefile dev target runs npm run app:dev directly in the submodule', mk.includes('cd $(SUBMODULE) && npm run app:dev'));
expect('Makefile uses bash shell', mk.startsWith('SHELL      := /usr/bin/env bash'));

// ── No more .env / API_TOKEN / setup.sh delegation ──────────────────────────
expect('Makefile does NOT inline API_TOKEN', !/API_TOKEN\s*:?=\s*[a-f0-9]{40,}/.test(mk));
expect('Makefile does NOT reference API_TOKEN at all', !mk.includes('API_TOKEN'));
expect('Makefile does NOT include .env', !mk.includes('include $(REPO_ROOT)/.env'));
expect('Makefile does NOT reference a .env file', !/\.env\b/.test(mk));
// Comments may still mention "the old setup.sh" for historical context, but
// nothing may actually invoke it.
expect('Makefile does NOT shell out to setup.sh', !mk.includes('bash $(SUBMODULE)/setup.sh') && !mk.includes('./setup.sh'));
expect('Makefile does NOT delegate to a Makefile inside the submodule', !mk.includes('$(MAKE) -C $(SUBMODULE)'));
expect('Makefile does NOT use a SETUP_STAMP/sha256 drift-detection mechanism', !mk.includes('SETUP_STAMP') && !mk.includes('sha256sum'));

// ── setup recipe is self-contained and infra-free ───────────────────────────
const setupRecipeMatch = /^setup:.*\n(?:(?:\t|#).*\n?)*/m.exec(mk);
const setupRecipe = setupRecipeMatch ? setupRecipeMatch[0] : '';
expect('Makefile has a setup: recipe to inspect', setupRecipe !== '');
expect('Makefile setup runs git submodule update --init --recursive', setupRecipe.includes('git submodule update --init --recursive'));
expect('Makefile setup runs npm install in the submodule', setupRecipe.includes('cd $(SUBMODULE) && npm install'));
expect('Makefile setup builds the Lambda bundles', setupRecipe.includes('cd $(SUBMODULE) && npm run app:build:lambdas'));
expect('Makefile setup does NOT create the Terraform state S3 bucket', !setupRecipe.includes('aws s3api head-bucket') && !setupRecipe.includes('aws s3api create-bucket'));
expect('Makefile setup does NOT create a DynamoDB lock table', !setupRecipe.includes('aws dynamodb'));
expect('Makefile setup does NOT bootstrap a tfvars S3 bucket via terraform/bootstrap', !setupRecipe.includes('terraform/bootstrap'));
expect('Makefile setup does NOT run terraform init', !setupRecipe.includes('terraform -chdir=$(TF_DIR) init'));
expect('Makefile setup does NOT copy tfvars into the submodule', !setupRecipe.includes('cp $(TFVARS)'));

// ── No tfvars-sync / S3 tfvars backend machinery remains ────────────────────
expect('Makefile does NOT define TFVARS_MARKER', !mk.includes('TFVARS_MARKER'));
expect('Makefile does NOT define PARENT_TFVARS_MARKER', !mk.includes('PARENT_TFVARS_MARKER'));
expect('Makefile does NOT define TFVARS_BACKEND', !mk.includes('TFVARS_BACKEND'));
expect('Makefile does NOT define TFVARS_BUCKET', !mk.includes('TFVARS_BUCKET'));
expect('Makefile does NOT define TFVARS_SYNC', !mk.includes('TFVARS_SYNC'));
expect('Makefile does NOT define a TFVARS variable', !mk.includes('TFVARS      :='));
expect('Makefile does NOT reference HYVEON_TFVARS_BACKEND', !mk.includes('HYVEON_TFVARS_BACKEND'));
expect('Makefile does NOT reference HYVEON_TFVARS_BUCKET', !mk.includes('HYVEON_TFVARS_BUCKET'));

// ── No plan/apply/copy-tfvars/tfvars-* targets remain ───────────────────────
expect('Makefile phonies list only help/setup/update/dev', mk.includes('.PHONY: help setup update dev'));
expect('Makefile does NOT have a plan: target', !/^plan:/m.test(mk));
expect('Makefile does NOT have an apply: target', !/^apply:/m.test(mk));
expect('Makefile does NOT have a copy-tfvars: target', !/^copy-tfvars:/m.test(mk));
expect('Makefile does NOT have a pull-tfvars-if-needed: target', !/^pull-tfvars-if-needed:/m.test(mk));
expect('Makefile does NOT have a check-tfvars-if-needed: target', !/^check-tfvars-if-needed:/m.test(mk));
expect('Makefile does NOT have a tfvars-pull: target', !/^tfvars-pull:/m.test(mk));
expect('Makefile does NOT have a tfvars-push: target', !/^tfvars-push:/m.test(mk));
expect('Makefile does NOT have a tfvars-diff: target', !/^tfvars-diff:/m.test(mk));

// ── Updated help text ────────────────────────────────────────────────────────
expect('Makefile help mentions setup/update/dev only', mk.includes('make setup') && mk.includes('make update') && mk.includes('make dev'));
expect('Makefile help does NOT mention plan/apply/tfvars-*', !mk.includes('make plan') && !mk.includes('make apply') && !mk.includes('make tfvars-'));

// ── update: just bumps the submodule, no terraform re-init ─────────────────
const updateRecipeMatch = /^update:.*\n(?:(?:\t|#).*\n?)*/m.exec(mk);
const updateRecipe = updateRecipeMatch ? updateRecipeMatch[0] : '';
expect('Makefile has an update: recipe to inspect', updateRecipe !== '');
expect('Makefile update bumps the submodule', updateRecipe.includes('git submodule update --remote --merge $(SUBMODULE)'));
expect('Makefile update does NOT re-init terraform', !updateRecipe.includes('terraform -chdir=$(TF_DIR) init'));
expect('Makefile update reminds you to commit the new submodule pointer', updateRecipe.includes("git commit -m 'chore: bump"));

const tfv = renderTfvars(a);
expect('tfvars sets project_name', tfv.includes('project_name = "mygames"'));
expect('tfvars sets aws_region', tfv.includes('aws_region   = "us-west-2"'));
expect('tfvars sets hosted_zone_name', tfv.includes('hosted_zone_name = "example.com"'));
expect('tfvars has game_servers map', tfv.includes('game_servers = {'));
expect('tfvars Discord left commented when not configured', tfv.includes('# discord_application_id'));
expect('tfvars does NOT claim the Makefile copies it into the submodule on plan/apply', !tfv.includes('on every plan/apply'));

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
