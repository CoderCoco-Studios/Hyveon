## 1. Pulumi resource tags

- [ ] 1.1 Add `Game: game` tag to each per-game `aws.ecs.TaskDefinition` in `app/packages/infra/src/ecs.ts` (alongside the existing `Name` tag)
- [ ] 1.2 Add `Game: game` tag to each per-game `aws.cloudwatch.LogGroup` in `app/packages/infra/src/ecs.ts`
- [ ] 1.3 Add `Game: game` tag to the per-game EFS-seeder `aws.lambda.Function` and its `aws.cloudwatch.LogGroup` in `app/packages/infra/src/lambdas.ts`

## 2. Runtime tag propagation

- [ ] 2.1 Set `propagateTags: 'TASK_DEFINITION'` on the `RunTaskCommand` input in `app/packages/cloud-aws/src/AwsCloudProvider.ts`

## 3. Tests

- [ ] 3.1 Extend `app/packages/infra/src/program.test.ts` (or the relevant `ecs`/`lambdas` unit test file) to assert the new `Game` tag on task definitions, per-game log groups, and the EFS-seeder Lambda + its log group
- [ ] 3.2 Assert shared resources (ECS cluster, security groups, DynamoDB tables, the four project-wide Lambdas, EFS filesystem/access points) do NOT carry a `Game` tag
- [ ] 3.3 Add/extend a unit test for `AwsCloudProvider`'s `RunTask` path asserting `propagateTags: 'TASK_DEFINITION'` is set on the `RunTaskCommand` input

## 4. Documentation

- [ ] 4.1 Update `docs/docs/components/infra.md` resource/tag table to add a `Game` column for the newly-tagged resources
- [ ] 4.2 Add a note in `docs/docs/components/infra.md` documenting the manual AWS Billing console step to activate `Game` as a cost allocation tag (non-retroactive, ~24h propagation), and an example `aws ce get-cost-and-usage --group-by Type=TAG,Key=Game` query for pulling a per-game breakdown

## 5. Verification

- [ ] 5.1 `npm run app:lint`
- [ ] 5.2 `npm run app:typecheck`
- [ ] 5.3 `npm run app:test`
