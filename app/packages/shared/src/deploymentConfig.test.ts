import { describe, it, expect } from 'vitest';
import {
  DEPLOYMENT_CONFIG_DEFAULTS,
  withDeploymentConfigDefaults,
  type DeploymentConfig,
} from './deploymentConfig.js';
import type { GameServerConfig } from './tfvars.js';

/**
 * A fully-populated `https = true` game server entry — every optional field
 * set (`environment`, `connect_message`, `file_seeds` with both `content`
 * and `content_base64` variants) — used to exercise the `https: true` arm of
 * the round-trip test required by task 2.3 (the flag HCL round-tripping
 * previously corrupted).
 */
function buildHttpsGameServer(): GameServerConfig {
  return {
    image: 'itzg/minecraft-server:latest',
    cpu: 2048,
    memory: 4096,
    ports: [{ container: 25565, protocol: 'tcp' }],
    environment: [
      { name: 'EULA', value: 'TRUE' },
      { name: 'DIFFICULTY', value: 'normal' },
    ],
    volumes: [{ name: 'saves', container_path: '/data' }],
    https: true,
    connect_message: 'connect at {host}:{port}',
    file_seeds: [
      { path: '/data/server.properties', content: 'motd=Hyveon', mode: '0644' },
      { path: '/data/mods/example.jar', content_base64: 'AQIDBA==' },
    ],
  };
}

/**
 * A minimal `https = false` game server entry — only the required fields set
 * (no `environment`, `connect_message`, or `file_seeds`) — used to exercise
 * the `https: false` arm of the round-trip test, and to prove optional
 * fields are genuinely optional rather than silently required.
 */
function buildPlainGameServer(): GameServerConfig {
  return {
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 4096,
    memory: 8192,
    ports: [
      { container: 8211, protocol: 'udp' },
      { container: 27015, protocol: 'udp' },
    ],
    volumes: [{ name: 'saves', container_path: '/palworld' }],
    https: false,
  };
}

/**
 * A {@link DeploymentConfig} fixture with every field populated — the
 * compile-time exhaustiveness check (via `satisfies`) plus the runtime fixture
 * for the round-trip test. Includes both an `https: true` and an
 * `https: false` game server entry so the round-trip test exercises both
 * arms of the flag in one deeply-equal assertion.
 */
const FULL_CONFIG = {
  projectName: 'hyveon-prod',
  awsRegion: 'eu-west-1',
  vpcCidr: '10.20.0.0/16',
  hostedZoneName: 'example.com',
  dnsTtl: 45,
  watchdogIntervalMinutes: 10,
  watchdogIdleChecks: 6,
  watchdogMinPackets: 250,
  baseAllowedGuilds: ['111111111111111111'],
  baseAdminUserIds: ['222222222222222222'],
  baseAdminRoleIds: ['333333333333333333'],
  discordApplicationId: '444444444444444444',
  auditTableName: 'hyveon-prod-audit',
  runsTableName: 'hyveon-prod-runs',
  gameServers: {
    minecraft: buildHttpsGameServer(),
    palworld: buildPlainGameServer(),
  },
} satisfies DeploymentConfig;

describe('DeploymentConfig', () => {
  it('should survive a JSON write-then-read deeply equal, including boolean and numeric fields', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;

    expect(roundTripped).toStrictEqual(FULL_CONFIG);
  });

  it('should preserve https: true through a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;

    expect(roundTripped.gameServers['minecraft']!.https).toBe(true);
  });

  it('should preserve https: false through a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;

    expect(roundTripped.gameServers['palworld']!.https).toBe(false);
  });

  it('should preserve every top-level numeric field through a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;

    expect(roundTripped.dnsTtl).toBe(45);
    expect(roundTripped.watchdogIntervalMinutes).toBe(10);
    expect(roundTripped.watchdogIdleChecks).toBe(6);
    expect(roundTripped.watchdogMinPackets).toBe(250);
  });

  it('should preserve array fields (base allowlist/admin IDs) through a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;

    expect(roundTripped.baseAllowedGuilds).toEqual(['111111111111111111']);
    expect(roundTripped.baseAdminUserIds).toEqual(['222222222222222222']);
    expect(roundTripped.baseAdminRoleIds).toEqual(['333333333333333333']);
  });

  it('should preserve gameServers file_seeds content and content_base64 variants through a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_CONFIG)) as DeploymentConfig;
    const seeds = roundTripped.gameServers['minecraft']!.file_seeds!;

    expect(seeds[0]).toEqual({ path: '/data/server.properties', content: 'motd=Hyveon', mode: '0644' });
    expect(seeds[1]).toEqual({ path: '/data/mods/example.jar', content_base64: 'AQIDBA==' });
  });

  it('should treat an empty gameServers map as a valid (round-trippable) configuration', () => {
    const config: DeploymentConfig = { ...FULL_CONFIG, gameServers: {} };
    const roundTripped = JSON.parse(JSON.stringify(config)) as DeploymentConfig;

    expect(roundTripped.gameServers).toEqual({});
  });
});

describe('DEPLOYMENT_CONFIG_DEFAULTS', () => {
  it('should match the Terraform variable defaults verbatim', () => {
    expect(DEPLOYMENT_CONFIG_DEFAULTS).toEqual({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      vpcCidr: '10.0.0.0/16',
      dnsTtl: 30,
      watchdogIntervalMinutes: 15,
      watchdogIdleChecks: 4,
      watchdogMinPackets: 100,
      discordApplicationId: '',
      auditTableName: '',
      runsTableName: '',
    });
  });
});

describe('withDeploymentConfigDefaults', () => {
  it('should fill in every defaulted field when only the required fields are supplied', () => {
    const result = withDeploymentConfigDefaults({
      hostedZoneName: 'example.com',
      gameServers: {},
    });

    expect(result).toEqual({
      ...DEPLOYMENT_CONFIG_DEFAULTS,
      hostedZoneName: 'example.com',
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      gameServers: {},
    });
  });

  it('should pass through every explicitly-supplied field instead of defaulting it', () => {
    const result = withDeploymentConfigDefaults({
      hostedZoneName: 'example.com',
      gameServers: { minecraft: buildPlainGameServer() },
      projectName: 'custom-project',
      awsRegion: 'ap-southeast-2',
      vpcCidr: '172.16.0.0/16',
      dnsTtl: 60,
      watchdogIntervalMinutes: 5,
      watchdogIdleChecks: 2,
      watchdogMinPackets: 50,
      baseAllowedGuilds: ['999'],
      baseAdminUserIds: ['888'],
      baseAdminRoleIds: ['777'],
      discordApplicationId: '666',
      auditTableName: 'custom-audit',
      runsTableName: 'custom-runs',
    });

    expect(result).toEqual({
      hostedZoneName: 'example.com',
      gameServers: { minecraft: buildPlainGameServer() },
      projectName: 'custom-project',
      awsRegion: 'ap-southeast-2',
      vpcCidr: '172.16.0.0/16',
      dnsTtl: 60,
      watchdogIntervalMinutes: 5,
      watchdogIdleChecks: 2,
      watchdogMinPackets: 50,
      baseAllowedGuilds: ['999'],
      baseAdminUserIds: ['888'],
      baseAdminRoleIds: ['777'],
      discordApplicationId: '666',
      auditTableName: 'custom-audit',
      runsTableName: 'custom-runs',
    });
  });

  it('should return a fresh base-list array instance on every call rather than a shared reference', () => {
    const first = withDeploymentConfigDefaults({ hostedZoneName: 'a.com', gameServers: {} });
    const second = withDeploymentConfigDefaults({ hostedZoneName: 'b.com', gameServers: {} });

    expect(first.baseAllowedGuilds).not.toBe(second.baseAllowedGuilds);
    first.baseAllowedGuilds.push('mutated');
    expect(second.baseAllowedGuilds).toEqual([]);
  });

  it('should leave auditTableName and runsTableName as empty strings rather than computing "${projectName}-audit"/"-runs"', () => {
    const result = withDeploymentConfigDefaults({ hostedZoneName: 'example.com', gameServers: {} });

    expect(result.auditTableName).toBe('');
    expect(result.runsTableName).toBe('');
  });
});
