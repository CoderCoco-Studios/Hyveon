import { Module } from '@nestjs/common';
import { PulumiService } from '../services/PulumiService.js';
import { PulumiEngineModule } from './pulumi-engine.module.js';
import { PulumiWorkspaceModule } from './pulumi-workspace.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiService`.
 *
 * Imports `PulumiWorkspaceModule` for the `getOrCreateStack` seam
 * `getStackOutputs()`/`preview()` read through, `ElectronStoreModule` for
 * the bootstrap-config presence checks that let a never-deployed stack
 * degrade to `null` (see `PulumiService.getStackOutputs`'s doc comment),
 * and `PulumiEngineModule` for the engine-version check in `apply`'s gate.
 *
 * Module-cycle rationale (why this module does NOT import
 * `RunRecordModule`/`CloudProviderModule`, and resolves
 * `RunRecordService`/`REMOTE_FILE_STORE` lazily via `ModuleRef` instead):
 * see the canonical explanation in {@link RunRecordModule}.
 *
 * Same reasoning applies to `DeploymentConfigModule`: `PulumiService.confirmRollback`
 * needs `DeploymentConfigRestorer`/`DEPLOYMENT_CONFIG_SERVICE`, but
 * `DeploymentConfigModule` imports `ConfigModule`/`CloudProviderModule` —
 * upstream of this module in the same cycle shape — so it's resolved lazily
 * too; see `PulumiService.ts`'s `getDeploymentConfigService`.
 */
@Module({
  imports: [PulumiWorkspaceModule, PulumiEngineModule, ElectronStoreModule],
  providers: [PulumiService],
  exports: [PulumiService],
})
export class PulumiServiceModule {}
