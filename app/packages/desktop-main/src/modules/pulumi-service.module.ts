import { Module } from '@nestjs/common';
import { PulumiService } from '../services/PulumiService.js';
import { PulumiEngineModule } from './pulumi-engine.module.js';
import { PulumiWorkspaceModule } from './pulumi-workspace.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiService`.
 *
 * Imports `PulumiWorkspaceModule` for the `getOrCreateStack` seam
 * `getStackOutputs()`/`preview()` read through, and `ElectronStoreModule`
 * for the `bootstrap.stateBucket` / `pulumi.passphrase` / `aws.region`
 * presence checks that let a never-deployed stack degrade to `null` without
 * ever invoking Pulumi (see `PulumiService.getStackOutputs`'s doc comment).
 *
 * `ConfigModule` imports this module so `ConfigService.getStackOutputs()`
 * can inject `PulumiService`.
 *
 * Also imports `PulumiEngineModule` directly — `PulumiService.apply`'s
 * `PulumiEngineService` constructor dependency, needed for the gate's
 * engine-version check. This is an ordinary, non-cyclic `imports:` edge:
 * `PulumiEngineModule` has no dependencies of its own (see its own doc
 * comment), unlike `RunRecordModule`/`ConfigModule` below, which would close
 * a cycle if imported statically.
 *
 * **Deliberately does NOT import `RunRecordModule`/`CloudProviderModule`**,
 * even though `PulumiService.preview()` depends on
 * `RunRecordService`/`REMOTE_FILE_STORE`, both provided by those modules.
 * Both are reachable from `ConfigModule` (which this module is imported
 * *by*), so a static edge here would close a module cycle — a `forwardRef()`
 * edge still deadlocks this project's native-ESM module graph at boot.
 * `PulumiService` instead resolves both lazily via
 * `ModuleRef.get(token, { strict: false })` at call time — see
 * `run-record.module.ts`'s doc comment for the full story, and
 * `PulumiService.ts`'s `getRunRecordPersister`/`getRemoteFileStore`.
 * `ModuleRef` is a core Nest primitive injectable without any module wiring
 * of its own, so this module's import list stays minimal.
 *
 * **Also deliberately does NOT import `DeploymentConfigModule`**, for the identical
 * reason: `PulumiService.confirmRollback`'s `DeploymentConfigRestorer`/`DEPLOYMENT_CONFIG_SERVICE`
 * dependency. `DeploymentConfigModule` imports `ConfigModule`/`CloudProviderModule`,
 * both upstream of this module in the same cycle shape described above.
 * `DeploymentConfigModule` is already imported directly by `app.module.ts`, so
 * `DEPLOYMENT_CONFIG_SERVICE` is reachable via the same
 * `ModuleRef.get(token, { strict: false })` lookup — see
 * `PulumiService.ts`'s `getDeploymentConfigService` and `deployment-config.module.ts`'s own doc
 * comment.
 */
@Module({
  imports: [PulumiWorkspaceModule, PulumiEngineModule, ElectronStoreModule],
  providers: [PulumiService],
  exports: [PulumiService],
})
export class PulumiServiceModule {}
