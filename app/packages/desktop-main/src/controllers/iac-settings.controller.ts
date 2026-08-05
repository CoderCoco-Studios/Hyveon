import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type {
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  PulumiEngineVersionResult,
  UpdateDeploymentSettingsPayload,
} from '@hyveon/shared';
import { OptimisticLockError, validateDeploymentSettingsPatch } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigurationNotConfiguredError, RunsTableRenameError, TfvarsService } from '../services/TfvarsService.js';
// Deliberately a value import, not `import type` — Nest's constructor-parameter
// DI resolves `engine`'s token off `design:paramtypes` metadata, which
// `emitDecoratorMetadata` can only populate from a real (value) import; an
// `import type` here erases the class reference entirely and Nest fails at
// bootstrap with `UnknownDependenciesException` (confirmed by launching the
// packaged app during this task's own verification — see the class doc
// comment above `engine`'s constructor parameter).
import { PulumiEngineService } from '../services/PulumiEngineService.js';

/**
 * IPC-only controller for the deployment-settings editor — reads and writes
 * every top-level `DeploymentConfig` field EXCEPT `gameServers` (that map
 * keeps its own dedicated `GamesController`/`GamesWriteService` flow,
 * untouched here). Every handler is bound to an IPC channel via
 * `@MessagePattern` / `@Payload` — no HTTP routes are registered here.
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
   * `engine` is typed optional (`?`) purely so existing test call sites that
   * construct `new IacSettingsController(tfvars)` directly (bypassing Nest's
   * DI container) keep compiling without also stubbing it — mirrors
   * `IacController`'s identical `audit`/`runRecord`/`config` optionality (see
   * that class's own constructor doc comment). Every real bootstrap through
   * `AppModule` still resolves a concrete `PulumiEngineService` regardless of
   * this TS-level optionality; {@link engineVersion} treats an absent
   * `engine` the same as "not yet provisioned" rather than throwing.
   */
  constructor(
    private readonly tfvars: TfvarsService,
    private readonly engine?: PulumiEngineService,
  ) {}

  /**
   * Returns the current top-level deployment settings plus the etag to
   * round-trip as {@link update}'s `expectedVersionId` — see
   * `TfvarsService.getTopLevelSettings()`.
   *
   * Reachable via the Electron IPC transport (`iac.settings.get`).
   */
  @MessagePattern('iac.settings.get')
  async get(): Promise<DeploymentSettingsGetResult> {
    try {
      const { settings, etag } = await this.tfvars.getTopLevelSettings();
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
   * (the same validator the renderer's form runs client-side — see that
   * function's doc comment) and, if it passes, delegates to
   * `TfvarsService.updateTopLevelSettings()`. Re-reads the settings
   * post-write so a successful result's `settings` reflects exactly what's
   * now persisted, including any field `payload.patch` omitted.
   *
   * Failure mapping:
   *  - {@link validateDeploymentSettingsPatch} reports issues → `{ code: 'validation' }`
   *    with the full issue list — never reaches `TfvarsService` at all.
   *  - `RunsTableRenameError` (the patch would rename the already-bootstrapped
   *    run-history table — see that class's own doc comment) → also
   *    `{ code: 'validation' }`, with one issue per field the error reports
   *    changed (`projectName`/`runsTableName`), so the Settings form's
   *    existing per-field issue rendering displays it with no changes needed.
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `ConfigurationNotConfiguredError` (no configuration bucket configured)
   *    → `{ code: 'setup_incomplete' }`, distinct from the generic
   *    `{ code: 'error' }` so the renderer can route the operator toward the
   *    setup wizard instead of a generic failure message.
   *  - Anything else (e.g. malformed config JSON, an unexpected S3 error, or
   *    a malformed `payload`/`payload.patch` envelope itself) → the
   *    catch-all `{ code: 'error' }`.
   *
   * The {@link validateDeploymentSettingsPatch} call lives INSIDE the `try`
   * block rather than before it — a malformed envelope
   * (`payload` or `payload.patch` absent/wrong-shaped, which nothing upstream
   * of this handler guarantees against on the IPC boundary) would otherwise
   * throw a raw, unstructured error out of this handler instead of returning
   * the same `{ code: 'error' }` shape every other unexpected failure here
   * resolves to.
   *
   * Reachable via the Electron IPC transport (`iac.settings.update`).
   */
  @MessagePattern('iac.settings.update')
  async update(@Payload() payload: UpdateDeploymentSettingsPayload): Promise<DeploymentSettingsWriteResult> {
    try {
      const issues = validateDeploymentSettingsPatch(payload.patch);
      if (issues.length > 0) {
        return { ok: false, code: 'validation', issues };
      }

      const write = await this.tfvars.updateTopLevelSettings(payload.patch, payload.expectedVersionId);
      const { settings } = await this.tfvars.getTopLevelSettings();
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
   * Reachable via the Electron IPC transport (`iac.settings.engineVersion`).
   */
  @MessagePattern('iac.settings.engineVersion')
  engineVersion(): PulumiEngineVersionResult {
    return { resolvedVersion: this.engine?.getResolvedVersion() ?? null };
  }
}
