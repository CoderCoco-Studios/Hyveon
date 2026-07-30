import { Module } from '@nestjs/common';
import { PulumiService } from '../services/PulumiService.js';
import { PulumiWorkspaceModule } from './pulumi-workspace.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiService` (Phase 7 of the `migrate-iac-to-pulumi`
 * change — `TerraformService.ts`'s eventual successor). Tasks 7.4/7.8/7.9
 * wired up `getStackOutputs()` and the ported error classes; task 7.1 adds
 * `preview()`, the first method that needs run-history/config-store
 * infrastructure beyond the Automation API workspace seam.
 *
 * Imports `PulumiWorkspaceModule` for the `getOrCreateStack` seam
 * `getStackOutputs()`/`preview()` read through, and `ElectronStoreModule`
 * for the `bootstrap.stateBucket` / `pulumi.passphrase` / `aws.region`
 * presence checks that let a never-deployed stack degrade to `null` without
 * ever invoking Pulumi (see `PulumiService.getStackOutputs`'s doc comment).
 *
 * `ConfigModule` imports this module so `ConfigService.getStackOutputs()`
 * (the thin delegate every existing `getTfOutputs()` call site now calls)
 * can inject `PulumiService`.
 *
 * **Deliberately does NOT import `RunRecordModule`/`CloudProviderModule`**,
 * even though `PulumiService.preview()` (task 7.1) depends on
 * `RunRecordService`/`REMOTE_FILE_STORE`, both provided by those modules.
 * Both are reachable from `ConfigModule` (which this module is imported
 * *by*), so a static edge here would close a module cycle — tried via
 * `forwardRef()` on every edge and found, empirically, to still deadlock
 * this project's native-ESM module graph at boot. `PulumiService` instead
 * resolves both lazily via `ModuleRef.get(token, { strict: false })` at call
 * time — see `run-record.module.ts`'s doc comment for the full story, and
 * `PulumiService.ts`'s `getRunRecordPersister`/`getRemoteFileStore`. This
 * keeps `PulumiServiceModule`'s own import list exactly as small as it was
 * before task 7.1 — `ModuleRef` is a core Nest primitive injectable without
 * any module wiring at all, so this file needed no change to support it.
 */
@Module({
  imports: [PulumiWorkspaceModule, ElectronStoreModule],
  providers: [PulumiService],
  exports: [PulumiService],
})
export class PulumiServiceModule {}
