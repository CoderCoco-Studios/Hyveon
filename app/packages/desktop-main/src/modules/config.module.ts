import { Module } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { CONFIG_CACHE_INVALIDATOR } from '../services/PulumiService.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { PulumiServiceModule } from './pulumi-service.module.js';

/**
 * Standalone module for `ConfigService`, the Pulumi-stack-outputs-backed
 * configuration reader shared across the app. Extracted so any feature
 * module can `imports: [ConfigModule]` and receive `ConfigService` via Nest
 * DI without pulling in `AwsModule`'s other AWS-facing services.
 *
 * Module-cycle rationale (why `PulumiService` doesn't just take
 * `ConfigService`/`RunRecordService` as constructor deps): see the canonical
 * explanation in {@link RunRecordModule}.
 *
 * This module binds `CONFIG_CACHE_INVALIDATOR` (`PulumiService.ts`'s narrow
 * DI token for just `invalidateCache()`) to the real `ConfigService`
 * singleton via `useExisting` and exports it, so `PulumiService.apply` can
 * resolve it lazily via a strict-false `ModuleRef.get()` lookup after a
 * successful apply, without a constructor edge back to this module.
 */
@Module({
  imports: [ElectronStoreModule, PulumiServiceModule],
  providers: [ConfigService, { provide: CONFIG_CACHE_INVALIDATOR, useExisting: ConfigService }],
  exports: [ConfigService, CONFIG_CACHE_INVALIDATOR],
})
export class ConfigModule {}
