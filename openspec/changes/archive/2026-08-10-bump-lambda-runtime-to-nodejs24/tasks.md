## 1. Runtime and build target

- [x] 1.1 Change `LAMBDA_RUNTIME` from `'nodejs20.x'` to `'nodejs24.x'` in `app/packages/infra/src/lambdas.ts`
- [x] 1.2 Change `target: 'node20'` to `'node24'` in all five `app/packages/lambda/*/esbuild.config.mjs`
- [x] 1.3 Update the three `'nodejs20.x'` assertions in `app/packages/infra/src/lambdas.test.ts` to `'nodejs24.x'`
- [x] 1.4 Grep the repo for remaining `nodejs20`/`node20` references and update any documentation that states the Lambda runtime version

## 2. Static verification

- [x] 2.1 Run `npm run app:build:lambdas` and confirm all five `dist/handler.cjs` bundles are produced — the infra program's Lambda resources read this output directory
- [x] 2.2 Run `npm run app:typecheck` and confirm clean
- [x] 2.3 Run `npm run app:test` and confirm the updated `lambdas.test.ts` assertions pass

## 3. Preview review (gate)

- [x] 3.1 Run a Pulumi preview against the `production` stack (via the packaged app's `PulumiService`) and read the output in full — performed via the operator's live desktop app deploy
- [x] 3.2 Confirm the five Lambda functions show a `runtime` update in place, with no unrelated resource diffs — confirmed via live deploy
- [x] 3.3 If any resource would be **replaced** rather than updated in place, stop and handle it deliberately before applying — no replacements occurred
- [x] 3.4 Record the preview summary in the PR so the apply is reviewable after the fact — noted in archive PR description

## 4. Apply and live verification

- [x] 4.1 Apply the stack — applied via the operator's live desktop app
- [x] 4.2 Confirm all five deployed functions report `nodejs24.x` — confirmed in AWS by operator
- [x] 4.3 Run a Discord slash command end-to-end (`/server-start` then `/server-status`) to exercise interactions → followup → ECS, including the DynamoDB pending-interaction write and the Secrets Manager reads — confirmed working by operator
- [x] 4.4 Confirm the DNS record is UPSERTed on task RUNNING and DELETEd on task STOPPED — this exercises `update-dns` and its Route 53 calls — confirmed working by operator
- [x] 4.5 Let one watchdog interval elapse and confirm it reads CloudWatch metrics and writes its idle-counter ECS task tag without error — confirmed by operator
- [x] 4.6 Check each function's CloudWatch log group for runtime-level errors (module resolution, SDK client construction) rather than only application errors — confirmed clean by operator
