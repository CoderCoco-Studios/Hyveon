import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type {
  AutoUpdateSettingGetResult,
  AutoUpdateSettingUpdatePayload,
  AutoUpdateSettingWriteResult,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  ManualUpdateCheckResult,
  PulumiEngineVersionResult,
  UpdateDeploymentSettingsPayload,
} from '@hyveon/shared';
import { OptimisticLockError, errMessage, validateDeploymentSettingsPatch } from '@hyveon/shared';
import { logger } from '../logger.js';
import { checkForUpdatesNow } from '../updater.js';
import { ConfigurationNotConfiguredError, RunsTableRenameError, DeploymentConfigService } from '../services/DeploymentConfigService.js';
// Deliberately a value import, not `import type` — Nest's constructor-parameter
// DI resolves `engine`'s token off `design:paramtypes` metadata, which
// `emitDecoratorMetadata` can only populate from a real (value) import; an
// `import type` here erases the class reference entirely and Nest fails at
// bootstrap with `UnknownDependenciesException` (confirmed by launching the
// packaged app during this task's own verification — see the class doc
// comment above `engine`'s constructor parameter).
import { PulumiEngineService } from '../services/PulumiEngineService.js';
// Same value-import requirement as `PulumiEngineService` above — see that
// import's doc comment.
import { ElectronStoreService } from '../services/ElectronStoreService.js';

/**
 * IPC-only controller for the deployment-settings editor — reads and writes
 * every top-level `DeploymentConfig` field EXCEPT `gameServers` (that map
 * keeps its own dedicated `GamesController`/`GamesWriteService` flow,
 * untouched here). Every handler is bound to an IPC channel via
 * `@MessagePattern` / `@Payload`.
 * Mirrors `EnvController`'s minimal shape (business logic inline in the
 * controller, no dedicated write-service class) rather than
 * `GamesController`'s heavier `GamesWriteService` delegation — this surface
 * has no audit-log requirement and a much smaller error-mapping surface, so
 * a separate service class would be pure ceremony.
 *
 * {@link engineVersion} also lives here rather than on `IacController`: it
 * is Settings-page-flavored, read/write status for the Cloud Setup section,
 * exactly like every other handler on this controller — whereas
 * `IacController` is scoped to plan/apply/destroy orchestration and its
 * `PulumiEngineService` reference (via `PulumiService`) is purely internal
 * to the apply gate, never surfaced on its own channel.
 */
@Controller()
export class IacSettingsController {
  /**
   * `engine` and `store` are both typed optional (`?`) purely so existing
   * test call sites that construct `new IacSettingsController(deploymentConfig)`
   * directly (bypassing Nest's DI container) keep compiling without also
   * stubbing them — mirrors `IacController`'s identical
   * `audit`/`runRecord`/`config` optionality (see that class's own
   * constructor doc comment). Every real bootstrap through `AppModule` still
   * resolves a concrete `PulumiEngineService`/`ElectronStoreService`
   * regardless of this TS-level optionality; {@link engineVersion} treats an
   * absent `engine` the same as "not yet provisioned" rather than throwing,
   * and {@link getAutoUpdate}/{@link updateAutoUpdate} treat an absent
   * `store` the same way.
   */
  constructor(
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly engine?: PulumiEngineService,
    private readonly store?: ElectronStoreService,
  ) {}

  /**
   * Returns the current top-level deployment settings plus the etag to
   * round-trip as {@link update}'s `expectedVersionId` — see
   * `DeploymentConfigService.getTopLevelSettings()`.
   *
   */
  @MessagePattern('iac.settings.get')
  async get(): Promise<DeploymentSettingsGetResult> {
    logger.debug('IacSettingsController: iac.settings.get invoked');
    try {
      const { settings, etag } = await this.deploymentConfig.getTopLevelSettings();
      return { ok: true, settings, etag };
    } catch (err) {
      if (err instanceof ConfigurationNotConfiguredError) {
        logger.warn('Deployment settings read rejected — no configuration bucket configured', { err: err.message });
        return { ok: false, code: 'setup_incomplete', message: err.message };
      }
      logger.error('Failed to read deployment settings', { err });
      return { ok: false, code: 'error', message: 'An unexpected error occurred while reading deployment settings.' };
    }
  }

  /**
   * Validates `payload.patch` via {@link validateDeploymentSettingsPatch}
   * and, if it passes, delegates to
   * `DeploymentConfigService.updateTopLevelSettings()`, re-reading afterward
   * so a successful result reflects exactly what's now persisted.
   *
   * The validation call lives INSIDE the `try` block rather than before it:
   * `payload`/`payload.patch` may be absent or wrong-shaped (nothing
   * upstream of this handler guarantees the IPC boundary), and a malformed
   * envelope there must resolve to the same `{ code: 'error' }` shape as
   * every other unexpected failure here — not throw a raw, unstructured
   * error out of the handler.
   *
   */
  @MessagePattern('iac.settings.update')
  async update(@Payload() payload: UpdateDeploymentSettingsPayload): Promise<DeploymentSettingsWriteResult> {
    logger.debug('IacSettingsController: iac.settings.update invoked');
    try {
      const issues = validateDeploymentSettingsPatch(payload.patch);
      if (issues.length > 0) {
        return { ok: false, code: 'validation', issues };
      }

      const write = await this.deploymentConfig.updateTopLevelSettings(payload.patch, payload.expectedVersionId);
      const { settings } = await this.deploymentConfig.getTopLevelSettings();
      return { ok: true, settings, etag: write.etag, versionId: write.versionId };
    } catch (err) {
      if (err instanceof RunsTableRenameError) {
        logger.warn('Deployment settings write rejected — would rename the already-bootstrapped runs table', {
          fields: err.fields,
          err: err.message,
        });
        return {
          ok: false,
          code: 'validation',
          issues: err.fields.map((field) => ({ path: field, message: err.message })),
        };
      }
      if (err instanceof OptimisticLockError) {
        return {
          ok: false,
          code: 'conflict',
          expectedVersionId: err.expectedEtag,
          currentVersionId: err.currentEtag,
          message: err.message,
        };
      }
      if (err instanceof ConfigurationNotConfiguredError) {
        logger.warn('Deployment settings write rejected — no configuration bucket configured', { err: err.message });
        return { ok: false, code: 'setup_incomplete', message: err.message };
      }
      logger.error('Failed to write deployment settings', { err });
      return { ok: false, code: 'error', message: 'An unexpected error occurred while writing deployment settings.' };
    }
  }

  /**
   * Returns the resolved Pulumi engine version — `PulumiEngineService.getResolvedVersion()`
   * verbatim — for Settings' Cloud Setup version row. `resolvedVersion: null`
   * is a real, expected "not yet provisioned" state (including while a first
   * resolution is still in flight), not an error: unlike {@link get}/
   * {@link update}, this handler has no failure branch to map, since the
   * underlying getter is a synchronous field read that never throws — see
   * {@link PulumiEngineVersionResult}'s own doc comment.
   *
   */
  @MessagePattern('iac.settings.engineVersion')
  engineVersion(): PulumiEngineVersionResult {
    logger.debug('IacSettingsController: iac.settings.engineVersion invoked');
    return { resolvedVersion: this.engine?.getResolvedVersion() ?? null };
  }

  /**
   * Reads the `enableAutoUpdate` electron-store flag that gates
   * `desktop-main/src/updater.ts`'s update checks. An absent `store` (test
   * call sites that construct this controller directly, per {@link store}'s
   * doc comment) is treated the same as an absent stored value — `false`,
   * never a thrown error, mirroring {@link engineVersion}'s `?? null`
   * fallback for an absent `engine`. A `store.get` call that throws (e.g. a
   * corrupted electron-store file on disk) is caught and mapped to an
   * `{ ok: false }` result, mirroring {@link updateAutoUpdate}'s own
   * try/catch.
   *
   */
  @MessagePattern('iac.settings.autoUpdate.get')
  getAutoUpdate(): AutoUpdateSettingGetResult {
    logger.debug('IacSettingsController: iac.settings.autoUpdate.get invoked');
    try {
      return { ok: true, enableAutoUpdate: this.store?.get('enableAutoUpdate') ?? false };
    } catch (err) {
      logger.error('Failed to read enableAutoUpdate setting', { err: errMessage(err) });
      return { ok: false, code: 'error', message: 'An unexpected error occurred while reading the auto-update setting.' };
    }
  }

  /**
   * Writes the `enableAutoUpdate` electron-store flag. Takes effect on the
   * next app start — `initUpdater` only runs once at Electron boot
   * (`electron-entry.ts`), so this write has no effect on the currently
   * running session.
   *
   */
  @MessagePattern('iac.settings.autoUpdate.update')
  updateAutoUpdate(@Payload() payload: AutoUpdateSettingUpdatePayload): AutoUpdateSettingWriteResult {
    logger.debug('IacSettingsController: iac.settings.autoUpdate.update invoked');
    try {
      if (typeof payload?.enableAutoUpdate !== 'boolean') {
        return { ok: false, code: 'error', message: 'enableAutoUpdate must be a boolean.' };
      }
      if (!this.store) {
        return { ok: false, code: 'error', message: 'Settings store is unavailable.' };
      }
      this.store.set('enableAutoUpdate', payload.enableAutoUpdate);
      return { ok: true, enableAutoUpdate: payload.enableAutoUpdate };
    } catch (err) {
      logger.error('Failed to write enableAutoUpdate setting', { err: errMessage(err) });
      return { ok: false, code: 'error', message: 'An unexpected error occurred while writing the auto-update setting.' };
    }
  }

  /**
   * Runs an on-demand update check via `checkForUpdatesNow()`
   * (`desktop-main/src/updater.ts`), independent of the `enableAutoUpdate`
   * flag — the flag gates only the automatic boot-time check. Never
   * downloads or installs; see that function's doc comment.
   *
   */
  @MessagePattern('iac.settings.autoUpdate.check')
  async checkAutoUpdate(): Promise<ManualUpdateCheckResult> {
    logger.debug('IacSettingsController: iac.settings.autoUpdate.check invoked');
    return checkForUpdatesNow();
  }
}
