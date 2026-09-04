import { Injectable } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { errMessage, type GameStatus } from '@hyveon/shared';
import { logger } from '../logger.js';
import { DiagnosticsService } from './DiagnosticsService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';
import { ConfigService } from './ConfigService.js';
import { EcsService } from './EcsService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { buildDiagnosticsConfigSummary, type DiagnosticsConfigSummary } from './diagnosticsBundleAllowlist.js';
import { scrubSecrets } from './diagnosticsLogScrubber.js';

/**
 * Requested number of trailing log lines for the bundle's `logs.txt` —
 * higher than the live panel's 500-line tail since this is a one-shot
 * export, not a polled view. Not a hard guarantee: `DiagnosticsService.readTail`
 * reads a fixed ~200KB (`TAIL_READ_BYTES`) off the end of the log file
 * before splitting into lines, regardless of the line count requested here,
 * so a busy/verbose log can hit that byte cap and yield fewer than 2000
 * lines — potentially no better than the panel's 500-line tail.
 */
const BUNDLE_LOG_TAIL_LINES = 2000;

/** One entry in the bundle's `errors.json` — section name and a human-readable message only, never a raw error object or stack trace. */
export interface DiagnosticsBundleErrorEntry {
  section: 'logs' | 'config' | 'metadata' | 'aws';
  message: string;
}

/** App/system metadata gathered for the bundle's `metadata.json`. */
export interface DiagnosticsBundleMetadata {
  appVersion: string;
  electronVersion: string | null;
  nodeVersion: string;
  platform: string;
  osVersion: string;
  autoUpdateEnabled: boolean;
}

/** Best-effort AWS resource snapshot gathered for the bundle's `aws-snapshot.json`. */
export interface DiagnosticsBundleAwsSnapshot {
  stackOutputs: {
    awsRegion: string;
    ecsClusterName: string;
    domainName: string;
    gameNames: string[];
  } | null;
  games: GameStatus[];
}

/** Result of a successful {@link DiagnosticsBundleService.writeBundle} call. */
export interface DiagnosticsBundleWriteResult {
  path: string;
}

/**
 * Gathers and zips the four diagnostics-bundle sections (logs, config
 * summary, app/system metadata, AWS resource snapshot) into a single `.zip`
 * file on disk, per `openspec/changes/add-diagnostics-export`.
 *
 * Calls into `DiagnosticsService` (log access), `DeploymentConfigService`
 * (config access, via the {@link buildDiagnosticsConfigSummary} allowlist),
 * and the same `ConfigService`/`EcsService` calls `GamesController.listStatus`
 * already composes for the AWS resource snapshot — this service does not
 * duplicate their AWS SDK calls, it reuses them. Each section is gathered
 * independently via `Promise.allSettled` so one slow/failing section (most
 * likely the AWS snapshot, when credentials are unavailable) never blocks or
 * drops the others.
 */
@Injectable()
export class DiagnosticsBundleService {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Gathers all four sections and writes the resulting `.zip` to
   * `destinationPath`. Every section is best-effort: a failure gathering any
   * one section is recorded in the bundle's `errors.json` rather than
   * failing the whole export — a bundle with every section failed is still a
   * valid export, containing only `errors.json`.
   *
   * Writes to a sibling temp file first and renames it into place only once
   * the archive has finished writing successfully, so a failure partway
   * through never leaves a partial file at `destinationPath` that could be
   * mistaken for a complete bundle.
   *
   * @param destinationPath - Absolute path (including `.zip` extension) to
   *   write the bundle to, as chosen by the operator via a native save
   *   dialog.
   * @throws A plain `Error` if the completed archive cannot be written to
   *   disk (e.g. disk full, permission denied) — the caller
   *   (`DiagnosticsController`) maps this to an error result for the
   *   renderer.
   */
  async writeBundle(destinationPath: string): Promise<DiagnosticsBundleWriteResult> {
    logger.debug('DiagnosticsBundleService.writeBundle: gathering diagnostics bundle sections');

    const [logsResult, configResult, metadataResult, awsResult] = await Promise.allSettled([
      this.gatherLogs(),
      this.gatherConfigSummary(),
      this.gatherMetadata(),
      this.gatherAwsSnapshot(),
    ]);

    const errors: DiagnosticsBundleErrorEntry[] = [];
    const sections: {
      logs?: string;
      config?: DiagnosticsConfigSummary;
      metadata?: DiagnosticsBundleMetadata;
      aws?: DiagnosticsBundleAwsSnapshot;
    } = {};

    this.collectSection(logsResult, 'logs', (value) => (sections.logs = value), errors);
    this.collectSection(configResult, 'config', (value) => (sections.config = value), errors);
    this.collectSection(metadataResult, 'metadata', (value) => (sections.metadata = value), errors);
    this.collectSection(awsResult, 'aws', (value) => (sections.aws = value), errors);

    try {
      await this.writeZip(destinationPath, sections, errors);
      return { path: destinationPath };
    } catch (err) {
      const message = errMessage(err);
      logger.error('DiagnosticsBundleService.writeBundle: failed to write bundle to disk', { message });
      throw new Error(message);
    }
  }

  /** Maps one settled section result into `sections`/`errors`, logging a failure via `logger.warn`. */
  private collectSection<T>(
    result: PromiseSettledResult<T>,
    section: DiagnosticsBundleErrorEntry['section'],
    assign: (value: T) => void,
    errors: DiagnosticsBundleErrorEntry[],
  ): void {
    if (result.status === 'fulfilled') {
      assign(result.value);
      return;
    }
    const message = scrubSecrets(errMessage(result.reason));
    errors.push({ section, message });
    logger.warn('DiagnosticsBundleService.writeBundle: section failed', { section, message });
  }

  private async gatherLogs(): Promise<string> {
    const lines = await this.diagnostics.readTail(BUNDLE_LOG_TAIL_LINES);
    return scrubSecrets(lines.join('\n'));
  }

  private async gatherConfigSummary(): Promise<DiagnosticsConfigSummary> {
    const [{ settings }, gameServers] = await Promise.all([
      this.deploymentConfig.getTopLevelSettings(),
      this.deploymentConfig.getGameServers(),
    ]);
    return buildDiagnosticsConfigSummary(settings, gameServers);
  }

  private async gatherMetadata(): Promise<DiagnosticsBundleMetadata> {
    return {
      appVersion: this.readAppVersion(),
      electronVersion: process.versions['electron'] ?? null,
      nodeVersion: process.versions.node,
      platform: os.platform(),
      osVersion: os.release(),
      autoUpdateEnabled: this.store.get('enableAutoUpdate') ?? false,
    };
  }

  /**
   * Gathers stack outputs plus a per-game `EcsService.getStatus` snapshot.
   * Uses `Promise.allSettled` (not `Promise.all`) over the per-game calls so
   * one game's rejection (e.g. a transient AWS API error) doesn't discard
   * the already-resolved `stackOutputs` or the other games' statuses — a
   * failed game is instead modeled as a `GameStatus` with `state: 'error'`
   * and `message` set, the same shape `EcsService.getStatus` itself already
   * uses for a resolvable-but-unhealthy workload.
   */
  private async gatherAwsSnapshot(): Promise<DiagnosticsBundleAwsSnapshot> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) {
      return { stackOutputs: null, games: [] };
    }
    const results = await Promise.allSettled(outputs.gameNames.map((game) => this.ecs.getStatus(game)));
    const games = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const game = outputs.gameNames[index]!;
      const message = errMessage(result.reason);
      logger.warn('DiagnosticsBundleService.gatherAwsSnapshot: getStatus failed for game', { game, message });
      return { game, state: 'error' as const, message };
    });
    return {
      stackOutputs: {
        awsRegion: outputs.awsRegion,
        ecsClusterName: outputs.ecsClusterName,
        domainName: outputs.domainName,
        gameNames: outputs.gameNames,
      },
      games,
    };
  }

  /**
   * Returns the packaged app's version via Electron's `app.getVersion()`,
   * lazily requiring `electron` at call-time (mirrors
   * `CloudHealthService.readIsPackaged`'s pattern). Returns `'unknown'`
   * outside Electron (e.g. under Vitest) rather than throwing — the
   * metadata section degrades gracefully instead of failing entirely over
   * one field. Extracted as a protected method so tests can stub it.
   */
  protected readAppVersion(): string {
    if (!process.versions['electron']) return 'unknown';
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getVersion(): string } };
      return electron.app.getVersion();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Streams `sections` plus `errors` into a `.zip` at `destinationPath` via
   * `archiver`. Writes to a `${destinationPath}.<uuid>.tmp` sibling first
   * and renames it into place only on success — a write failure partway
   * through removes the temp file instead of leaving a partial archive at
   * the final path (see this class's own doc comment). The temp filename
   * includes a `randomUUID()` suffix (matching this codebase's established
   * unique-token convention, e.g. `RunService`/`PulumiService`) so
   * concurrent `exportBundle` calls to the same destination never race on
   * the same temp file.
   */
  private async writeZip(
    destinationPath: string,
    sections: { logs?: string; config?: DiagnosticsConfigSummary; metadata?: DiagnosticsBundleMetadata; aws?: DiagnosticsBundleAwsSnapshot },
    errors: DiagnosticsBundleErrorEntry[],
  ): Promise<void> {
    const tempPath = `${destinationPath}.${randomUUID()}.tmp`;
    let output: ReturnType<typeof createWriteStream> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        output = createWriteStream(tempPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', (err) => reject(err));
        archive.on('error', (err) => reject(err));

        archive.pipe(output);

        if (sections.logs !== undefined) archive.append(sections.logs, { name: 'logs.txt' });
        if (sections.config !== undefined) archive.append(JSON.stringify(sections.config, null, 2), { name: 'config-summary.json' });
        if (sections.metadata !== undefined) archive.append(JSON.stringify(sections.metadata, null, 2), { name: 'metadata.json' });
        if (sections.aws !== undefined) archive.append(JSON.stringify(sections.aws, null, 2), { name: 'aws-snapshot.json' });
        archive.append(JSON.stringify(errors, null, 2), { name: 'errors.json' });

        void archive.finalize();
      });
      await rename(tempPath, destinationPath);
    } catch (err) {
      // Explicitly destroy the write stream before cleanup — on Windows an
      // still-open handle on `tempPath` can make `rm` fail with EBUSY/EPERM.
      output?.destroy();
      try {
        await rm(tempPath, { force: true });
      } catch (cleanupErr) {
        logger.warn('DiagnosticsBundleService.writeZip: failed to remove temp file after write failure', {
          tempPath,
          message: errMessage(cleanupErr),
        });
      }
      throw err;
    }
  }
}
