/**
 * Shared `DeploymentConfig` test fixtures — representative configurations
 * used across `@hyveon/infra` specs so every dispatch exercises the same
 * dedup/HTTPS shapes rather than each spec inventing its own game map.
 */

import type { DeploymentConfig, GameServerConfig } from '@hyveon/shared';

/**
 * A representative `gameServers` map exercising every case task 3.4's
 * security-group dedup logic must handle:
 *  - `alpha` and `bravo` both declare `25565/tcp` — two different games
 *    sharing a port MUST collapse to a single ingress rule.
 *  - `alpha` omits `https` entirely (the `undefined ≡ false` case); `bravo`
 *    sets it explicitly to `false`. Both must be treated identically.
 *  - `charlie` declares a distinct port (`7777/udp`) that must survive
 *    dedup as its own rule.
 *  - `delta` is the sole `https: true` entry, so it alone should trigger the
 *    443/80 Caddy-sidecar ingress rules; its own port (`8080/tcp`) must NOT
 *    get a direct ingress rule.
 */
export const FIXTURE_GAME_SERVERS: Record<string, GameServerConfig> = {
  alpha: {
    image: 'example/alpha:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  },
  bravo: {
    image: 'example/bravo:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    https: false,
  },
  charlie: {
    image: 'example/charlie:latest',
    cpu: 2048,
    memory: 4096,
    ports: [{ container: 7777, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  },
  delta: {
    image: 'example/delta:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 8080, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    https: true,
  },
};

/**
 * Builds a representative, fully-populated {@link DeploymentConfig} for
 * tests, defaulting to {@link FIXTURE_GAME_SERVERS} and Terraform's own
 * default `projectName`/`awsRegion`/`vpcCidr` values so specs read realistic
 * names/CIDRs without hardcoding them again at each call site.
 *
 * @param overrides - Fields to override on top of the defaults.
 * @returns A complete {@link DeploymentConfig}.
 */
export function buildTestDeploymentConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    projectName: 'hyveon',
    awsRegion: 'us-east-1',
    vpcCidr: '10.0.0.0/16',
    hostedZoneName: 'example.com',
    dnsTtl: 30,
    watchdogIntervalMinutes: 15,
    watchdogIdleChecks: 4,
    watchdogMinPackets: 100,
    baseAllowedGuilds: [],
    baseAdminUserIds: [],
    baseAdminRoleIds: [],
    discordApplicationId: '',
    auditTableName: '',
    runsTableName: '',
    gameServers: FIXTURE_GAME_SERVERS,
    ...overrides,
  };
}
