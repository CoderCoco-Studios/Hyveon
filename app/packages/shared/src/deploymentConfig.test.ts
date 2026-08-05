import { describe, it, expect } from 'vitest';
import {
  DEPLOYMENT_CONFIG_DEFAULTS,
  withDeploymentConfigDefaults,
  diffDeploymentConfig,
  type DeploymentConfig,
} from './deploymentConfig.js';
import type { GameServerConfig } from './gameServerConfig.js';

/**
 * A fully-populated `https = true` game server entry — every optional field
 * set (`environment`, `connect_message`, `file_seeds` with both `content`
 * and `content_base64` variants) — used to exercise the `https: true` arm of
 * the round-trip test that guards against the `https` flag failing to
 * survive a JSON round-trip.
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
 * A game server entry with `https` entirely omitted — the third state the
 * field's type (`https?: boolean`) allows alongside explicit `true`/`false`.
 * Per `GameServerConfig`'s (`./gameServerConfig.js`) TSDoc, an absent `https` MUST be
 * read as `false` (Terraform's own `optional(bool, false)` default), never
 * as an unresolved state — this fixture exists to prove that reading holds
 * through a JSON round-trip: the key must come back genuinely absent (not
 * `null`, not coerced to `false`), so a consumer applying the documented
 * "absent means false" rule sees exactly what a hand-edited/legacy tfvars
 * entry without an `https` line would have produced.
 */
function buildGameServerWithoutHttps(): GameServerConfig {
  return {
    image: 'example/game-server:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 12345, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
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

describe('DeploymentConfig gameServers https semantics', () => {
  it('should round-trip an absent https as genuinely absent, not null or coerced to false', () => {
    const config: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { plain: buildGameServerWithoutHttps() },
    };

    const roundTripped = JSON.parse(JSON.stringify(config)) as DeploymentConfig;

    expect('https' in roundTripped.gameServers['plain']!).toBe(false);
    expect(roundTripped.gameServers['plain']!.https).toBeUndefined();
  });

  it('should distinguish an explicit https: false from an absent https at the JSON level', () => {
    const explicitFalse: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { palworld: buildPlainGameServer() },
    };
    const absent: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { palworld: buildGameServerWithoutHttps() },
    };

    const explicitFalseJson = JSON.stringify(explicitFalse);
    const absentJson = JSON.stringify(absent);

    // Explicit false is serialized as a real `"https":false` key/value pair;
    // omitting it drops the key from the JSON entirely (JSON.stringify's
    // standard behavior for `undefined`-valued properties) — the two are
    // not the same wire representation, even though both are read as
    // "TLS off" per the documented "absent ≡ false" convention.
    expect(explicitFalseJson).toContain('"https":false');
    expect(absentJson).not.toContain('"https"');
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

describe('diffDeploymentConfig', () => {
  it('should report no changes for two structurally identical configs', () => {
    const previous = FULL_CONFIG;
    const current: DeploymentConfig = { ...FULL_CONFIG, gameServers: { ...FULL_CONFIG.gameServers } };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff).toEqual({
      changedFields: [],
      gameServers: { added: [], removed: [], changed: [] },
    });
  });

  it('should report every top-level scalar and array field as changed when every one differs', () => {
    const previous = FULL_CONFIG;
    const current: DeploymentConfig = {
      ...FULL_CONFIG,
      projectName: 'other-project',
      awsRegion: 'ap-southeast-2',
      vpcCidr: '172.16.0.0/16',
      hostedZoneName: 'other.example.com',
      dnsTtl: 60,
      watchdogIntervalMinutes: 5,
      watchdogIdleChecks: 2,
      watchdogMinPackets: 50,
      baseAllowedGuilds: ['999999999999999999'],
      baseAdminUserIds: ['888888888888888888'],
      baseAdminRoleIds: ['777777777777777777'],
      discordApplicationId: '555555555555555555',
      auditTableName: 'other-audit',
      runsTableName: 'other-runs',
    };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.changedFields).toEqual([
      'projectName',
      'awsRegion',
      'vpcCidr',
      'hostedZoneName',
      'dnsTtl',
      'watchdogIntervalMinutes',
      'watchdogIdleChecks',
      'watchdogMinPackets',
      'baseAllowedGuilds',
      'baseAdminUserIds',
      'baseAdminRoleIds',
      'discordApplicationId',
      'auditTableName',
      'runsTableName',
    ]);
    expect(diff.gameServers).toEqual({ added: [], removed: [], changed: [] });
  });

  it('should report only the specific scalar fields that differ, leaving the rest out of changedFields', () => {
    const previous = FULL_CONFIG;
    const current: DeploymentConfig = { ...FULL_CONFIG, dnsTtl: 999 };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.changedFields).toEqual(['dnsTtl']);
  });

  it('should classify gameServers keys added, removed, and changed in combination', () => {
    const previous: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: {
        minecraft: buildHttpsGameServer(),
        palworld: buildPlainGameServer(),
      },
    };
    const current: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: {
        // minecraft removed
        palworld: buildGameServerWithoutHttps(), // changed (different shape entirely)
        valheim: buildPlainGameServer(), // added
      },
    };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.gameServers.added).toEqual(['valheim']);
    expect(diff.gameServers.removed).toEqual(['minecraft']);
    expect(diff.gameServers.changed).toEqual(['palworld']);
    expect(diff.changedFields).toEqual([]);
  });

  it('should not report a gameServers key as changed when its value is structurally identical', () => {
    const previous: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { minecraft: buildHttpsGameServer() },
    };
    const current: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { minecraft: buildHttpsGameServer() },
    };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.gameServers).toEqual({ added: [], removed: [], changed: [] });
  });

  it('should treat an empty gameServers map on both sides as no gameServers changes', () => {
    const previous: DeploymentConfig = { ...FULL_CONFIG, gameServers: {} };
    const current: DeploymentConfig = { ...FULL_CONFIG, gameServers: {} };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.gameServers).toEqual({ added: [], removed: [], changed: [] });
  });

  it('should report every gameServers key as added when previous has none', () => {
    const previous: DeploymentConfig = { ...FULL_CONFIG, gameServers: {} };
    const current: DeploymentConfig = {
      ...FULL_CONFIG,
      gameServers: { minecraft: buildHttpsGameServer(), palworld: buildPlainGameServer() },
    };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.gameServers.added.sort()).toEqual(['minecraft', 'palworld']);
    expect(diff.gameServers.removed).toEqual([]);
    expect(diff.gameServers.changed).toEqual([]);
  });

  it('should combine top-level field changes and gameServers changes in a single diff', () => {
    const previous = FULL_CONFIG;
    const current: DeploymentConfig = {
      ...FULL_CONFIG,
      awsRegion: 'ap-southeast-2',
      gameServers: { valheim: buildPlainGameServer() },
    };

    const diff = diffDeploymentConfig(previous, current);

    expect(diff.changedFields).toEqual(['awsRegion']);
    expect(diff.gameServers.added).toEqual(['valheim']);
    expect(diff.gameServers.removed).toEqual(['minecraft', 'palworld']);
    expect(diff.gameServers.changed).toEqual([]);
  });
});
