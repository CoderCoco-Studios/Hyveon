## Why

All five Lambdas (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) declare `runtime = 'nodejs20.x'` via `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts`, and AWS deprecated that runtime on **30 April 2026** — it is listed under "Deprecated runtimes", not "Supported runtimes". Deprecated functions keep running and keep receiving invocations, but AWS stops patching the runtime, and two hard cutoffs are already scheduled: **function creation blocked 1 February 2027** and **function updates blocked 3 March 2027**. After the second date, a Pulumi `up` can no longer push new Lambda code at all, which would leave the Discord bot, the DNS updater, the watchdog, and the EFS seeder frozen at whatever version was last deployed.

The runtime is not automatically dragged along by a developer-toolchain change — the companion `move-toolchain-to-node-24` change explicitly excludes it — so it needs its own change and its own deploy.

## What Changes

- All five Lambdas move from `runtime = 'nodejs20.x'` to `runtime = 'nodejs24.x'` via the single `LAMBDA_RUNTIME` constant in `app/packages/infra/src/lambdas.ts`. Node 24 (not 22) because it is supported until 30 April 2028 against Node 22's 30 April 2027 — targeting 22 would mean repeating this exercise in nine months — and because it matches the Node 24 the repo now uses for development and CI.
- The esbuild `target` in all five `app/packages/lambda/*/esbuild.config.mjs` files moves from `'node20'` to `'node24'`, in the same change. The bundle's output syntax and the runtime executing it must stay in lockstep.
- No provider bump is required. `@pulumi/aws` is pinned at `7.39.0` in both `app/packages/infra/package.json` and `app/packages/desktop-main/package.json`, and that version's `Runtime` enum already includes `NodeJS24dX: 'nodejs24.x'` — confirmed by reading the installed package's type declarations. This is a material difference from a Terraform-era draft of this change, which assumed an AWS *provider* upgrade (and an accompanying `hash_key`→`key_schema` DynamoDB deprecation-warning side effect) would be forced alongside the runtime bump; neither applies here. There is no Terraform anywhere in this repository — the `terraform/` tree was deleted by `migrate-iac-to-pulumi` — and Pulumi's `@pulumi/aws` provider has no equivalent constraint to raise.
- The three `runtime` assertions in `app/packages/infra/src/lambdas.test.ts` (currently `'nodejs20.x'`) move to `'nodejs24.x'`.
- Any documentation stating the Lambda runtime version is updated to match.

## Capabilities

### New Capabilities

- `lambda-runtime-currency`: the deployed Lambda runtime is a version AWS still supports, and the esbuild target that produces each bundle matches the runtime that executes it. Covers the standing rule that these two move together.

### Modified Capabilities

None. No existing spec in `openspec/specs/` states a Lambda runtime version.

## Impact

- **Infra program**: `app/packages/infra/src/lambdas.ts` (`LAMBDA_RUNTIME` constant, single source for all five functions) and `app/packages/infra/src/lambdas.test.ts` (runtime assertions).
- **Build**: the five `app/packages/lambda/*/esbuild.config.mjs` files.
- **Deploy**: requires `npm run app:build:lambdas` followed by a reviewed Pulumi preview and an apply, driven from inside the packaged app by `PulumiService` (`app/packages/desktop-main/src/services/PulumiService.ts`) — there is no CLI `terraform plan`/`apply` step and no host-installed `pulumi` binary. This is the first change in this sequence that alters live AWS resources — the toolchain change did not.
- **Runtime behaviour**: each Lambda bundles with `external: ['@aws-sdk/*']`, so the AWS SDK v3 they execute against is the copy shipped inside the Lambda runtime image, not one in the bundle. Changing the runtime therefore also changes the SDK version at runtime — a dependency that is invisible in `package.json` and is called out in design.md as the main behavioural risk.
- **Not affected**: no application, desktop, or renderer code beyond the two test assertions and Lambda source noted above; no game task definitions; no DNS, ECS, or Discord behaviour beyond the Lambdas being redeployed.
