import { Module } from '@nestjs/common';
import { PulumiWorkspaceService } from '../services/PulumiWorkspaceService.js';
import { PulumiEngineModule } from './pulumi-engine.module.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Feature module for `PulumiWorkspaceService` — the Automation API
 * workspace/backend/passphrase seam. Imports `PulumiEngineModule` for the
 * resolved `PulumiCommand` it builds `LocalWorkspaceOptions` around, and
 * `ElectronStoreModule` for the encrypted passphrase accessor pair (and the
 * `SafeStorageService` availability check that gates generating one).
 *
 * Kept separate from `PulumiEngineModule` because engine provisioning and
 * workspace construction are independently useful and independently
 * testable: a caller that only needs the resolved engine version (e.g. a
 * Settings display) has no reason to pull in
 * `ElectronStoreService`/`SafeStorageService`.
 *
 * Has no controller of its own — `PulumiService` is the real caller of
 * `getOrCreateStack`, and `IacController` exposes the resulting operations
 * over IPC. Construction is synchronous and does no I/O (see
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
