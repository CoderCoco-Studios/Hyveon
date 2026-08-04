## Context

Five `aws.lambda.Function` resources (defined in `app/packages/infra/src/lambdas.ts`) share one `LAMBDA_RUNTIME = 'nodejs20.x'` constant; five matching `esbuild.config.mjs` files emit `target: 'node20'`. AWS deprecated `nodejs20.x` on 30 April 2026. The functions keep running — deprecation is not a shutdown — but the runtime stops receiving patches, and Pulumi loses the ability to update these functions on 3 March 2027.

One fact was established by reading the installed dependency, not inferred: `@pulumi/aws@7.39.0` (pinned, no caret, in both `app/packages/infra/package.json` and `app/packages/desktop-main/package.json`) already declares `NodeJS24dX: 'nodejs24.x'` in its `Runtime` enum (`node_modules/@pulumi/aws/types/enums/lambda/index.d.ts`). Unlike Terraform's AWS provider, which validates `runtime` against a list compiled into the provider binary and required an upgrade to accept `nodejs24.x`, Pulumi's `@pulumi/aws` at the version already pinned here accepts the value outright. There is no provider constraint to raise and no plan-wide diff from a provider major bump to triage — this is a narrower change than an equivalent Terraform-era version would have been.

## Goals / Non-Goals

**Goals:**
- Move all five Lambdas onto a runtime AWS supports, with enough runway to avoid repeating the exercise within the year.
- Keep the esbuild targets in lockstep with the runtime in the same change.

**Non-Goals:**
- Changing any Lambda's behaviour, handler signature, dependencies, or IAM. This is a runtime change only.
- Upgrading `@pulumi/aws` or `@pulumi/pulumi` — not required; see Context.
- Touching the developer/CI toolchain Node version, which is handled by `move-toolchain-to-node-24`.

## Decisions

**Target `nodejs24.x`, not `nodejs22.x`.** Node 22 is supported until 30 April 2027 and Node 24 until 30 April 2028. Choosing 22 buys nine months, at which point the same work recurs. Node 24 also matches the Node major the repo now uses for development and CI, so contributors run locally what the Lambdas run in AWS. Because no provider upgrade is forced either way (see Context), there is no offsetting cost to choosing 24 over 22 here — unlike the Terraform-era version of this decision, where 24 also meant an otherwise-avoidable provider bump.

**Change the runtime through one constant, not five call sites.** `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts` is read by all five `defineLambdas`-declared functions; changing it in one place changes all five, so there is no risk of the five drifting relative to each other the way five separate HCL `runtime = "..."` lines could.

**Verify against the live functions, not just a preview.** Each bundle is built with `external: ['@aws-sdk/*']`, meaning the AWS SDK v3 the code calls is the one baked into the Lambda runtime image. Moving the runtime moves that SDK by two majors of Node and an unknown number of SDK minors, with no lockfile recording it. The failure mode is a call that still compiles and still bundles but behaves differently at runtime, which only an invocation catches — hence the post-apply invocation checks in tasks.md rather than a purely static review.

## Risks / Trade-offs

- **The runtime-provided AWS SDK changes underneath the Lambdas.** → Exercise every AWS-calling path after apply: a Discord slash command end-to-end (interactions → followup → ECS), a task start and stop to drive the DNS UPSERT and DELETE, and a watchdog cycle for the CloudWatch and ECS-tag paths.
- **`nodejs24.x` is not available in a region the project deploys to.** → AWS withholds soon-to-deprecate runtimes from new regions, not new runtimes from established ones; `nodejs24.x` on Amazon Linux 2023 is generally available. The Pulumi preview surfaces this immediately if it is wrong for the configured region.
- **Rolling back after apply means another apply.** → Reverting the commit restores `nodejs20.x` and a fresh apply puts it back. `nodejs20.x` remains deployable until 3 March 2027, so the rollback path stays open for the foreseeable window — which is precisely the window this change exists to get ahead of.
- **A stale in-repo assumption resurfaces.** → An earlier draft of this change was written against the deleted `terraform/` tree and assumed a forced provider upgrade. That draft is superseded by this design; anyone consulting old notes or a stale branch should defer to this file and the current `app/packages/infra` source.

## Migration Plan

1. Change `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts` and `target` in all five esbuild configs.
2. Update the three runtime assertions in `app/packages/infra/src/lambdas.test.ts`.
3. `npm run app:build:lambdas` — the Pulumi program's Lambda resources read the bundle output directory (`lambdaBundlesDir`), so the bundles must exist and must be the newly targeted ones before previewing.
4. `npm run app:typecheck` and `npm run app:test` to confirm the updated assertions pass and nothing else references the old runtime string.
5. Run a Pulumi preview through the packaged app (`PulumiService`, stack `production`) and read it in full: confirm the only changes are the five functions' `runtime` (and, if the esbuild output differs enough to change the bundle hash, an in-place code update) — no replacements.
6. Apply, then exercise the live paths (Discord command, task start/stop for DNS, watchdog cycle) and check CloudWatch logs for runtime-level errors.

Rollback: revert the commit, rebuild the bundles, re-apply. Available until AWS blocks updates to `nodejs20.x` on 3 March 2027.

## Open Questions

None outstanding — the provider-support question that was open under the Terraform-era draft is resolved (see Context); no equivalent uncertainty exists for the Pulumi provider already pinned in this repo.
