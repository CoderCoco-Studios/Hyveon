## ADDED Requirements

### Requirement: HyveonDeployAll permits creating the ECS service-linked role

The `HyveonDeployAll` policy SHALL include a statement (`HyveonServiceLinkedRoles`)
granting `iam:CreateServiceLinkedRole`, scoped to the resource path
`arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*`
and conditioned on `iam:AWSServiceName` equal to `ecs.amazonaws.com`. This
statement MUST NOT grant `iam:CreateServiceLinkedRole` for any other AWS
service, and adding it MUST NOT require any change beyond the shared policy
generator (`app/packages/shared/src/iamPolicy.ts`), since the CloudFormation
template and `docs/docs/setup.md` are both derived from that single source
and locked in sync by `iamPolicy.test.ts`.

#### Scenario: Policy JSON includes the scoped statement

- **WHEN** the `HyveonDeployAll` policy JSON is generated from `iamPolicy.ts`
- **THEN** it contains a `HyveonServiceLinkedRoles` statement permitting
  `iam:CreateServiceLinkedRole` only for the ECS service-linked-role ARN
  path, conditioned on `iam:AWSServiceName: ecs.amazonaws.com`

#### Scenario: Generated artifacts stay in sync

- **WHEN** the policy generator changes
- **THEN** `iamPolicy.test.ts` fails if the CloudFormation template or
  `docs/docs/setup.md` policy JSON block drifts from the generator's output
