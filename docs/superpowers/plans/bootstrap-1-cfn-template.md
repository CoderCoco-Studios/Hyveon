# Group 1: CloudFormation template generation

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap` (full context:
`openspec/changes/add-one-click-aws-bootstrap/{proposal,design}.md`). This
group ships the static building blocks a later group (`GuidedIamService`,
not part of this branch) will render and hand to the operator: a TypeScript
generator that reproduces the real `HyveonDeployAll` four-statement IAM
policy from the existing `HYVEON_DEPLOY_ALL_ACTIONS` source of truth, and
a CloudFormation template shell that creates the deploy IAM user, its
policies, and a bootstrap access key. Nothing in this group talks to AWS —
that's the next group. This group produces pure, testable artifacts.

## Global Constraints

**The exact four-statement policy** (from `docs/docs/setup.md`, the
canonical human-readable reference — reproduce exactly, action-for-action,
Sid-for-Sid):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HyveonDeploy",
      "Effect": "Allow",
      "Action": [
        "ecs:*", "elasticfilesystem:*", "ec2:*", "lambda:*", "logs:*",
        "cloudwatch:*", "events:*", "route53:*", "ce:*", "dynamodb:*",
        "secretsmanager:*", "s3:*", "cloudfront:*", "acm:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "HyveonIAM",
      "Effect": "Allow",
      "Action": "iam:*",
      "Resource": ["arn:aws:iam::*:role/hyveon-*", "arn:aws:iam::*:policy/hyveon-*"]
    },
    {
      "Sid": "HyveonConfigurationBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket",
        "s3:GetObjectVersion", "s3:GetBucketVersioning", "s3:PutBucketVersioning",
        "s3:GetBucketLocation", "s3:PutLifecycleConfiguration",
        "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": ["arn:aws:s3:::${project_name}-tfvars", "arn:aws:s3:::${project_name}-tfvars/*"]
    },
    {
      "Sid": "HyveonStateBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": ["arn:aws:s3:::${project_name}-tfstate", "arn:aws:s3:::${project_name}-tfstate/*"]
    }
  ]
}
```

`${project_name}` in the doc is documentation notation, not a literal
CloudFormation intrinsic — `hyveon` is the default project/bucket-name
prefix used elsewhere in the wizard (`hyveon-tfstate`, `hyveon-tfvars`).
**`HyveonStateBucket` MUST NOT contain any `dynamodb:*` or lock-table
action** — Pulumi's self-managed S3 backend has no lock table.

**Structural source-of-truth decision (load-bearing, do not deviate):**
`HYVEON_DEPLOY_ALL_ACTIONS` in `app/packages/shared/src/iamPolicy.ts` is a
*flattened, deduplicated* action list (already consumed by
`IamCheckService`'s `iam:SimulatePrincipalPolicy` calls and locked against
`docs/docs/setup.md` by the existing `iamPolicy.test.ts`) — it cannot be
reverse-engineered back into four statements because `HyveonStateBucket`'s
actions are a subset of actions that already appear (with a different
Resource) under `HyveonConfigurationBucket`, and dedup erases which
statement they came from. Do not modify `HYVEON_DEPLOY_ALL_ACTIONS` or its
existing test. Instead, add a **new** exported structured constant in the
same file — name it `HYVEON_DEPLOY_ALL_STATEMENTS` — holding the four
statements verbatim (Sid, Effect, Action array, Resource template function
or array), and a new test asserting `[...new Set(HYVEON_DEPLOY_ALL_STATEMENTS.flatMap(s => s.Action))]`
equals the same set as `HYVEON_DEPLOY_ALL_ACTIONS` (drift guard between the
two representations), in addition to the doc-comparison test task 1.4
describes.

**Interface contract with the next group (`GuidedIamService`, not part of
this branch — do not implement it, but the artifact this group produces
must satisfy it):** `iam-bootstrap.yaml` is a **static template shell**,
not runtime-generated. Its two `AWS::IAM::ManagedPolicy` resources'
`PolicyDocument:` properties MUST each contain a literal, distinct
placeholder token instead of inline JSON:
- `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` for the `HyveonDeployAll` policy
- `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` for the `HyveonSelfRotate` policy

A later group's `GuidedIamService` will read this file and do a literal
string replacement of each token with `JSON.stringify(<generator output>)`
(single-line, no `null, 2` pretty-printing) before writing the rendered
template to disk. Keep both tokens exactly as written above (they are
matched by literal string search, not regex) and make sure each appears in a
YAML context where its replacement — a single-line JSON string — stays
valid: `PolicyDocument: __TOKEN__` on its own line, not embedded inside
other YAML structure. A pretty-printed, multi-line JSON string pasted at
that token's column position would NOT be valid YAML there (continuation
lines would land at column 0, breaking the flow scalar) — only single-line
`JSON.stringify(...)` output is safe at this substitution point.

**`HyveonSelfRotate` (from `design.md` Decision 3 and the
`guided-iam-provisioning` spec's "CloudFormation template generated from
the shared action set" requirement — this is a real MUST, not optional,
even though it's easy to miss reading only `tasks.md`'s task 1.2 line):**
a **second**, narrower `AWS::IAM::ManagedPolicy`, scoped to
`arn:aws:iam::*:user/${UserName}` (the same stack parameter naming the
created user), granting exactly `iam:CreateAccessKey`, `iam:DeleteAccessKey`,
`iam:ListAccessKeys`. It is NOT part of `HYVEON_DEPLOY_ALL_ACTIONS` or
`HYVEON_DEPLOY_ALL_STATEMENTS` — build it as its own small generator
function (or inline structure) separate from the four-statement one, since
it has nothing to do with the deploy policy's source of truth.

**Template resources required** (CloudFormation, `iam-bootstrap.yaml`):
- `AWS::IAM::ManagedPolicy` × 2 (`HyveonDeployAll` document via the
  `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` placeholder; `HyveonSelfRotate`
  document via the `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` placeholder).
- `AWS::IAM::User`, name from a `UserName` stack parameter, `Default: hyveon`.
- `AWS::IAM::AccessKey` for that user, with `DeletionPolicy: Retain` (so a
  later `DeleteStack` — after the app has already revoked this key — still
  succeeds).
- `Outputs`: user name, `HyveonDeployAll` policy ARN, `AccessKeyId`,
  `SecretAccessKey` (via `!GetAtt`).

**Packaging pattern to follow** (existing precedent — read before writing
task 1.5): `electron-builder.yml`'s `extraResources:` list already ships
`build/icon.png` this exact way (`from: build/icon.png` / `to: icon.png`),
and `app/packages/desktop-main/src/electron-entry.ts`'s `resolveWindowIcon()`
function is the existing two-candidate (packaged `process.resourcesPath`
vs. dev-run repo-relative path via `existsSync`) resolution pattern for a
packaged extra resource. Task 1.5 wants the CFN template resource added to
`extraResources:` the same way, plus an equivalent small resolver function
(new file under `app/packages/desktop-main/src/`, exact name/location is
your call) that a later group's `GuidedIamService` will call to locate
`iam-bootstrap.yaml` at runtime — write it and a unit test for both the
packaged and dev-fallback branches, but do not build `GuidedIamService`
itself.

**Never** invent DynamoDB actions, never widen `HyveonDeploy`'s
`Resource: "*"` scope beyond what's shown above, never narrow it either —
this group reproduces the current policy exactly, action-for-action.

## Task 1: 1.1 Structured four-statement policy generator

Add a generator in `app/packages/shared/src/iamPolicy.ts` that builds the
four-statement managed-policy document (`{ Version: '2012-10-17', Statement: [...] }`)
from a new `HYVEON_DEPLOY_ALL_STATEMENTS` constant (see Global Constraints
above for the exact structure and the drift-guard relationship with the
existing `HYVEON_DEPLOY_ALL_ACTIONS`). The generator must accept a project
name (default `'hyveon'`) and produce the two bucket-scoped statements'
`Resource` ARNs as `arn:aws:s3:::<projectName>-tfvars(/*)` and
`arn:aws:s3:::<projectName>-tfstate(/*)` respectively. Export both the
constant and the generator function. TSDoc on both, per this repo's
convention (see the existing `HYVEON_DEPLOY_ALL_ACTIONS` doc comment in the
same file for the house style).

## Task 2: 1.2 Author `iam-bootstrap.yaml`

Author `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`
with the resources and placeholder tokens described in Global Constraints:
two `AWS::IAM::ManagedPolicy` resources (policy documents as placeholder
tokens, not inline JSON), one `AWS::IAM::User` (name from a `UserName`
parameter defaulting to `hyveon`), one `AWS::IAM::AccessKey` with
`DeletionPolicy: Retain`. Give the template a `Description:` and an
`AWSTemplateFormatVersion: '2010-09-09'` header, matching standard
CloudFormation template conventions.

## Task 3: 1.3 Stack outputs

Add an `Outputs:` section to `iam-bootstrap.yaml`: the created user's name,
the `HyveonDeployAll` managed policy's ARN, the access key's `AccessKeyId`,
and its `SecretAccessKey` (via `!GetAtt <AccessKeyLogicalId>.SecretAccessKey`).

## Task 4: 1.4 Generator test — matches the doc exactly

Extend `app/packages/shared/src/iamPolicy.test.ts` (or add a sibling test
file) asserting Task 1's generator output's four statements match
`docs/docs/setup.md`'s policy JSON exactly, Sid-for-Sid and
action-for-action (reuse or adapt the existing `extractDocActions()`-style
parsing helper already in that test file, extended to also extract
per-statement `{ Sid, Action[] }` instead of only the flattened set). Also
add the drift-guard test described in Global Constraints
(`HYVEON_DEPLOY_ALL_STATEMENTS` flattened-deduped ⊆ `HYVEON_DEPLOY_ALL_ACTIONS`,
as a set equality). Confirm the existing `HYVEON_DEPLOY_ALL_ACTIONS` test
still passes unmodified.

## Task 5: 1.5 Package the template + runtime resolver

Add the template to `electron-builder.yml`'s `extraResources:` list,
following the existing `build/icon.png` entry's exact shape (see Global
Constraints). Add a small resolver function under
`app/packages/desktop-main/src/` that locates `iam-bootstrap.yaml` at
runtime, following `electron-entry.ts`'s `resolveWindowIcon()` pattern
(packaged: `process.resourcesPath`-relative; dev: repo-relative via
`existsSync`, returning `undefined` if neither exists — do not throw).
Unit-test both branches (mock `process.resourcesPath` present vs. absent,
per the codebase's `no raw process.env`-style env/global mocking
convention — use `vi.spyOn`/dependency seams, not real filesystem
packaging).
