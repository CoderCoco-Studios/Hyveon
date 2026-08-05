import { Module } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { CONFIG_CACHE_INVALIDATOR } from '../services/PulumiService.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { PulumiServiceModule } from './pulumi-service.module.js';

/**
 * Standalone module for `ConfigService`, the Pulumi-stack-outputs-backed
 * configuration reader shared across the app. Extracted so any feature
 * module (e.g. a future `CloudProviderModule`) can `imports: [ConfigModule]`
 * and receive `ConfigService` via Nest DI without pulling in `AwsModule`'s
 * other AWS-facing services (ECS, EC2, CloudWatch Logs, Cost Explorer).
 *
 * Imports `ElectronStoreModule` because `ConfigService.getConfigurationBucket()`
 * reads `bootstrap.configurationBucket` from `ElectronStoreService` (see that
 * method's TSDoc) — `ElectronStoreModule` has no dependencies of its own, so
 * this creates no circular import. Imports `PulumiServiceModule` for
 * `PulumiService`, which `ConfigService.getStackOutputs()` delegates to —
 * `PulumiServiceModule` imports only `PulumiWorkspaceModule`/`ElectronStoreModule`
 * (leaf-ish modules unrelated to `ConfigModule`), so this stays a plain,
 * non-circular import.
 *
 * `PulumiService.preview()` needs `RunRecordService`/`REMOTE_FILE_STORE`,
 * both reachable only through `RunRecordModule`/`CloudProviderModule` —
 * which are themselves reachable from `ConfigModule`. Taking either as a
 * constructor dependency would require `PulumiServiceModule` to import those
 * modules, closing a cycle back through this exact module — `forwardRef()`
 * does not fix it, since this project runs as native ESM, which enforces the
 * temporal dead zone strictly and deadlocks the real module graph at boot.
 * `preview()` instead resolves both dependencies lazily via
 * `ModuleRef.get(token, { strict: false })` (see `PulumiService.ts`) — a
 * runtime lookup across the whole application container, not a static
 * `imports:` edge — so this module never needs to be part of any cycle at
 * all. See `run-record.module.ts`'s doc comment for the full story.
 *
 * `PulumiService.apply` needs to call `ConfigService.invalidateCache()` on a
 * successful apply, but cannot take `ConfigService` as a constructor
 * dependency for the same reason `getStackOutputs()`'s own delegate can't be
 * reversed — doing so would recreate this exact cycle in the other
 * direction. This module instead binds `CONFIG_CACHE_INVALIDATOR`
 * (`PulumiService.ts`'s narrow DI token for just `invalidateCache()`) to the
 * real `ConfigService` singleton via `useExisting` and exports it, so
 * `PulumiService.apply` can resolve it lazily via
 * `ModuleRef.get(CONFIG_CACHE_INVALIDATOR, { strict: false })` — this file
 * importing a `Symbol` value from `PulumiService.ts` creates no new edge:
 * `PulumiService.ts` itself imports nothing from this module or from
 * `ConfigService.ts` (see `PulumiService.getConfigurationBucket`'s doc
 * comment).
 */
@Module({
  imports: [ElectronStoreModule, PulumiServiceModule],
  providers: [ConfigService, { provide: CONFIG_CACHE_INVALIDATOR, useExisting: ConfigService }],
  exports: [ConfigService, CONFIG_CACHE_INVALIDATOR],
})
export class ConfigModule {}
