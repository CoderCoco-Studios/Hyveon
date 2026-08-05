import { Module } from '@nestjs/common';
import { RunRecordService } from '../services/RunRecordService.js';
import { RunService } from '../services/RunService.js';
import { RUN_LOCK_SERVICE, RUN_RECORD_PERSISTER } from '../services/PulumiService.js';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';

/**
 * Feature module for `RunService` (the in-memory + DynamoDB apply lock
 * guarding Pulumi plan/apply/destroy submissions) and `RunRecordService`
 * (run-history persistence), which `PulumiService` writes its run records
 * through (the deleted `TerraformService` formerly did too). `AppModule`
 * imports this module directly rather than declaring
 * `RunService`/`RunRecordService` as its own providers, so every consumer
 * shares the exact same singletons — a second module-level provider
 * declaration for the same class would create a second instance, splitting
 * `RunService`'s in-memory `currentLock` state across two injectors and
 * breaking the "only one lock in-process" invariant.
 *
 * Also binds `RUN_RECORD_PERSISTER` (`PulumiService.ts`'s narrow DI token
 * for the slice of `RunRecordService.persist`/`.getByRunId`'s surface
 * `preview()`/`apply()` depend on — see that token's own doc comment) to the
 * real `RunRecordService` singleton via `useExisting`, and `RUN_LOCK_SERVICE`
 * (the narrow DI token for the slice of `RunService.createRun` `apply()`'s
 * gate step depends on — see that token's own doc comment) to the real
 * `RunService` singleton, and exports both tokens.
 *
 * ## Why `PulumiServiceModule` does NOT import this module
 *
 * `PulumiServiceModule` cannot statically import this module: this module
 * imports `ConfigModule` (for `RunService`/`RunRecordService`'s own
 * `ConfigService` dependency), and `ConfigModule` imports
 * `PulumiServiceModule` (for `ConfigService.getStackOutputs()`'s delegate),
 * so a static `imports:` edge back from `PulumiServiceModule` would create a
 * `PulumiServiceModule` → `RunRecordModule` → `ConfigModule` →
 * `PulumiServiceModule` cycle. This project compiles to `module: "ESNext"`
 * and runs as native ESM, not a bundler-transpiled CommonJS namespace
 * object, and native ESM's strict temporal-dead-zone semantics make
 * `forwardRef()`-guarded module cycles unreliable here.
 *
 * Instead, `PulumiService` takes `ModuleRef` (a core Nest primitive with no
 * relation to any module in this cycle, so injecting it creates no new edge)
 * and resolves `RUN_RECORD_PERSISTER`/`REMOTE_FILE_STORE` lazily inside
 * `preview()` itself — see `PulumiService.ts`'s `getRunRecordPersister`/
 * `getRemoteFileStore`. A strict-false `ModuleRef.get()` lookup searches the
 * whole application's provider container rather than following a
 * compile-time `imports:` edge, so as long as *some* module reachable from
 * the real `AppModule` (this module, imported directly — see above) provides
 * `RUN_RECORD_PERSISTER`, `PulumiService` finds the same singleton every
 * other `RunRecordService` consumer uses, without `PulumiServiceModule` ever
 * needing a static edge back to this module and without
 * `ConfigModule`/`PulumiServiceModule`/`CloudProviderModule` ever forming a
 * cycle. `config.module.ts`/`cloud-provider.module.ts` document the same
 * conclusion from their own side.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [
    RunService,
    RunRecordService,
    { provide: RUN_RECORD_PERSISTER, useExisting: RunRecordService },
    { provide: RUN_LOCK_SERVICE, useExisting: RunService },
  ],
  exports: [RunService, RunRecordService, RUN_RECORD_PERSISTER, RUN_LOCK_SERVICE],
})
export class RunRecordModule {}
