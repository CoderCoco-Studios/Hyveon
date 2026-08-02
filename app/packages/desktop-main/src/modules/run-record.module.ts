import { Module } from '@nestjs/common';
import { RunRecordService } from '../services/RunRecordService.js';
import { RunService } from '../services/RunService.js';
import { RUN_LOCK_SERVICE, RUN_RECORD_PERSISTER } from '../services/PulumiService.js';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';

/**
 * Feature module for `RunService` (the in-memory + DynamoDB apply lock
 * guarding `terraform`/Pulumi plan/apply/destroy submissions, issue #106)
 * and `RunRecordService` (the inline-vs-offload run-history persistence
 * facade both `TerraformService.ts` and `PulumiService.preview` — task 7.1,
 * `migrate-iac-to-pulumi` — write their run records through). Extracted
 * from `terraform.module.ts` into its own module because neither service is
 * Terraform- or Pulumi-specific — they predate the engine swap and are
 * generic run-history/lock services; this extraction corrects
 * `terraform.module.ts`'s pre-migration module boundary rather than adding
 * a new one. `terraform.module.ts` now imports this module too, instead of
 * declaring `RunService`/`RunRecordService` as its own providers, so both
 * `TerraformService` and `PulumiService` share the exact same singletons —
 * two separate module-level provider declarations for the same class would
 * otherwise create two independent instances, one per module's injector,
 * splitting `RunService`'s in-memory `currentLock` state across them and
 * breaking the "only one lock in-process" invariant.
 *
 * Also binds `RUN_RECORD_PERSISTER` (`PulumiService.ts`'s narrow DI token
 * for the slice of `RunRecordService.persist`/`.getByRunId`'s surface
 * `preview()`/`apply()` depend on — see that token's own doc comment) to the
 * real `RunRecordService` singleton via `useExisting`, and `RUN_LOCK_SERVICE`
 * (task 7.2's narrow DI token for the slice of `RunService.createRun`
 * `apply()`'s gate step 8 depends on — see that token's own doc comment) to
 * the real `RunService` singleton, and exports both tokens.
 *
 * ## Why `PulumiServiceModule` does NOT import this module (a `ModuleRef`
 * lookup instead of a static edge)
 *
 * The obvious design — `pulumi-service.module.ts` imports this module so
 * `PulumiService`'s constructor can take `RUN_RECORD_PERSISTER` as a normal
 * injected dependency — was tried first and does not work in this codebase.
 * This module imports `ConfigModule` (for `RunService`/`RunRecordService`'s
 * own `ConfigService` dependency), and `ConfigModule` imports
 * `PulumiServiceModule` (task 7.4, for `ConfigService.getStackOutputs()`'s
 * delegate) — so a `PulumiServiceModule` → `RunRecordModule` → `ConfigModule`
 * → `PulumiServiceModule` static import cycle would exist for as long as
 * `PulumiServiceModule` imports this module.
 *
 * Nest's documented fix for a module cycle is `forwardRef()` on the
 * circular edges. That was implemented — every edge in the cycle wrapped,
 * including ones not obviously part of it (`cloud-provider.module.ts`'s own
 * `ConfigModule` import, since `CloudProviderModule` is also reachable from
 * this module) — and **empirically, it still deadlocked**: booting the real
 * module graph (`NestFactory.createApplicationContext` against the actual
 * compiled output, not a mocked test) hung indefinitely partway through
 * instance-loader initialization, with no error and no further log output.
 * This project compiles to `module: "ESNext"` and runs as native ESM, not a
 * bundler-transpiled CommonJS namespace object — native ESM's strict
 * temporal-dead-zone semantics (confirmed separately: an *earlier* attempt
 * that wrapped fewer edges threw a `ReferenceError` — "Cannot access
 * 'ConfigModule' before initialization" — from deep inside the cycle, rather
 * than hanging) make `forwardRef()`-guarded module cycles measurably less
 * reliable here than in the CJS-targeted examples Nest's own documentation
 * demonstrates the pattern against. Rather than continue widening the set
 * of `forwardRef()`-wrapped edges on faith that "one more" will finally
 * close the gap, this dispatch replaced the static edge with Nest's other
 * documented escape hatch for circular dependencies: a strict-false
 * `ModuleRef.get()` lookup, a runtime search across the *entire*
 * application's provider container rather than a compile-time `imports:`
 * edge.
 * `PulumiService` takes `ModuleRef` (a core Nest primitive with no relation
 * to any module in this cycle, so injecting it creates no new edge at all)
 * and resolves `RUN_RECORD_PERSISTER`/`REMOTE_FILE_STORE` lazily inside
 * `preview()` itself — see `PulumiService.ts`'s `getRunRecordPersister`/
 * `getRemoteFileStore`. This works because `strict: false` searches the
 * whole application container (not just the calling module's own imported
 * scope), so as long as *some* module reachable from the real `AppModule`
 * (this one, via `terraform.module.ts`) provides `RUN_RECORD_PERSISTER`,
 * `PulumiService` finds the same singleton every other consumer of
 * `RunRecordService` uses — without `PulumiServiceModule` ever needing a
 * static `imports:` edge back to this module, and therefore without
 * `ConfigModule`/`PulumiServiceModule`/`CloudProviderModule` ever being part
 * of a cycle at all. `config.module.ts`/`cloud-provider.module.ts` both
 * document the same conclusion from their own side.
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
