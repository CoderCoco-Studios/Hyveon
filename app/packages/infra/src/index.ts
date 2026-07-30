/**
 * Public entry point for the `@hyveon/infra` Pulumi program (replaces the
 * Task-2.1 `export {}` placeholder). Re-exports the program factory and the
 * per-resource-area module APIs so `desktop-main` (wired in a later phase —
 * see `program.ts`'s file doc) has a single import surface.
 */

export { createInfraProgram } from './program.js';
export type { InfraProgramOptions } from './program.js';
export type { NetworkResources, DefineNetworkArgs } from './network.js';
export { defineNetwork, cidrSubnet } from './network.js';
export type { SecurityGroupResources, DefineSecurityGroupsArgs, GamePort } from './securityGroups.js';
export { defineSecurityGroups, dedupedDirectGamePorts, hasHttpsGame } from './securityGroups.js';
export type { IamResources, IamRoleResources, IamPolicyResources, DefineIamRolesArgs, DefineIamPoliciesArgs } from './iam.js';
export { defineIamRoles, defineIamPolicies, gamesWithFileSeeds } from './iam.js';
export type { EfsResources, DefineEfsArgs } from './efs.js';
export { defineEfs } from './efs.js';
export type { EcsResources, DefineEcsArgs } from './ecs.js';
export { defineEcs } from './ecs.js';
export type { LambdaResources, DefineLambdasArgs } from './lambdas.js';
export { defineLambdas, bundlePath } from './lambdas.js';
export type { DynamoDbResources, DefineDynamoDbArgs } from './dynamodb.js';
export { defineDynamoDb } from './dynamodb.js';
export type { SecretsResources, DefineSecretsArgs } from './secrets.js';
export { defineSecrets, secretVersionResourceOptions } from './secrets.js';
export type { Route53Resources, DefineRoute53Args } from './route53.js';
export { defineRoute53 } from './route53.js';
export type { DiscordTableItemResources, DefineDiscordTableItemsArgs, DefineEfsSeederInvocationsArgs } from './escapes.js';
export {
  defineDiscordTableItems,
  defineEfsSeederInvocations,
  discordConfigSeedItemResourceOptions,
  efsSeederInvocationResourceOptions,
} from './escapes.js';
