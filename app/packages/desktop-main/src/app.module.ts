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
import { CostsController } from './controllers/costs.controller.js';
import { LogsController } from './controllers/logs.controller.js';
import { FilesController } from './controllers/files.controller.js';
import { DiscordController } from './controllers/discord.controller.js';
import { EnvController } from './controllers/env.controller.js';
import { DiagnosticsController } from './controllers/diagnostics.controller.js';
import { DriftController } from './controllers/drift.controller.js';
import { AuditController } from './controllers/audit.controller.js';
import { IacController } from './controllers/iac.controller.js';
import { IacRunsController } from './controllers/iac-runs.controller.js';
import { IacSettingsController } from './controllers/iac-settings.controller.js';
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
 * `PulumiServiceModule` is the module `IacController`/`IacRunsController`
 * depend on directly for their orchestration calls, via `PulumiService`.
 *
 * `PulumiEngineModule`/`PulumiWorkspaceModule` have no controller of their
 * own yet — there is no IPC bridge surfacing them to the renderer (Settings'
 * resolved-version display, the wizard's engine-provisioning step). They're
 * imported here regardless: both services' construction is synchronous and
 * never throws, so wiring them into the container ahead of their controller
 * costs nothing and exercises the "Container builds without an engine"
 * scenario for real, not just in their own unit tests.
 *
 * `RunRecordModule` is imported directly (not left to arrive transitively
 * via some other module) because `PulumiService.preview`/`.apply`/`.destroy`
 * resolve `RUN_RECORD_PERSISTER`/`RUN_LOCK_SERVICE` from it lazily at
 * runtime via `ModuleRef.get(token, { strict: false })` — a lookup that only
 * succeeds if the token is provided *somewhere* reachable from this root
 * module, with no static `imports:` edge of its own to prove it (see
 * `run-record.module.ts`'s doc comment for why that's a deliberate design).
 * This direct import keeps `RunRecordModule`'s presence in the graph
 * independent of any other module's own `imports:` list.
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
    CostsController,
    LogsController,
    FilesController,
    DiscordController,
    EnvController,
    DiagnosticsController,
    DriftController,
    AuditController,
    IacController,
    IacRunsController,
    IacSettingsController,
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
