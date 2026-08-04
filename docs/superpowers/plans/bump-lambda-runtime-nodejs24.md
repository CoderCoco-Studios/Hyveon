# Bump Lambda runtime to nodejs24.x

## Context

OpenSpec change `bump-lambda-runtime-to-nodejs24`
(`openspec/changes/bump-lambda-runtime-to-nodejs24/proposal.md`,
`design.md`, `tasks.md`; spec `lambda-runtime-currency`). AWS deprecated
`nodejs20.x` on 30 April 2026 (function creation blocks 1 February 2027,
updates block 3 March 2027). All five Lambdas (`interactions`, `followup`,
`update-dns`, `watchdog`, `efs-seeder`) move to `nodejs24.x`.

This plan covers the code change and its static verification only —
`tasks.md` sections 3 ("Preview review") and 4 ("Apply and live
verification") apply a live Pulumi stack against real AWS infrastructure
and exercise a live Discord bot; that is an operator action requiring real
AWS credentials and the packaged desktop app, not something a coding
subagent should do. Those remain manual follow-up steps after this plan's
single task lands and passes review — see "Not in scope" below.

## Global Constraints

**Single source of truth for the runtime:** `LAMBDA_RUNTIME` in
`app/packages/infra/src/lambdas.ts` (currently `const LAMBDA_RUNTIME =
'nodejs20.x';`, with a doc comment above it referencing `nodejs20.x` in the
HCL — that comment is stale from the pre-Pulumi era and should be corrected
to stop citing HCL, since there is no HCL in this repo anymore). Change the
constant's value to `'nodejs24.x'`. This one constant is read by all five
`aws.lambda.Function` declarations in that file — do not introduce five
separate literals.

**Esbuild targets:** all five `app/packages/lambda/*/esbuild.config.mjs`
files (`efs-seeder`, `followup`, `interactions`, `update-dns`, `watchdog`)
currently declare `target: 'node20'`. Change each to `target: 'node24'`.
The bundle's output syntax and the runtime executing it must move together
in the same commit — do not change the runtime without the esbuild
targets, or vice versa.

**Test assertions:** `app/packages/infra/src/lambdas.test.ts` currently
asserts `expect(fn.inputs.runtime).toBe('nodejs20.x')` at three call sites
(as of this plan's writing, approximately lines 214, 276, 536 — confirm by
grepping the file, since line numbers drift). Update all three to
`'nodejs24.x'`. Grep the whole file for `nodejs20` first to make sure no
other assertion is missed.

**Sweep for stragglers:** after the above, grep the repo for `nodejs20` and
`node20` (word-boundary aware — don't match `node2000` or similar) outside
`node_modules` and confirm nothing remains except historical references
that are correct to leave alone (e.g. a changelog entry describing a past
state). If any `docs/docs/**` page states the Lambda runtime version,
update it to `nodejs24.x` in this task — this is documentation the PR
should already be updating, not a deferred follow-up.

**Do not touch:** `@pulumi/aws`/`@pulumi/pulumi` package.json pins (already
support `nodejs24.x` — confirmed via the installed `Runtime` enum
declaring `NodeJS24dX: 'nodejs24.x'`, no upgrade needed), Lambda handler
code, IAM policies, or anything under `app/packages/lambda/*/src`.

**Verification commands (run all three, in this order, and report their
output in the task report):**
1. `npm run app:build:lambdas` — must produce all five
   `app/packages/lambda/*/dist/handler.cjs` bundles without error.
2. `npm run app:typecheck` — must be clean.
3. `npm run app:test` — must be fully green, including the three updated
   assertions in `lambdas.test.ts`.

## Task 1: Bump the Lambda runtime and esbuild targets to Node 24

Make every change described in Global Constraints: the `LAMBDA_RUNTIME`
constant (and its stale doc comment) in `app/packages/infra/src/lambdas.ts`,
all five `esbuild.config.mjs` `target` fields, the three test assertions in
`lambdas.test.ts`, and any remaining `nodejs20`/`node20` references
(including documentation). Run the three verification commands and include
their pass/fail output in your report. Commit the change.

## Not in scope for this plan (manual operator follow-up)

After Task 1 lands and passes review, the change is not yet deployed. The
remaining `tasks.md` items (3.1-3.4 Pulumi preview review, 4.1-4.6 apply +
live verification against the Discord bot, DNS, and watchdog) require a
human operator running the packaged desktop app against real AWS
credentials, and are **not** part of this SDD plan. Do not dispatch a
subagent for them.
