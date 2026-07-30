import { Module } from '@nestjs/common';
import { PulumiWorkspaceService } from '../services/PulumiWorkspaceService.js';
import { PulumiEngineModule } from './pulumi-engine.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiWorkspaceService` — the Automation API
 * workspace/backend/passphrase seam (Tasks 4.3/4.4 of the
 * `migrate-iac-to-pulumi` change). Imports `PulumiEngineModule` for the
 * resolved `PulumiCommand` it builds `LocalWorkspaceOptions` around, and
 * `ElectronStoreModule` for the encrypted passphrase accessor pair (and the
 * `SafeStorageService` availability check that gates generating one).
 *
 * Kept separate from `PulumiEngineModule` — mirroring that module's own doc
 * comment, which explicitly deferred this seam to "Phase 4.3/4.4, not this
 * module's [job]" — because engine provisioning and workspace construction
 * are independently useful and independently testable: a caller that only
 * needs the resolved engine version (e.g. a future Settings display) has no
 * reason to pull in `ElectronStoreService`/`SafeStorageService`.
 *
 * Like `PulumiEngineModule`, this has no controller yet — the IPC surface is
 * Phase 8-10's job, and Phase 7's `PulumiService` is the first real caller of
 * `getOrCreateStack`. Construction is synchronous and does no I/O (see
 * `PulumiWorkspaceService`'s class doc comment), so wiring it into
 * `AppModule` ahead of any consumer costs nothing, mirroring
 * `PulumiEngineModule`'s own precedent.
 */
@Module({
  imports: [PulumiEngineModule, ElectronStoreModule],
  providers: [PulumiWorkspaceService],
  exports: [PulumiWorkspaceService],
})
export class PulumiWorkspaceModule {}
