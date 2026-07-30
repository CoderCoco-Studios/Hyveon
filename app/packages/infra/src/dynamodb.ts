/**
 * DynamoDB tables — ported from `terraform/aws/audit_store.tf`'s
 * `aws_dynamodb_table.audit`, `terraform/aws/runs_store.tf`'s
 * `aws_dynamodb_table.runs`, and `terraform/aws/discord_store.tf`'s
 * `aws_dynamodb_table.discord` (task 3.8 of `migrate-iac-to-pulumi`).
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_dynamodb_table.discord` | {@link DynamoDbResources.discordTable} |
 * | `aws_dynamodb_table.runs` | {@link DynamoDbResources.runsTable} |
 * | `aws_dynamodb_table.audit` | {@link DynamoDbResources.auditTable} |
 *
 * The Discord table's two seed rows (`aws_dynamodb_table_item.discord_base_config`/
 * `discord_config_seed`) are NOT declared here — they live in `escapes.ts`
 * (task 3.10), which takes {@link DynamoDbResources.discordTable} as an input
 * rather than constructing its own table. See that file's doc for the full
 * "imperative escapes" inventory and why table rows are ported separately
 * from the table itself.
 *
 * `discordApplicationId`/`baseAllowedGuilds`/`baseAdminUserIds`/`baseAdminRoleIds`
 * (all consumed by `escapes.ts`, not this file) never touch table
 * *definitions* — only table *content* — which is exactly why they're absent
 * from {@link DefineDynamoDbArgs}.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** Every resource {@link defineDynamoDb} declares, keyed by role — see this file's doc for the full HCL→Pulumi address table. */
export interface DynamoDbResources {
  /**
   * Discord serverless backing store (`aws_dynamodb_table.discord`) — holds
   * the `CONFIG#discord`/`BASE#discord` config rows and `PENDING#{taskArn}`
   * pending-interaction rows (TTL-expired via {@link DynamoDbResources.discordTable}'s
   * own `ttl` block). Name is always `${projectName}-discord`, matching the
   * HCL exactly — unlike {@link runsTable}/{@link auditTable}, the HCL never
   * gave this table a name-override variable.
   */
  discordTable: aws.dynamodb.Table;
  /**
   * Terraform/Pulumi run-history table (`aws_dynamodb_table.runs`) — one row
   * per apply/preview run, plus the `status-index` GSI
   * (`status` hash key, `startedAt` range key) so callers can query runs by
   * status ordered by start time without scanning.
   */
  runsTable: aws.dynamodb.Table;
  /** Audit-log table (`aws_dynamodb_table.audit`) — one row per config mutation made through the management app. */
  auditTable: aws.dynamodb.Table;
}

/** Arguments {@link defineDynamoDb} needs to declare every DynamoDB table. */
export interface DefineDynamoDbArgs {
  /** Mirrors `var.project_name` — every table's default name below is `${projectName}-...`, matching the HCL exactly. */
  projectName: string;
  /**
   * Mirrors `DeploymentConfig.auditTableName` (`var.audit_table_name`) — an
   * empty string resolves to `${projectName}-audit`, replicating the HCL's
   * `var.audit_table_name != "" ? var.audit_table_name : "${var.project_name}-audit"`
   * ternary. `deploymentConfig.ts`'s doc on `auditTableName` explicitly
   * leaves this resolution to "the infrastructure program (Phase 3)" — this
   * is that resolution.
   */
  auditTableName: string;
  /** Mirrors `DeploymentConfig.runsTableName` (`var.runs_table_name`) — same empty-string-resolves-to-default contract as {@link auditTableName}, against `${projectName}-runs`. */
  runsTableName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Resolves a possibly-overridden table name against the HCL's own
 * `var.x != "" ? var.x : "${var.project_name}-<suffix>"` ternary.
 *
 * @param overrideName - The configured override (`""` when unset).
 * @param projectName - The project name the computed default is built from.
 * @param suffix - The table's role suffix (`"audit"`/`"runs"`).
 * @returns The resolved table name.
 */
function resolveTableName(overrideName: string, projectName: string, suffix: string): string {
  return overrideName !== '' ? overrideName : `${projectName}-${suffix}`;
}

/**
 * Declares the three DynamoDB tables (task 3.8 of `migrate-iac-to-pulumi`) —
 * see this file's doc for the full HCL→Pulumi address table. Must be called
 * from inside the Pulumi inline-program closure, never at module scope.
 *
 * Every table's Pulumi *logical* name is fixed to `${projectName}-<role>`,
 * deliberately NOT derived from the resolved (possibly operator-overridden)
 * `name:` input: Terraform addresses `aws_dynamodb_table.runs`/`.audit` by a
 * fixed resource address regardless of `var.runs_table_name`/
 * `var.audit_table_name`, and tying this program's logical name to the same
 * operator-editable value would mean an unrelated table-name edit also
 * changes the resource's Pulumi identity (its URN) — the resolved value is
 * used only for the `name:` input property itself, matching the HCL's own
 * separation between resource address and resource attribute.
 *
 * @param args - Naming, config, and provider inputs — see {@link DefineDynamoDbArgs}.
 * @returns The declared tables — see {@link DynamoDbResources}.
 */
export function defineDynamoDb(args: DefineDynamoDbArgs): DynamoDbResources {
  const { projectName, auditTableName, runsTableName, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── Discord table (discord_store.tf) ──────────────────────────────────────
  const discordTable = new aws.dynamodb.Table(
    `${projectName}-discord`,
    {
      name: `${projectName}-discord`,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'pk',
      rangeKey: 'sk',
      attributes: [
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
      ],
      ttl: { attributeName: 'expiresAt', enabled: true },
      pointInTimeRecovery: { enabled: false },
      tags: { Name: `${projectName}-discord` },
    },
    opts,
  );

  // ── Runs table (runs_store.tf) ─────────────────────────────────────────────
  const resolvedRunsTableName = resolveTableName(runsTableName, projectName, 'runs');
  const runsTable = new aws.dynamodb.Table(
    `${projectName}-runs`,
    {
      name: resolvedRunsTableName,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'pk',
      rangeKey: 'sk',
      attributes: [
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
        { name: 'status', type: 'S' },
        { name: 'startedAt', type: 'S' },
      ],
      // `hashKey`/`rangeKey` on a GSI are deprecated in this provider version
      // in favor of `keySchemas` (multi-attribute keys) — deliberately used
      // anyway, matching the HCL's own single-attribute `hash_key`/`range_key`
      // GSI block exactly rather than introducing a `keySchemas` shape with
      // no HCL counterpart to verify against.
      globalSecondaryIndexes: [{ name: 'status-index', hashKey: 'status', rangeKey: 'startedAt', projectionType: 'ALL' }],
      pointInTimeRecovery: { enabled: true },
      tags: { Name: resolvedRunsTableName },
    },
    opts,
  );

  // ── Audit table (audit_store.tf) ───────────────────────────────────────────
  const resolvedAuditTableName = resolveTableName(auditTableName, projectName, 'audit');
  const auditTable = new aws.dynamodb.Table(
    `${projectName}-audit`,
    {
      name: resolvedAuditTableName,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'pk',
      rangeKey: 'sk',
      attributes: [
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
      ],
      pointInTimeRecovery: { enabled: true },
      tags: { Name: resolvedAuditTableName },
    },
    opts,
  );

  return { discordTable, runsTable, auditTable };
}
