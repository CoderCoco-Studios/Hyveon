import { Module } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { CONFIG_CACHE_INVALIDATOR } from '../services/PulumiService.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { PulumiServiceModule } from './pulumi-service.module.js';

/**
 * Standalone module for `ConfigService`. Extracted so any feature module can
 * `imports: [ConfigModule]` and receive `ConfigService` via Nest DI without
 * depending on `AwsModule`, which historically bundled it alongside every
 * AWS-facing service.
 *
 * Imports `ElectronStoreModule` for `ConfigService.getConfigurationBucket()`'s
 * `bootstrap.configurationBucket` read, and `PulumiServiceModule` for
 * `PulumiService`, which `ConfigService.getStackOutputs()` delegates to.
 * Both are leaf-ish imports unrelated to `ConfigModule`, so neither creates
 * a circular import.
 *
 * Binds `CONFIG_CACHE_INVALIDATOR` (`PulumiService.ts`'s narrow DI token for
 * just `invalidateCache()`) to the real `ConfigService` singleton via
 * `useExisting` and exports it, so `PulumiService.apply` can resolve it
 * lazily via `ModuleRef.get(CONFIG_CACHE_INVALIDATOR, { strict: false })` to
 * invalidate the cache on a successful apply. `PulumiService` cannot take
 * `ConfigService` as a normal constructor dependency for this — doing so
 * would close a module cycle back through `PulumiServiceModule`, which this
 * module imports (see `run-record.module.ts` for the full explanation of
 * that cycle and why `ModuleRef` lookups are used instead of static
 * `imports:` edges here).
 */
@Module({
  imports: [ElectronStoreModule, PulumiServiceModule],
  providers: [ConfigService, { provide: CONFIG_CACHE_INVALIDATOR, useExisting: ConfigService }],
  exports: [ConfigService, CONFIG_CACHE_INVALIDATOR],
})
export class ConfigModule {}
