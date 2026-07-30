import { Module } from '@nestjs/common';
import { PulumiService } from '../services/PulumiService.js';
import { PulumiWorkspaceModule } from './pulumi-workspace.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiService` (Phase 7 of the `migrate-iac-to-pulumi`
 * change — `TerraformService.ts`'s eventual successor). This dispatch (tasks
 * 7.4/7.8/7.9) only wires up `getStackOutputs()` and the ported error
 * classes; `preview`/`up`/`destroy` (tasks 7.1-7.3) land in later dispatches
 * on the same provider.
 *
 * Imports `PulumiWorkspaceModule` for the `getOrCreateStack` seam
 * `getStackOutputs()` reads through, and `ElectronStoreModule` for the
 * `bootstrap.stateBucket` / `pulumi.passphrase` / `aws.region` presence
 * checks that let a never-deployed stack degrade to `null` without ever
 * invoking Pulumi (see `PulumiService.getStackOutputs`'s doc comment).
 *
 * `ConfigModule` imports this module so `ConfigService.getStackOutputs()`
 * (the thin delegate every existing `getTfOutputs()` call site now calls)
 * can inject `PulumiService` — see `ConfigService`'s own doc comment for why
 * the read is exposed there rather than requiring every one of
 * `getTfOutputs()`'s ~14 call sites to take a new `PulumiService`
 * constructor dependency directly.
 */
@Module({
  imports: [PulumiWorkspaceModule, ElectronStoreModule],
  providers: [PulumiService],
  exports: [PulumiService],
})
export class PulumiServiceModule {}
