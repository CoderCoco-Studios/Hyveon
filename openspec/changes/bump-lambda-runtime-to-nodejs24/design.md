## Context

Five `aws_lambda_function` resources declare `runtime = "nodejs20.x"`; five matching `esbuild.config.mjs` files emit `target: 'node20'`. AWS deprecated `nodejs20.x` on 30 April 2026. The functions keep running — deprecation is not a shutdown — but the runtime stops receiving patches, and `terraform apply` loses the ability to update these functions on 3 March 2027.

Two facts were established experimentally before this design was written, not inferred:

1. **Provider 5 cannot express `nodejs24.x`.** A minimal config pinned at `~> 5.0` resolves to 5.100.0 (the last 5.x) and fails `terraform validate` with `expected runtime to be one of [... "nodejs20.x" ... "nodejs22.x"], got nodejs24.x`. The provider validates against a list compiled into it, so this fails locally, before any AWS call.
2. **The real module validates under provider 6 with `nodejs24.x`.** Bumping both constraints to `~> 6.0` and all five runtimes to `nodejs24.x`, then running `terraform init -backend=false && terraform validate` against `terraform/`, returns `Success! The configuration is valid` with provider 6.56.0 — plus two deprecation warnings, both `hash_key is deprecated. Use key_schema instead.`, on `aws_dynamodb_table.runs` and `aws_dynamodb_table.audit`.

`terraform validate` is not `terraform plan`. Validation proves the configuration is expressible; only a plan against real state shows whether provider 6 wants to change or replace anything.

## Goals / Non-Goals

**Goals:**
- Move all five Lambdas onto a runtime AWS supports, with enough runway to avoid repeating the exercise within the year.
- Keep the esbuild targets in lockstep with the runtime in the same change.
- Raise the AWS provider only as far as the runtime requires, and review the resulting plan rather than assume it is empty.

**Non-Goals:**
- Changing any Lambda's behaviour, handler signature, dependencies, or IAM. This is a runtime and provider change only.
- Migrating `hash_key` → `key_schema`. See the decision below.
- Touching the developer/CI toolchain Node version, which is handled by `move-toolchain-to-node-24`.
- Modernising anything else the provider 6 upgrade happens to make available.

## Decisions

**Target `nodejs24.x`, not `nodejs22.x`.** Node 22 is supported until 30 April 2027 and Node 24 until 30 April 2028. Choosing 22 avoids the provider upgrade entirely — it is on provider 5's accepted list — but buys nine months, at which point the same work recurs plus the provider upgrade that was deferred. Node 24 also matches the Node major the repo now uses for development and CI, so contributors run locally what the Lambdas run in AWS. The cost is that the provider upgrade becomes mandatory rather than optional; that cost is paid once either way.

**Raise the provider to `~> 6.0` in the same change, not a preceding one.** Splitting it would produce a provider-only PR whose entire justification is a runtime change that isn't in it, and whose plan output could not be evaluated against the thing it exists to enable. Keeping them together means one plan review covering both. The constraint moves in `terraform/main.tf` and `terraform/aws/versions.tf` together — they are duplicated declarations of the same dependency and drift between them is its own bug.

**Leave `hash_key` alone; treat the warnings as a follow-up.** Provider 6 deprecates `hash_key` in favour of `key_schema` on `aws_dynamodb_table`. Deprecation warnings do not block apply, and `key_schema` restructures how the table's key is declared — on a table holding live Discord config, run history, and audit rows, a botched key declaration risks a replacement, which destroys data. That belongs in a change whose plan is read specifically for it, not bundled into a runtime bump where a `~` on a DynamoDB table would be easy to skim past. The warnings are recorded here so the next person knows they are known rather than missed.

**Verify against the live functions, not just the plan.** Each bundle is built with `external: ['@aws-sdk/*']`, meaning the AWS SDK v3 the code calls is the one baked into the Lambda runtime image. Moving the runtime moves that SDK by two majors of Node and an unknown number of SDK minors, with no lockfile recording it. The failure mode is a call that still compiles and still bundles but behaves differently at runtime, which only an invocation catches — hence the post-apply invocation checks in tasks.md rather than a purely static review.

## Risks / Trade-offs

- **Provider 6 wants to change resources unrelated to Lambda.** → The plan is generated and read in full before apply. Any non-empty diff outside the five Lambda functions is triaged before proceeding; if a resource would be *replaced* rather than updated in place, the change stops and that resource is handled deliberately. This is the single largest risk in the change and the reason a plan review is a task rather than a formality.
- **The runtime-provided AWS SDK changes underneath the Lambdas.** → Exercise every AWS-calling path after apply: a Discord slash command end-to-end (interactions → followup → ECS), a task start and stop to drive the DNS UPSERT and DELETE, and a watchdog cycle for the CloudWatch and ECS-tag paths.
- **`nodejs24.x` is not available in a region the project deploys to.** → AWS withholds soon-to-deprecate runtimes from new regions, not new runtimes from established ones; `nodejs24.x` on Amazon Linux 2023 is generally available. The plan surfaces this immediately if it is wrong for the configured region.
- **Rolling back after apply means another apply.** → Reverting the commit restores `nodejs20.x` and the provider constraint, and a fresh apply puts it back. `nodejs20.x` remains deployable until 3 March 2027, so the rollback path stays open for the foreseeable window — which is precisely the window this change exists to get ahead of.
- **Two Terraform files declare the provider constraint.** → Both are changed in the same commit; a grep for `~> 5.0` is part of the task list so neither is missed.

## Migration Plan

1. Change `runtime` in all five Lambda resources and `target` in all five esbuild configs.
2. Raise the AWS provider constraint to `~> 6.0` in `terraform/main.tf` and `terraform/aws/versions.tf`.
3. `npm run app:build:lambdas` — Terraform's `archive_file` data sources read `dist/handler.cjs`, so the bundles must exist and must be the newly targeted ones before planning.
4. `terraform init -upgrade`, then `terraform validate`, then `terraform plan`. Read the whole plan; confirm the only changes are the five functions plus whatever the provider upgrade legitimately introduces, and that nothing is being replaced.
5. `terraform apply`.
6. Exercise the live paths (Discord command, task start/stop for DNS, watchdog cycle) and check CloudWatch logs for runtime-level errors.

Rollback: revert the commit, rebuild the bundles, re-apply. Available until AWS blocks updates to `nodejs20.x` on 3 March 2027.

## Open Questions

- Does `terraform plan` under provider 6 show diffs beyond the five Lambdas? Unknown until run against real state with credentials — `validate` cannot answer it. This is the first task in the verification group and gates the apply.
