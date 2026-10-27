import { describe, it, expect } from 'vitest';
import type { DeploymentConfig, GameServer } from '@hyveon/shared';
import { buildDiagnosticsConfigSummary } from './diagnosticsBundleAllowlist.js';

/** Minimal, complete `Omit<DeploymentConfig, 'gameServers'>` fixture for allowlist tests. */
function makeSettings(overrides: Partial<Omit<DeploymentConfig, 'gameServers'>> = {}): Omit<DeploymentConfig, 'gameServers'> {
  return {
    projectName: 'hyveon',
    awsRegion: 'us-east-1',
    vpcCidr: '10.0.0.0/16',
    hostedZoneName: 'example.com',
    dnsTtl: 60,
    watchdogIntervalMinutes: 5,
    watchdogIdleChecks: 3,
    watchdogMinPackets: 10,
    baseAllowedGuilds: ['guild-1'],
    baseAdminUserIds: ['user-1'],
    baseAdminRoleIds: ['role-1'],
    discordApplicationId: 'app-id-123',
    auditTableName: 'hyveon-audit',
    runsTableName: 'hyveon-runs',
    ...overrides,
  };
}

function makeGameServer(overrides: Partial<GameServer> = {}): GameServer {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

describe('buildDiagnosticsConfigSummary', () => {
  it('should include every allowlisted top-level field', () => {
    const summary = buildDiagnosticsConfigSummary(makeSettings(), []);

    expect(summary).toMatchObject({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      vpcCidr: '10.0.0.0/16',
      hostedZoneName: 'example.com',
      dnsTtl: 60,
      watchdogIntervalMinutes: 5,
      watchdogIdleChecks: 3,
      watchdogMinPackets: 10,
      auditTableName: 'hyveon-audit',
      runsTableName: 'hyveon-runs',
    });
  });

  it('should exclude non-allowlisted fields, including Discord identifiers', () => {
    const summary = buildDiagnosticsConfigSummary(makeSettings(), []) as Record<string, unknown>;

    expect(summary['baseAllowedGuilds']).toBeUndefined();
    expect(summary['baseAdminUserIds']).toBeUndefined();
    expect(summary['baseAdminRoleIds']).toBeUndefined();
    expect(summary['discordApplicationId']).toBeUndefined();
  });

  it('should exclude a hypothetical field not on the allowlist, even if present on the input object', () => {
    const settingsWithExtraField = {
      ...makeSettings(),
      futureSecretLookingField: 'sk-super-secret-value',
    } as Omit<DeploymentConfig, 'gameServers'>;

    const summary = buildDiagnosticsConfigSummary(settingsWithExtraField, []) as Record<string, unknown>;

    expect(summary['futureSecretLookingField']).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('sk-super-secret-value');
  });

  it('should reduce each game server to resource-sizing and feature-flag fields only', () => {
    const game = makeGameServer({
      https: true,
      environment: [{ name: 'API_KEY', value: 'super-secret-value' }],
      healthCheck: {
        kind: 'http',
        scheme: 'http',
        port: 25565,
        path: '/health',
        method: 'GET',
        timeoutMs: 5000,
        activeWhen: { jsonPath: '$.status', operator: 'equals', value: 'ok' },
      },
    });

    const summary = buildDiagnosticsConfigSummary(makeSettings(), [game]);

    expect(summary.gameServers).toEqual([
      {
        name: 'minecraft',
        image: 'itzg/minecraft-server:latest',
        cpu: 1024,
        memory: 2048,
        portCount: 1,
        https: true,
        hasWebPort: false,
        volumeCount: 1,
        hasHealthCheck: true,
        hasPinnedHostname: false,
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('super-secret-value');
  });

  it('should report hasPinnedHostname true only when a pinnedHostname is set', () => {
    const summary = buildDiagnosticsConfigSummary(makeSettings(), [
      makeGameServer({ pinnedHostname: 'palworld-host' }),
      makeGameServer({ name: 'valheim' }),
    ]);

    expect(summary.gameServers.map((g) => g.hasPinnedHostname)).toEqual([true, false]);
  });

  it('should never include the pinnedHostname value in the bundle', () => {
    const summary = buildDiagnosticsConfigSummary(makeSettings(), [
      makeGameServer({ pinnedHostname: 'palworld-host' }),
    ]);

    expect(JSON.stringify(summary)).not.toContain('palworld-host');
    expect(Object.keys(summary.gameServers[0] ?? {})).not.toContain('pinnedHostname');
  });

  it('should record webPort presence without including its value', () => {
    const withWebPort = buildDiagnosticsConfigSummary(makeSettings(), [makeGameServer({ https: true, webPort: 30000 })]);
    const without = buildDiagnosticsConfigSummary(makeSettings(), [makeGameServer()]);

    expect(withWebPort.gameServers[0]?.hasWebPort).toBe(true);
    expect(without.gameServers[0]?.hasWebPort).toBe(false);
    expect(JSON.stringify(withWebPort)).not.toContain('30000');
  });

  it('should treat an omitted https as false', () => {
    const summary = buildDiagnosticsConfigSummary(makeSettings(), [makeGameServer()]);

    expect(summary.gameServers[0]?.https).toBe(false);
  });
});
