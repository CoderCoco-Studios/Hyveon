import { Module } from '@nestjs/common';
import { PulumiEngineService } from '../services/PulumiEngineService.js';

/**
 * Feature module for `PulumiEngineService`, the app-managed Pulumi engine
 * provisioning seam (see its own file-level doc comment for the full
 * memoization/versioning/atomicity design). Construction is synchronous and
 * never throws — no filesystem or network work happens until `resolve()` is
 * first called — so, mirroring `TerraformModule`'s doc comment, this is
 * wired as a plain class provider rather than an async `useFactory`, and
 * `AppModule` can import this module unconditionally even on a machine with
 * no engine and no network (the "Container builds without an engine"
 * scenario in the `pulumi-engine-runtime` delta spec).
 *
 * `PulumiEngineService` has no constructor dependencies of its own — see its
 * `resolveUserDataPath()` doc comment for why it duplicates
 * `ConfigService`'s userData seam rather than injecting `ConfigService` — so
 * this module imports nothing else.
 *
 * The workspace/backend seam that will actually drive operations through the
 * resolved `PulumiCommand` (constructing the Automation API `LocalWorkspace`,
 * wiring `PULUMI_HOME`, the self-managed backend, and AWS credentials) is
 * Phase 4.3/4.4's job, not this module's.
 */
@Module({
  providers: [PulumiEngineService],
  exports: [PulumiEngineService],
})
export class PulumiEngineModule {}
