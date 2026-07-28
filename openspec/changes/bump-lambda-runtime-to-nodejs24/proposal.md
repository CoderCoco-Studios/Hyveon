## Why

All five Lambdas (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) declare `runtime = "nodejs20.x"`, and AWS deprecated that runtime on **30 April 2026** — it is listed under "Deprecated runtimes", not "Supported runtimes". Deprecated functions keep running and keep receiving invocations, but AWS stops patching the runtime, and two hard cutoffs are already scheduled: **function creation blocked 1 February 2027** and **function updates blocked 3 March 2027**. After the second date, `terraform apply` can no longer push new Lambda code at all, which would leave the Discord bot, the DNS updater, the watchdog, and the EFS seeder frozen at whatever version was last deployed.

The runtime is not automatically dragged along by a developer-toolchain change — the companion `move-toolchain-to-node-24` change explicitly excludes it — so it needs its own change and its own deploy.

## What Changes

- All five Lambdas move from `runtime = "nodejs20.x"` to `runtime = "nodejs24.x"` in `terraform/aws/{interactions,followup,route53,watchdog,efs-seeder}.tf`. Node 24 (not 22) because it is supported until 30 April 2028 against Node 22's 30 April 2027 — targeting 22 would mean repeating this exercise in nine months — and because it matches the Node 24 the repo now uses for development and CI.
- The esbuild `target` in all five `app/packages/lambda/*/esbuild.config.mjs` files moves from `'node20'` to `'node24'`, in the same change. The bundle's output syntax and the runtime executing it must stay in lockstep.
- **BREAKING** (infrastructure, not API): the AWS provider constraint goes from `~> 5.0` to `~> 6.0` in both `terraform/main.tf` and `terraform/aws/versions.tf`. This is forced, not optional — provider 5.100.0, the last 5.x release, rejects `nodejs24.x` at `terraform validate` because the runtime postdates it. A major provider upgrade touches every resource in the module, so the plan output is reviewed as part of this change rather than assumed clean.
- Two `hash_key` arguments (`aws_dynamodb_table.runs`, `aws_dynamodb_table.audit`) become deprecation warnings under provider 6 and should move to `key_schema`. Whether that happens here or in a follow-up is a scoping call recorded in design.md.
- Any documentation stating the Lambda runtime version is updated to match.

## Capabilities

### New Capabilities

- `lambda-runtime-currency`: the deployed Lambda runtime is a version AWS still supports, the esbuild target that produces each bundle matches the runtime that executes it, and the Terraform AWS provider is new enough to express the chosen runtime. Covers the standing rule that these three move together.

### Modified Capabilities

None. No existing spec in `openspec/specs/` states a Lambda runtime version.

## Impact

- **Terraform**: `terraform/aws/interactions.tf`, `followup.tf`, `route53.tf`, `watchdog.tf`, `efs-seeder.tf` (runtime), plus `terraform/main.tf` and `terraform/aws/versions.tf` (provider constraint).
- **Build**: the five `app/packages/lambda/*/esbuild.config.mjs` files.
- **Deploy**: requires `npm run app:build:lambdas` followed by a reviewed `terraform plan` and a `terraform apply`. This is the first change in this sequence that alters live AWS resources — the toolchain change did not.
- **Runtime behaviour**: each Lambda bundles with `external: ['@aws-sdk/*']`, so the AWS SDK v3 they execute against is the copy shipped inside the Lambda runtime image, not one in the bundle. Changing the runtime therefore also changes the SDK version at runtime — a dependency that is invisible in `package.json` and is called out in design.md as the main behavioural risk.
- **Not affected**: no application, desktop, or renderer code; no game task definitions; no DNS, ECS, or Discord behaviour beyond the Lambdas being redeployed.
