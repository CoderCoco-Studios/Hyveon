import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { Module } from '@nestjs/common';
import { AwsModule } from './modules/aws.module.js';
import { DiscordModule } from './modules/discord.module.js';
import { TfvarsModule } from './modules/tfvars.module.js';
import { RunRecordModule } from './modules/run-record.module.js';
import { PulumiEngineModule } from './modules/pulumi-engine.module.js';
import { PulumiWorkspaceModule } from './modules/pulumi-workspace.module.js';
import { PulumiServiceModule } from './modules/pulumi-service.module.js';
import { WizardModule } from './modules/wizard.module.js';
import { ElectronStoreModule } from './modules/electron-store.module.js';
import { GamesController } from './controllers/games.controller.js';
import { ConfigController } from './controllers/config.controller.js';
import { CostsController } from './controllers/costs.controller.js';
import { LogsController } from './controllers/logs.controller.js';
import { FilesController } from './controllers/files.controller.js';
import { DiscordController } from './controllers/discord.controller.js';
import { EnvController } from './controllers/env.controller.js';
import { DiagnosticsController } from './controllers/diagnostics.controller.js';
import { DriftController } from './controllers/drift.controller.js';
import { AuditController } from './controllers/audit.controller.js';
import { TerraformController } from './controllers/terraform.controller.js';
import { TerraformRunsController } from './controllers/terraform-runs.controller.js';
import { WizardController } from './controllers/wizard.controller.js';
import { DiagnosticsService, DIAGNOSTICS_LOG_DIR } from './services/DiagnosticsService.js';
import { DriftService } from './services/DriftService.js';
import { GamesWriteService } from './services/GamesWriteService.js';
import { AuditService } from './services/AuditService.js';

/**
 * Root Nest module. Wires the feature modules (`AwsModule`, `DiscordModule`,
 * `TfvarsModule`, `RunRecordModule`, `PulumiEngineModule`,
 * `PulumiWorkspaceModule`, `PulumiServiceModule`, `WizardModule`,
 * `ElectronStoreModule`) to the IPC controllers.
 *
 * Task 7.10 (`migrate-iac-to-pulumi`) deleted `TerraformModule`/
 * `TerraformService.ts` and repointed `TerraformController`/
 * `TerraformRunsController` onto `PulumiService` — `PulumiServiceModule`
 * replaces `TerraformModule` in this list as the module those two
 * controllers now depend on directly for their orchestration calls.
 *
 * `PulumiEngineModule`/`PulumiWorkspaceModule` have no controller of their
 * own yet — the IPC bridge that surfaces them to the renderer (Settings'
 * resolved-version display, the wizard's engine-provisioning step) is Phase
 * 8-10's job. They're imported here regardless: both services' construction
 * is synchronous and never throws, so wiring them into the container ahead
 * of their controller costs nothing and exercises the "Container builds
 * without an engine" scenario for real, not just in their own unit tests.
 *
 * `RunRecordModule` is imported directly (not left to arrive transitively
 * via some other module that also imports it) specifically because
 * `PulumiService.preview`/`.apply`/`.destroy` resolve `RUN_RECORD_PERSISTER`/
 * `RUN_LOCK_SERVICE` from it lazily at runtime via
 * `ModuleRef.get(token, { strict: false })` — a lookup that only succeeds if
 * the token is provided *somewhere* reachable from this root module, with no
 * static `imports:` edge of its own to prove it (see `run-record.module.ts`'s
 * doc comment for why that's a deliberate design, not an oversight). This
 * import makes `RunRecordModule`'s presence independent of any other
 * module's own `imports:` list — the exact property that mattered when
 * `TerraformModule` (which also imported `RunRecordModule`) was deleted by
 * task 7.10: this direct import meant that deletion didn't silently drop
 * `RunRecordModule` out of the graph too.
 */
@Module({
  imports: [
    AwsModule,
    DiscordModule,
    TfvarsModule,
    RunRecordModule,
    PulumiEngineModule,
    PulumiWorkspaceModule,
    PulumiServiceModule,
    WizardModule,
    ElectronStoreModule,
  ],
  controllers: [
    GamesController,
    ConfigController,
    CostsController,
    LogsController,
    FilesController,
    DiscordController,
    EnvController,
    DiagnosticsController,
    DriftController,
    AuditController,
    TerraformController,
    TerraformRunsController,
    WizardController,
  ],
  providers: [
    {
      provide: DIAGNOSTICS_LOG_DIR,
      useFactory: () => {
        if (!process.versions['electron']) {
          return process.env['DIAGNOSTICS_LOG_DIR'] ?? os.tmpdir();
        }
        const _require = createRequire(import.meta.url);
        const { app } = _require('electron') as { app: { getPath(name: string): string } };
        return path.join(app.getPath('userData'), 'logs');
      },
    },
    DiagnosticsService,
    DriftService,
    GamesWriteService,
    AuditService,
  ],
})
export class AppModule {}
