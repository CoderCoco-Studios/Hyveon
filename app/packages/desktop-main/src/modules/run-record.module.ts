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
 * through. `AppModule` imports this module directly rather than declaring
 * `RunService`/`RunRecordService` as its own providers, so every consumer
 * shares the exact same singletons — a duplicate provider declaration would
 * split `RunService`'s in-memory `currentLock` state across two injectors.
 *
 * Also binds `RUN_RECORD_PERSISTER` and `RUN_LOCK_SERVICE` (narrow DI tokens
 * documented at their own declarations in `PulumiService.ts`) to the real
 * `RunRecordService`/`RunService` singletons via `useExisting`, and exports
 * both tokens.
 *
 * ## Canonical note: why `PulumiServiceModule` does NOT import this module
 *
 * This module imports `ConfigModule`, and `ConfigModule` imports
 * `PulumiServiceModule`, so a static `imports:` edge back from
 * `PulumiServiceModule` to here would create a
 * `PulumiServiceModule` → `RunRecordModule` → `ConfigModule` →
 * `PulumiServiceModule` cycle. This project runs as native ESM
 * (`module: "ESNext"`), and native ESM's strict temporal-dead-zone
 * semantics make `forwardRef()`-guarded module cycles unreliable here.
 *
 * Instead, `PulumiService` takes `ModuleRef` (no relation to this cycle, so
 * it creates no new edge) and resolves `RUN_RECORD_PERSISTER`/
 * `REMOTE_FILE_STORE` lazily inside `preview()` — see `PulumiService.ts`'s
 * `getRunRecordPersister`/`getRemoteFileStore`. A strict-false
 * `ModuleRef.get()` searches the whole provider container rather than
 * following a compile-time edge, so as long as *some* module reachable from
 * `AppModule` (this one) provides `RUN_RECORD_PERSISTER`, `PulumiService`
 * finds the same singleton every other consumer uses — without
 * `ConfigModule`/`PulumiServiceModule`/`CloudProviderModule` ever forming a
 * cycle. `config.module.ts` and `cloud-provider.module.ts` link back here
 * rather than repeating this.
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
