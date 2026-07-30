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
 * `PulumiServiceModule` imports only `PulumiWorkspaceModule`/`ElectronStoreModule`
 * (leaf-ish modules unrelated to `ConfigModule`), so this stays a plain,
 * non-circular import.
 *
 * **Considered and rejected: a static import cycle for task 7.1.** An
 * earlier version of `PulumiService.preview()` (`migrate-iac-to-pulumi`
 * task 7.1) took `RunRecordService`/`REMOTE_FILE_STORE` as constructor
 * dependencies resolved through `PulumiServiceModule`'s own `imports:`,
 * which would have required `PulumiServiceModule` to import
 * `RunRecordModule`/`CloudProviderModule` — both reachable from
 * `ConfigModule` — closing a cycle back through this exact module.
 * `forwardRef()` on every edge in that cycle was tried and, empirically
 * (this project runs as native ESM, which enforces the temporal dead zone
 * strictly), still deadlocked the real module graph at boot. `preview()`
 * resolves both dependencies lazily via `ModuleRef.get(token, { strict: false })`
 * instead (see `PulumiService.ts`) — a runtime lookup across the whole
 * application container, not a static `imports:` edge — so this module
 * never needs to be part of any cycle at all. See `run-record.module.ts`'s
 * doc comment for the full story.
 */
@Module({
  imports: [ElectronStoreModule, PulumiServiceModule],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
