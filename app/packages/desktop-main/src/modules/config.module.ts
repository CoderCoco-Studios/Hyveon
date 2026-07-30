import { Module } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { PulumiServiceModule } from './pulumi-service.module.js';

/**
 * Standalone module for `ConfigService`, the terraform-state-backed
 * configuration reader shared across the app. Extracted so any feature
 * module (e.g. a future `CloudProviderModule`) can `imports: [ConfigModule]`
 * and receive `ConfigService` via Nest DI without depending on `AwsModule`,
 * which historically bundled it alongside every AWS-facing service.
 *
 * Imports `ElectronStoreModule` because `ConfigService.getConfigurationBucket()`
 * reads `bootstrap.configurationBucket` from `ElectronStoreService` (see that
 * method's TSDoc) — `ElectronStoreModule` has no dependencies of its own, so
 * this creates no circular import. Imports `PulumiServiceModule` (task 7.4)
 * for `PulumiService`, which `ConfigService.getStackOutputs()` delegates to —
 * `PulumiServiceModule` doesn't import `ConfigModule` (or anything that
 * transitively does), so this creates no circular import either.
 */
@Module({
  imports: [ElectronStoreModule, PulumiServiceModule],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
