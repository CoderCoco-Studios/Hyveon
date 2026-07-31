import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type {
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  UpdateDeploymentSettingsPayload,
} from '@hyveon/shared';
import { OptimisticLockError, validateDeploymentSettingsPatch } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigurationNotConfiguredError, TfvarsService } from '../services/TfvarsService.js';

/**
 * IPC-only controller for task 9.7's (`migrate-iac-to-pulumi`) deployment-
 * settings editor — reads and writes every top-level `DeploymentConfig`
 * field EXCEPT `gameServers` (that map keeps its own dedicated
 * `GamesController`/`GamesWriteService` flow, untouched here). Every
 * handler is bound to an IPC channel via `@MessagePattern` / `@Payload` — no
 * HTTP routes are registered here. Mirrors `ConfigController`'s minimal
 * shape (business logic inline in the controller, no dedicated write-service
 * class) rather than `GamesController`'s heavier `GamesWriteService`
 * delegation — this surface has no audit-log requirement and a much smaller
 * error-mapping surface, so a separate service class would be pure
 * ceremony.
 */
@Controller()
export class IacSettingsController {
  constructor(private readonly tfvars: TfvarsService) {}

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
   * block (review round 1, M2) rather than before it — a malformed envelope
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
}
