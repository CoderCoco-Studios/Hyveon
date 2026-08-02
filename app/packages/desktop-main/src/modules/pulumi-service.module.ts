import { Module } from '@nestjs/common';
import { PulumiService } from '../services/PulumiService.js';
import { PulumiEngineModule } from './pulumi-engine.module.js';
import { PulumiWorkspaceModule } from './pulumi-workspace.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiService`, `TerraformService.ts`'s successor.
 *
 * Imports `PulumiWorkspaceModule` for the `getOrCreateStack` seam
 * `getStackOutputs()`/`preview()` read through, and `ElectronStoreModule`
 * for the `bootstrap.stateBucket` / `pulumi.passphrase` / `aws.region`
 * presence checks that let a never-deployed stack degrade to `null` without
 * ever invoking Pulumi (see `PulumiService.getStackOutputs`'s doc comment).
 * Also imports `PulumiEngineModule` directly for `PulumiService.apply`'s
 * `PulumiEngineService` constructor dependency (the gate's engine-version
 * check) — an ordinary, non-cyclic `imports:` edge, since `PulumiEngineModule`
 * has no dependencies of its own.
 *
 * `ConfigModule` imports this module so `ConfigService.getStackOutputs()`
 * can inject `PulumiService`.
 *
 * **Deliberately does NOT import `RunRecordModule`/`CloudProviderModule`/
 * `TfvarsModule`**, even though `PulumiService.preview()`/`.apply()`/
 * `.confirmRollback()` depend on services those modules provide
 * (`RunRecordService`, `REMOTE_FILE_STORE`, `TFVARS_SERVICE`). All three are
 * reachable from `ConfigModule` (which this module is imported *by*), so a
 * static edge to any of them here would close a module cycle — `forwardRef()`
 * on every edge was tried and, empirically, still deadlocked this project's
 * native-ESM module graph at boot. `PulumiService` instead resolves those
 * dependencies lazily via `ModuleRef.get(token, { strict: false })` at call
 * time — see `run-record.module.ts`'s doc comment for the full explanation,
 * and `PulumiService.ts`'s `getRunRecordPersister`/`getRemoteFileStore`/
 * `getTfvarsService`. `ModuleRef` is a core Nest primitive injectable
 * without any module wiring, so this keeps `PulumiServiceModule`'s own
 * import list minimal.
 */
@Module({
  imports: [PulumiWorkspaceModule, PulumiEngineModule, ElectronStoreModule],
  providers: [PulumiService],
  exports: [PulumiService],
})
export class PulumiServiceModule {}
