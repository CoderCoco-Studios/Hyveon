/**
 * `@hyveon/infra` — the Pulumi Automation API program that provisions
 * Hyveon's AWS infrastructure, driven entirely from inside the packaged
 * desktop app. See `docs/docs/components/infra.md` for the full resource
 * inventory and architecture.
 *
 * @packageDocumentation
 */

export { createInfraProgram, buildStackOutputs } from './program.js';
export type { InfraProgramOptions, InfraResources, StackOutputValues } from './program.js';
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
export { defineSecrets, secretResourceOptions } from './secrets.js';
export type { Route53Resources, DefineRoute53Args } from './route53.js';
export { defineRoute53 } from './route53.js';
export type { DiscordTableItemResources, DefineDiscordTableItemsArgs, DefineEfsSeederInvocationsArgs } from './escapes.js';
export { defineDiscordTableItems, defineEfsSeederInvocations, escapeResourceOptions } from './escapes.js';
export type { DiscordDomainResources, DefineDiscordDomainArgs } from './discordDomain.js';
export { defineDiscordDomain } from './discordDomain.js';
