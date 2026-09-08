/**
 * Shared CloudWatch log-group helpers. Every log group this program declares
 * (six Lambda functions in `lambdas.ts`, one per-game ECS log group in
 * `ecs.ts`) uses the same seven-day retention — {@link LOG_RETENTION_DAYS} is
 * the single place that value is written.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

/** Retention every CloudWatch log group in this program declares. */
export const LOG_RETENTION_DAYS = 7;

/**
 * Declares one `/aws/lambda/${projectName}-${suffix}` log group with
 * {@link LOG_RETENTION_DAYS} retention — the shape every Lambda function's
 * log group in `lambdas.ts` shares. The logical name (`${projectName}-${suffix}-logs`)
 * must stay byte-identical to what each call site passed before this helper
 * existed — changing it forces Pulumi to replace the live log group.
 *
 * @param projectName - The project name prefix (see `DefineLambdasArgs.projectName`).
 * @param suffix - The function-specific suffix (e.g. `'followup'`, `'efs-seeder-${game}'`).
 * @param opts - The regional provider options every resource in this program is declared against.
 * @param extraTags - Additional tags merged in after `Name` (e.g. `{ Game: game }` for per-game functions).
 * @returns The declared log group.
 */
export function lambdaLogGroup(
  projectName: string,
  suffix: string,
  opts: pulumi.CustomResourceOptions,
  extraTags?: Record<string, pulumi.Input<string>>,
): aws.cloudwatch.LogGroup {
  const name = `${projectName}-${suffix}-logs`;
  return new aws.cloudwatch.LogGroup(
    name,
    {
      name: `/aws/lambda/${projectName}-${suffix}`,
      retentionInDays: LOG_RETENTION_DAYS,
      tags: { Name: name, ...extraTags },
    },
    opts,
  );
}
