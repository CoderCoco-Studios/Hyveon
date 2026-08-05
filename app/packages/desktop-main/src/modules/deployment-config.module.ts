import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { DeploymentConfigService } from '../services/DeploymentConfigService.js';
import { DEPLOYMENT_CONFIG_SERVICE } from '../services/PulumiService.js';

/**
 * Feature module for `DeploymentConfigService`, the local-vs-S3 `terraform.tfvars`
 * reader/parser (see `DeploymentConfigService`'s file-level doc comment for source
 * resolution, parsing, and caching behaviour).
 *
 * `ConfigModule` is imported for `ConfigService` (tfvars source resolution)
 * and `CloudProviderModule` for the `REMOTE_FILE_STORE` token (S3-mode
 * reads), both re-exported alongside `DeploymentConfigService` so any consumer that
 * only needs `DeploymentConfigModule` gets the full dependency chain without also
 * importing `AwsModule`.
 *
 * Also binds `DEPLOYMENT_CONFIG_SERVICE` (`PulumiService.ts`'s narrow DI token for the
 * slice of `DeploymentConfigService.restoreRawConfig`'s surface
 * `PulumiService.confirmRollback` depends on — see that token's own doc
 * comment) to the real `DeploymentConfigService` singleton via `useExisting`,
 * and exports it — mirrors `run-record.module.ts`'s identical
 * `RUN_RECORD_PERSISTER`/`RUN_LOCK_SERVICE` bindings. This module is already
 * imported directly by `app.module.ts`, so
 * `DEPLOYMENT_CONFIG_SERVICE` is reachable from anywhere in the application container
 * via `ModuleRef.get(DEPLOYMENT_CONFIG_SERVICE, { strict: false })` without
 * `pulumi-service.module.ts` ever needing a static `imports:` edge back to
 * this module — see `DEPLOYMENT_CONFIG_SERVICE`'s own doc comment for why that edge
 * would close a real module cycle (`DeploymentConfigModule` → `ConfigModule` →
 * `PulumiServiceModule`, both reachable from this module already).
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [DeploymentConfigService, { provide: DEPLOYMENT_CONFIG_SERVICE, useExisting: DeploymentConfigService }],
  exports: [ConfigModule, CloudProviderModule, DeploymentConfigService, DEPLOYMENT_CONFIG_SERVICE],
})
export class DeploymentConfigModule {}
