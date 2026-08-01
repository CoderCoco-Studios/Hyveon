/**
 * Flattened, deduplicated action set from the `HyveonDeployAll` inline
 * IAM policy. The single source of truth for that policy is the JSON block
 * in `docs/docs/setup.md` (see CLAUDE.md "AWS IAM Policy") — `iamPolicy.test.ts`
 * asserts this constant stays in sync with it. Used by the first-run
 * wizard's IAM permission simulation (#208) to know which actions to check
 * via `iam:SimulatePrincipalPolicy`.
 */
export const HYVEON_DEPLOY_ALL_ACTIONS: readonly string[] = [
  'ecs:*',
  'elasticfilesystem:*',
  'ec2:*',
  'lambda:*',
  'logs:*',
  'cloudwatch:*',
  'events:*',
  'route53:*',
  'ce:*',
  'dynamodb:*',
  'secretsmanager:*',
  's3:*',
  'cloudfront:*',
  'acm:*',
  'iam:*',
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  's3:ListBucket',
  's3:GetObjectVersion',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetBucketLocation',
  's3:PutLifecycleConfiguration',
  's3:PutEncryptionConfiguration',
  's3:PutBucketPublicAccessBlock',
];
