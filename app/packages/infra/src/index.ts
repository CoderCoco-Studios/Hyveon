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
