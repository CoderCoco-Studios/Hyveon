import type { DeploymentConfig, GameServer } from '@hyveon/shared';

/**
 * Per-game diagnostic summary — resource sizing and feature-flag booleans
 * only. Deliberately excludes {@link GameServer.environment} (may carry
 * operator-supplied secret-shaped values), {@link GameServer.file_seeds}
 * (arbitrary file content), and {@link GameServer.healthCheck}'s `auth`
 * field (a Secrets Manager ARN reference) — `hasHealthCheck` reports only
 * whether a health check is configured, never its contents.
 */
export interface DiagnosticsGameServerSummary {
  name: string;
  image: string;
  cpu: number;
  memory: number;
  portCount: number;
  https: boolean;
  volumeCount: number;
  hasHealthCheck: boolean;
}

/**
 * Diagnostics bundle's config-summary section shape — an explicit allowlist
 * of non-secret `DeploymentConfig` fields, matching the allowlist-redaction
 * discipline already used elsewhere (e.g. `RedactedDiscordConfig.botTokenSet`).
 * Guild/admin identifiers and the Discord application ID are intentionally
 * excluded: they identify real people/servers and aren't needed to diagnose
 * an infra or game-server problem.
 */
export interface DiagnosticsConfigSummary {
  projectName: string;
  awsRegion: string;
  vpcCidr: string;
  hostedZoneName: string;
  dnsTtl: number;
  watchdogIntervalMinutes: number;
  watchdogIdleChecks: number;
  watchdogMinPackets: number;
  auditTableName: string;
  runsTableName: string;
  gameServers: DiagnosticsGameServerSummary[];
}

/**
 * Reduces a {@link GameServer} entry to {@link DiagnosticsGameServerSummary}'s
 * explicit allowlist. Pure function — no I/O.
 *
 * @param game - A declared game entry, as returned by
 *   `DeploymentConfigService.getGameServers()`.
 */
function summarizeGameServer(game: GameServer): DiagnosticsGameServerSummary {
  return {
    name: game.name,
    image: game.image,
    cpu: game.cpu,
    memory: game.memory,
    portCount: game.ports.length,
    https: game.https ?? false,
    volumeCount: game.volumes.length,
    hasHealthCheck: game.healthCheck != null,
  };
}

/**
 * Builds the diagnostics bundle's config-summary section from the live
 * `DeploymentConfig`, keeping only the fields on {@link DiagnosticsConfigSummary}'s
 * explicit allowlist. Any other field present on `settings` — including one
 * added to `DeploymentConfig` after this function was written — is silently
 * excluded rather than leaked; extending the bundle to cover a new field
 * requires deliberately adding it here.
 *
 * Pure function — no I/O — mirroring `redactGameServer`'s convention.
 *
 * @param settings - The current top-level settings, as returned by
 *   `DeploymentConfigService.getTopLevelSettings()`.
 * @param gameServers - The current declared game entries, as returned by
 *   `DeploymentConfigService.getGameServers()`.
 */
export function buildDiagnosticsConfigSummary(
  settings: Omit<DeploymentConfig, 'gameServers'>,
  gameServers: GameServer[],
): DiagnosticsConfigSummary {
  return {
    projectName: settings.projectName,
    awsRegion: settings.awsRegion,
    vpcCidr: settings.vpcCidr,
    hostedZoneName: settings.hostedZoneName,
    dnsTtl: settings.dnsTtl,
    watchdogIntervalMinutes: settings.watchdogIntervalMinutes,
    watchdogIdleChecks: settings.watchdogIdleChecks,
    watchdogMinPackets: settings.watchdogMinPackets,
    auditTableName: settings.auditTableName,
    runsTableName: settings.runsTableName,
    gameServers: gameServers.map(summarizeGameServer),
  };
}
