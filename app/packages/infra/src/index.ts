/**
 * Public entry point for the `@hyveon/infra` Pulumi program (replaces the
 * Task-2.1 `export {}` placeholder). Re-exports the program factory and the
 * per-resource-area module APIs so `desktop-main` (wired in a later phase —
 * see `program.ts`'s file doc) has a single import surface.
 */

export { createInfraProgram } from './program.js';
export type { NetworkResources, DefineNetworkArgs } from './network.js';
export { defineNetwork, cidrSubnet } from './network.js';
export type { SecurityGroupResources, DefineSecurityGroupsArgs, GamePort } from './securityGroups.js';
export { defineSecurityGroups, dedupedDirectGamePorts, hasHttpsGame } from './securityGroups.js';
export type { IamResources, DefineIamArgs, RoleWithPolicy } from './iam.js';
export { defineIam, gamesWithFileSeeds } from './iam.js';
