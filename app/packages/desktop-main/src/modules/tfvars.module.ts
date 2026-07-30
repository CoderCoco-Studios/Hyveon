import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { TfvarsService } from '../services/TfvarsService.js';
import { TFVARS_SERVICE } from '../services/PulumiService.js';

/**
 * Feature module for `TfvarsService`, the local-vs-S3 `terraform.tfvars`
 * reader/parser (see `TfvarsService`'s file-level doc comment for source
 * resolution, parsing, and caching behaviour).
 *
 * `ConfigModule` is imported for `ConfigService` (tfvars source resolution)
 * and `CloudProviderModule` for the `REMOTE_FILE_STORE` token (S3-mode
 * reads), both re-exported alongside `TfvarsService` so any consumer that
 * only needs `TfvarsModule` gets the full dependency chain without also
 * importing `AwsModule`.
 *
 * Also binds `TFVARS_SERVICE` (`PulumiService.ts`'s narrow DI token for the
 * slice of `TfvarsService.restoreRawTfvars`'s surface
 * `PulumiService.confirmRollback` depends on — task 7.6, see that token's
 * own doc comment) to the real `TfvarsService` singleton via `useExisting`,
 * and exports it — mirrors `run-record.module.ts`'s identical
 * `RUN_RECORD_PERSISTER`/`RUN_LOCK_SERVICE` bindings. This module is already
 * imported directly by `app.module.ts` (and by `terraform.module.ts`), so
 * `TFVARS_SERVICE` is reachable from anywhere in the application container
 * via `ModuleRef.get(TFVARS_SERVICE, { strict: false })` without
 * `pulumi-service.module.ts` ever needing a static `imports:` edge back to
 * this module — see `TFVARS_SERVICE`'s own doc comment for why that edge
 * would close a real module cycle (`TfvarsModule` → `ConfigModule` →
 * `PulumiServiceModule`, both reachable from this module already).
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [TfvarsService, { provide: TFVARS_SERVICE, useExisting: TfvarsService }],
  exports: [ConfigModule, CloudProviderModule, TfvarsService, TFVARS_SERVICE],
})
export class TfvarsModule {}
