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
  'scheduler:*',
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

/**
 * One statement of the `HyveonDeployAll` managed policy, structured the way
 * CloudFormation (and `JSON.stringify`) expects a policy statement to look.
 * `Resource` is either a literal ARN list (statements whose scope never
 * varies) or a function of the project name (the two bucket-scoped
 * statements, whose ARNs embed the `${project_name}` prefix).
 */
interface HyveonDeployAllStatement {
  /** Statement ID, matching `docs/docs/setup.md` verbatim. */
  readonly Sid: string;
  readonly Effect: 'Allow';
  /** Action or actions this statement grants. */
  readonly Action: string | readonly string[];
  /**
   * Resource ARN(s) this statement applies to. A literal array for
   * project-name-independent statements, or a function from project name to
   * ARN array for the two bucket-scoped statements.
   */
  readonly Resource: string | readonly string[] | ((projectName: string) => readonly string[]);
}

/**
 * The four statements of the `HyveonDeployAll` managed policy, structured
 * per-statement (Sid, Effect, Action, Resource) rather than flattened. The
 * canonical human-readable reference is the JSON block in
 * `docs/docs/setup.md`; `iamPolicy.test.ts` asserts this constant stays in
 * sync with it, both statement-for-statement and — via
 * {@link HYVEON_DEPLOY_ALL_ACTIONS} — as a flattened, deduplicated action set
 * (drift guard between the two representations, since
 * `HYVEON_DEPLOY_ALL_ACTIONS` cannot be reverse-engineered back into these
 * four statements: `HyveonStateBucket`'s actions are a subset of actions
 * that already appear, with a different `Resource`, under
 * `HyveonConfigurationBucket`, and dedup erases which statement they came
 * from). Used by {@link generateHyveonDeployAllPolicy} to build the
 * CloudFormation-ready policy document for the guided IAM bootstrap flow.
 */
export const HYVEON_DEPLOY_ALL_STATEMENTS: readonly HyveonDeployAllStatement[] = [
  {
    Sid: 'HyveonDeploy',
    Effect: 'Allow',
    Action: [
      'ecs:*',
      'elasticfilesystem:*',
      'ec2:*',
      'lambda:*',
      'logs:*',
      'cloudwatch:*',
      'events:*',
      'scheduler:*',
      'route53:*',
      'ce:*',
      'dynamodb:*',
      'secretsmanager:*',
      's3:*',
      'cloudfront:*',
      'acm:*',
    ],
    Resource: '*',
  },
  {
    Sid: 'HyveonIAM',
    Effect: 'Allow',
    Action: 'iam:*',
    Resource: ['arn:aws:iam::*:role/hyveon-*', 'arn:aws:iam::*:policy/hyveon-*'],
  },
  {
    Sid: 'HyveonConfigurationBucket',
    Effect: 'Allow',
    Action: [
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
    ],
    Resource: (projectName: string) => [
      `arn:aws:s3:::${projectName}-tfvars`,
      `arn:aws:s3:::${projectName}-tfvars/*`,
    ],
  },
  {
    Sid: 'HyveonStateBucket',
    Effect: 'Allow',
    Action: [
      's3:ListBucket',
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:PutBucketVersioning',
      's3:PutEncryptionConfiguration',
      's3:PutBucketPublicAccessBlock',
    ],
    Resource: (projectName: string) => [
      `arn:aws:s3:::${projectName}-tfstate`,
      `arn:aws:s3:::${projectName}-tfstate/*`,
    ],
  },
];

/**
 * A single statement in a rendered IAM/CloudFormation policy document —
 * {@link HyveonDeployAllStatement} with its `Resource` resolved to a literal
 * string or string array (never a function).
 */
interface RenderedPolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Action: string | readonly string[];
  readonly Resource: string | readonly string[];
}

/**
 * Builds the full `HyveonDeployAll` managed-policy document — the same
 * four-statement policy as the JSON block in `docs/docs/setup.md` — from
 * {@link HYVEON_DEPLOY_ALL_STATEMENTS}, substituting `projectName` into the
 * two bucket-scoped statements' `Resource` ARNs
 * (`arn:aws:s3:::<projectName>-tfvars(/*)` and
 * `arn:aws:s3:::<projectName>-tfstate(/*)`). Used by the guided IAM
 * bootstrap flow to render the `HyveonDeployAll` `AWS::IAM::ManagedPolicy`
 * document for `iam-bootstrap.yaml`.
 *
 * @param projectName - Project/bucket-name prefix. Defaults to `'hyveon'`,
 *   the default used elsewhere in the wizard (`hyveon-tfstate`, `hyveon-tfvars`).
 */
export function generateHyveonDeployAllPolicy(
  projectName = 'hyveon',
): { Version: '2012-10-17'; Statement: RenderedPolicyStatement[] } {
  return {
    Version: '2012-10-17',
    Statement: HYVEON_DEPLOY_ALL_STATEMENTS.map((statement) => ({
      Sid: statement.Sid,
      Effect: statement.Effect,
      Action: statement.Action,
      Resource: typeof statement.Resource === 'function' ? statement.Resource(projectName) : statement.Resource,
    })),
  };
}

/**
 * A CloudFormation `Fn::Sub` intrinsic-function object, as it appears when a
 * policy document built by this module is `JSON.stringify`'d for embedding
 * in an `AWS::IAM::ManagedPolicy`'s `PolicyDocument` property. CloudFormation
 * resolves `Fn::Sub` wherever it appears in a resource property, including
 * inside a JSON-stringified policy document — this is a documented pattern,
 * not a template-shell-only trick.
 */
interface FnSub {
  readonly 'Fn::Sub': string;
}

/**
 * Builds the `HyveonSelfRotate` managed-policy document: a narrow policy,
 * separate from {@link generateHyveonDeployAllPolicy}'s four statements
 * (it is not part of {@link HYVEON_DEPLOY_ALL_ACTIONS} or
 * {@link HYVEON_DEPLOY_ALL_STATEMENTS}, since it has nothing to do with the
 * deploy policy's source of truth), that lets the Hyveon deploy user rotate
 * its own access key without a standing `iam:*`-on-all-users grant.
 *
 * `Resource` scopes to the created user's own ARN via the CloudFormation
 * `Fn::Sub` intrinsic (`{ "Fn::Sub": "arn:aws:iam::*:user/${UserName}" }`)
 * rather than a literal ARN, because the actual user name is only known at
 * CloudFormation deploy time — it comes from the `UserName` stack parameter
 * in `iam-bootstrap.yaml` (default `hyveon`, operator-overridable). Used by
 * the guided IAM bootstrap flow to render the `HyveonSelfRotate`
 * `AWS::IAM::ManagedPolicy` document for `iam-bootstrap.yaml`.
 */
export function generateHyveonSelfRotatePolicy(): {
  Version: '2012-10-17';
  Statement: [{ Sid: string; Effect: 'Allow'; Action: readonly string[]; Resource: FnSub }];
} {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'HyveonSelfRotate',
        Effect: 'Allow',
        Action: ['iam:CreateAccessKey', 'iam:DeleteAccessKey', 'iam:ListAccessKeys'],
        Resource: { 'Fn::Sub': 'arn:aws:iam::*:user/${UserName}' },
      },
    ],
  };
}
