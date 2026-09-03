/**
 * DynamoDB tables — ported from the legacy infrastructure-as-code tool's
 * audit-store and Discord-store resource areas.
 *
 * | Table | This file |
 * | --- | --- |
 * | Discord backing store | {@link DynamoDbResources.discordTable} |
 * | Audit log | {@link DynamoDbResources.auditTable} |
 *
 * The runs table (the legacy tool's runs-store resource area) is
 * deliberately NOT ported here: `RunRecordService`'s approve/apply gates require this
 * table to exist on the very FIRST plan/apply cycle of a fresh install,
 * before any Pulumi apply has ever succeeded — a table this program
 * provisions can't be relied on that early (see
 * `PulumiService.getStackOutputs`'s "empty outputs degrades to null" doc).
 * It is instead created via the AWS SDK directly at
 * first-run-wizard bootstrap time (`BootstrapService.ensureRunsTable`,
 * `@hyveon/desktop-main`), mirroring how CLAUDE.md's own invariants already
 * treat DNS records as "Lambda-managed, never infra-program-managed" for the
 * same reason — a resource whose lifecycle genuinely can't wait on this
 * program's own apply. Its schema below is preserved as documentation of
 * what `ensureRunsTable` must match exactly; this file declares no resource
 * for it. `program.ts`'s `runsTableName` stack output is computed directly
 * from `DeploymentConfig` (via `@hyveon/shared`'s `resolveRunsTableName`)
 * rather than read off a resource here.
 *
 * Confirmed safe to remove from Pulumi management: the runs table has
 * exactly one consumer anywhere in this package — its resolved `.name`,
 * previously fed into the `runsTableName` stack output — no IAM policy or
 * other resource ever referenced its ARN (contrast `discordTable.arn`, which
 * `iam.ts` grants to three Lambda roles).
 *
 * The Discord table's two seed rows (the base-config item and the config
 * seed item) are NOT declared here — they live in `escapes.ts`,
 * which takes {@link DynamoDbResources.discordTable} as an input rather than
 * constructing its own table. See that file's doc for the full "imperative
 * escapes" inventory.
 *
 * `discordApplicationId`/`baseAllowedGuilds`/`baseAdminUserIds`/`baseAdminRoleIds`
 * (all consumed by `escapes.ts`, not this file) never touch table
 * *definitions* — only table *content* — which is exactly why they're absent
 * from {@link DefineDynamoDbArgs}.
 *
 * ## Runs table schema (for `BootstrapService.ensureRunsTable` parity only)
 *
 * `billingMode: 'PAY_PER_REQUEST'`, hash key `pk` (S) + range key `sk` (S),
 * one GSI `status-index` (hash `status` S, range `startedAt` S, projection
 * `ALL`), point-in-time recovery enabled, tag `Name: <resolved table name>`
 * plus `Project: hyveon` (this program's `defaultTags` provider setting
 * applies `Project: hyveon` to every Pulumi-managed resource automatically —
 * an SDK-created table outside Pulumi needs that tag applied explicitly to
 * stay tagged identically).
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** Every resource {@link defineDynamoDb} declares, keyed by role — see this file's doc for the table map. */
export interface DynamoDbResources {
  /**
   * Discord serverless backing store — holds
   * the `CONFIG#discord`/`BASE#discord` config rows and `PENDING#{taskArn}`
   * pending-interaction rows (TTL-expired via {@link DynamoDbResources.discordTable}'s
   * own `ttl` block). Name is always `${projectName}-discord` — unlike
   * {@link auditTable} (or the retired runs table), this table never had a
   * name-override option.
   */
  discordTable: aws.dynamodb.Table;
  /** Audit-log table — one row per config mutation made through the management app. */
  auditTable: aws.dynamodb.Table;
}

/** Arguments {@link defineDynamoDb} needs to declare every DynamoDB table. */
export interface DefineDynamoDbArgs {
  /** Every table's default name below is `${projectName}-...`. */
  projectName: string;
  /**
   * Mirrors `DeploymentConfig.auditTableName` — an
   * empty string resolves to `${projectName}-audit`, via the
   * `auditTableName !== '' ? auditTableName : "${projectName}-audit"`
   * ternary. This function is where that resolution happens.
   */
  auditTableName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Resolves a possibly-overridden table name against the legacy tool's own
 * `x != "" ? x : "${projectName}-<suffix>"` ternary.
 *
 * Used for the audit table only — the runs table's identical-shaped
 * resolution now lives in `@hyveon/shared`'s `resolveRunsTableName`, since
 * `BootstrapService.ensureRunsTable` (`@hyveon/desktop-main`) must compute
 * that exact value too, outside this package (see this file's doc, "why
 * the runs table is deliberately not ported here").
 *
 * @param overrideName - The configured override (`""` when unset).
 * @param projectName - The project name the computed default is built from.
 * @param suffix - The table's role suffix (`"audit"`).
 * @returns The resolved table name.
 */
function resolveTableName(overrideName: string, projectName: string, suffix: string): string {
  return overrideName !== '' ? overrideName : `${projectName}-${suffix}`;
}

/**
 * Declares the two DynamoDB tables this package manages (the runs table is
 * created outside Pulumi — see this file's doc) — see this file's doc for
 * the table map. Must be called from inside the Pulumi
 * inline-program closure, never at module scope.
 *
 * Every table's Pulumi *logical* name is fixed to `${projectName}-<role>`,
 * deliberately NOT derived from the resolved (possibly operator-overridden)
 * `name:` input: the legacy tool addressed the audit table by a fixed
 * resource address regardless of an operator-supplied name override, and tying this
 * program's logical name to the same operator-editable value would mean an
 * unrelated table-name edit also changes the resource's Pulumi identity (its
 * URN) — the resolved value is used only for the `name:` input property
 * itself, matching the HCL's own separation between resource address and
 * resource attribute.
 *
 * @param args - Naming, config, and provider inputs — see {@link DefineDynamoDbArgs}.
 * @returns The declared tables — see {@link DynamoDbResources}.
 */
export function defineDynamoDb(args: DefineDynamoDbArgs): DynamoDbResources {
  const { projectName, auditTableName, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── Discord table ──────────────────────────────────────────────────────────
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

  // ── Audit table ─────────────────────────────────────────────────────────────
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

  return { discordTable, auditTable };
}
