import { Module } from '@nestjs/common';
import { RunRecordService } from '../services/RunRecordService.js';
import { RunService } from '../services/RunService.js';
import { RUN_LOCK_SERVICE, RUN_RECORD_PERSISTER } from '../services/PulumiService.js';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';

/**
 * Feature module for `RunService` (the in-memory + DynamoDB apply lock
 * guarding plan/apply/destroy submissions) and `RunRecordService` (the
 * inline-vs-offload run-history persistence facade `PulumiService` writes
 * run records through). Neither service is Pulumi-specific — both predate
 * the Terraform-to-Pulumi engine swap. Declaring them here, rather than as
 * providers duplicated in each consumer module, ensures every consumer
 * shares the exact same singletons — two separate module-level provider
 * declarations for the same class would create two independent instances,
 * splitting `RunService`'s in-memory `currentLock` state and breaking the
 * "only one lock in-process" invariant.
 *
 * Also binds `RUN_RECORD_PERSISTER` (`PulumiService.ts`'s narrow DI token
 * for the slice of `RunRecordService.persist`/`.getByRunId` that
 * `preview()`/`apply()` depend on) to the real `RunRecordService` singleton
 * via `useExisting`, and `RUN_LOCK_SERVICE` (the narrow token for the slice
 * of `RunService.createRun` `apply()`'s gate depends on) to the real
 * `RunService` singleton, and exports both tokens.
 *
 * ## Why `PulumiServiceModule` does NOT import this module
 *
 * This module imports `ConfigModule` (for `RunService`/`RunRecordService`'s
 * own `ConfigService` dependency), and `ConfigModule` imports
 * `PulumiServiceModule` (for `ConfigService.getStackOutputs()`'s delegate)
 * — so a `PulumiServiceModule` → `RunRecordModule` import would close a
 * `PulumiServiceModule` → `RunRecordModule` → `ConfigModule` →
 * `PulumiServiceModule` static import cycle.
 *
 * `forwardRef()` on every edge in the cycle was tried and, empirically,
 * still deadlocked the real module graph at boot: booting
 * `NestFactory.createApplicationContext` against the compiled output hung
 * indefinitely with no error. This project compiles to native ESM
 * (`module: "ESNext"`), whose strict temporal-dead-zone semantics make
 * `forwardRef()`-guarded module cycles measurably less reliable here than
 * in the CJS-targeted examples Nest's own docs demonstrate the pattern
 * against.
 *
 * Instead, `PulumiService` takes `ModuleRef` (a core Nest primitive
 * unrelated to this cycle, so injecting it creates no new edge) and
 * resolves `RUN_RECORD_PERSISTER`/`REMOTE_FILE_STORE` lazily inside
 * `preview()` via `ModuleRef.get(token, { strict: false })` — a runtime
 * search across the whole application container rather than a compile-time
 * `imports:` edge. This works as long as *some* module reachable from
 * `AppModule` provides the token, so `PulumiServiceModule` never needs a
 * static `imports:` edge back to this module, and `ConfigModule`/
 * `PulumiServiceModule`/`CloudProviderModule` never form a cycle at all.
 * `config.module.ts`/`cloud-provider.module.ts` rely on the same pattern.
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
