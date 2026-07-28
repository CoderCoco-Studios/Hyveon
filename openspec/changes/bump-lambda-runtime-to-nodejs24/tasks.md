## 1. Provider constraint

- [ ] 1.1 Raise the AWS provider constraint from `~> 5.0` to `~> 6.0` in `terraform/main.tf`
- [ ] 1.2 Raise the same constraint in `terraform/aws/versions.tf` (note the different alignment — it also carries `configuration_aliases`)
- [ ] 1.3 Grep `terraform/` for any remaining `~> 5.0` to confirm both declarations moved

## 2. Runtime and build target

- [ ] 2.1 Change `runtime = "nodejs20.x"` to `"nodejs24.x"` in `terraform/aws/interactions.tf`, `followup.tf`, `route53.tf`, `watchdog.tf`, and `efs-seeder.tf`
- [ ] 2.2 Change `target: 'node20'` to `'node24'` in all five `app/packages/lambda/*/esbuild.config.mjs`
- [ ] 2.3 Grep the repo for remaining `nodejs20`/`node20` references and update any documentation that states the Lambda runtime version

## 3. Static verification

- [ ] 3.1 Run `npm run app:build:lambdas` and confirm all five `dist/handler.cjs` bundles are produced — Terraform's `archive_file` data sources fail without them
- [ ] 3.2 Run `terraform init -upgrade` in `terraform/` and confirm it installs an AWS provider in the 6.x line
- [ ] 3.3 Run `terraform validate` and confirm success; expect two `hash_key is deprecated` warnings on `aws_dynamodb_table.runs` and `aws_dynamodb_table.audit`, which are known and deliberately not fixed here
- [ ] 3.4 Run `terraform fmt -check -recursive` and `tflint` from `terraform/`

## 4. Plan review (gate)

- [ ] 4.1 Run `terraform plan` against real state and read the output in full
- [ ] 4.2 Confirm the five Lambda functions show a runtime update in place
- [ ] 4.3 Triage every other diff the provider 6 upgrade introduces; if any resource would be **replaced** rather than updated in place, stop and handle it deliberately before applying
- [ ] 4.4 Record the plan summary in the PR so the apply is reviewable after the fact

## 5. Apply and live verification

- [ ] 5.1 Run `terraform apply`
- [ ] 5.2 Confirm all five deployed functions report `nodejs24.x`
- [ ] 5.3 Run a Discord slash command end-to-end (`/server-start` then `/server-status`) to exercise interactions → followup → ECS, including the DynamoDB pending-interaction write and the Secrets Manager reads
- [ ] 5.4 Confirm the DNS record is UPSERTed on task RUNNING and DELETEd on task STOPPED — this exercises `update-dns` and its Route 53 calls
- [ ] 5.5 Let one watchdog interval elapse and confirm it reads CloudWatch metrics and writes its idle-counter ECS task tag without error
- [ ] 5.6 Check each function's CloudWatch log group for runtime-level errors (module resolution, SDK client construction) rather than only application errors

## 6. Follow-up

- [ ] 6.1 File a separate change for the `hash_key` → `key_schema` migration on `aws_dynamodb_table.runs` and `aws_dynamodb_table.audit`, to be planned and reviewed on its own — a mistake there can replace a table holding live data
