import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { TfvarsModule } from './tfvars.module.js';
import { RunRecordModule } from './run-record.module.js';
import { TerraformService } from '../services/TerraformService.js';

/**
 * Feature module for `TerraformService`, the local `terraform` CLI
 * detection/orchestration seam (see `TerraformService`'s file-level doc
 * comment). Construction is synchronous and never throws — binary lookup
 * and version resolution are deferred to first use of `getBinaryPath()` /
 * `getVersion()` — so the provider is wired as a plain class provider rather
 * than an async `useFactory`, and `AppModule` can import this module safely
 * even on machines without `terraform` on PATH.
 *
 * Imports `ConfigModule` because `TerraformService` takes `ConfigService` as
 * a constructor dependency (to resolve the working directory and the
 * per-run artifacts directory) and `CloudProviderModule` for the
 * `REMOTE_FILE_STORE` token — `TerraformService.plan()` pulls the current
 * tfvars snapshot from it in S3 mode, mirroring `TfvarsModule`'s wiring.
 * Both modules are re-exported alongside `TerraformService` so any consumer
 * that only needs `TerraformModule` gets the full dependency chain without
 * also importing `AwsModule`.
 *
 * Imports (and re-exports) `RunRecordModule` (task 7.1, `migrate-iac-to-pulumi`
 * — extracted from this module, see its own doc comment for why) for
 * `RunService`/`RunRecordService`, rather than declaring them as this
 * module's own providers as it did before that extraction — `RunRecordService.persist()`
 * also releases the apply lock `RunService` acquired for the run it's
 * persisting, via an injected `RunService`.
 *
 * Imported by `AppModule` alongside `TerraformController`, which bridges
 * `TerraformService.init`'s async-generator output onto Electron IPC.
 *
 * Also imports `TfvarsModule` so `TerraformService`'s optional
 * `TfvarsService` constructor dependency (used only by the rollback flow,
 * #112 — see `resolveRollbackTarget`/`confirmRollback`) resolves through
 * Nest DI; re-exported for the same "full dependency chain" reason as
 * `ConfigModule`/`CloudProviderModule` above.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule, TfvarsModule, RunRecordModule],
  providers: [TerraformService],
  exports: [ConfigModule, CloudProviderModule, TfvarsModule, RunRecordModule, TerraformService],
})
export class TerraformModule {}
