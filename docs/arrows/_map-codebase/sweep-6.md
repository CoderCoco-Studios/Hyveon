# Sweep 6 — `app/packages/desktop-main/` (excluding `src/services/`)

Scope: `git ls-files app/packages/desktop-main | grep -v '^app/packages/desktop-main/src/services/'` — 82 files. All paths below are relative to the repo root. Non-test source files were read in full; test files were read through their imports/setup/mocks and full `describe`/`it` lists (bodies spot-read where a case looked unusual).

## app/packages/desktop-main (package root)

```yaml
- path: app/packages/desktop-main/package.json
  purpose: Workspace manifest for @hyveon/desktop-main (Electron main process + Nest IPC microservice).
  exports: package "main" ./dist/main.js; scripts dev (electron-vite dev with repo-root electron.vite.config.ts), build (tsc -b), start (electron ../../../out/main/index.js)
  dependencies: "@hyveon/cloud-aws|infra|shared" (*), @nestjs/common|core|microservices ^11.1.28, nestjs-electron-ipc-transport ^1.0.2, @pulumi/aws 7.39.0 + @pulumi/pulumi 3.255.0 (exact pins), AWS SDK v3 clients (cloudwatch-logs, dynamodb, ec2, ecs, iam, s3, scheduler, secrets-manager, sts, credential-providers, lib-dynamodb), electron-store, electron-updater, fix-path, winston + winston-daily-rotate-file, archiver, bcryptjs, selfsigned, undici, semver, class-validator/transformer, @grpc/proto-loader; dev: electron ^43.2.0, tsx, unzipper
  data_shapes: n/a
  side_effects: none
  role: config
  observations:
    - "type": "module" (package.json:5) — native ESM, which run-record.module.ts:28-30 cites as the reason forwardRef cycles are unreliable.
    - aws-sdk-client-mock and vitest are used by src/test-mocks/* and src/testing/* but are declared in app/package.json:20,31, not here.
    - Pulumi packages are exact-pinned (package.json:31-32) while everything else uses caret ranges.
    - "@grpc/proto-loader" is a direct dep with no import in this scope (memory notes say it's kept for the Electron e2e CI job).

- path: app/packages/desktop-main/tsconfig.json
  purpose: Project-reference tsconfig; emits src → dist.
  exports: n/a
  dependencies: ../../tsconfig.base.json; references shared, cloud-aws, infra
  data_shapes: n/a
  side_effects: none
  role: config
  observations:
    - Excludes only src/**/*.test.ts (tsconfig.json:8), so src/testing/*.ts and src/test-mocks/*.ts (which import vitest / aws-sdk-client-mock) compile into dist/. test-mocks is deliberately consumed from dist by @hyveon/web's e2e fixtures (mock-store.ts:13-15); testing/* landing in dist appears incidental.

- path: app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml
  purpose: CloudFormation template shell for first-run guided IAM bootstrap — deploy user, HyveonDeployAll + HyveonSelfRotate managed policies, bootstrap access key.
  exports: Parameter UserName (default "hyveon"); Outputs DeployUserName, HyveonDeployAllPolicyArn, AccessKeyId, SecretAccessKey
  dependencies: substituted by GuidedIamService (services/, out of scope) using generateHyveonDeployAllPolicy (app/packages/shared/src/iamPolicy.ts)
  data_shapes: placeholder tokens __HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__ (line 38) and __HYVEON_SELF_ROTATE_POLICY_DOCUMENT__ (line 55)
  side_effects: none (data file; creates IAM resources when submitted)
  role: config / IaC template
  observations:
    - Tokens are matched by literal string search; replacement MUST be single-line JSON.stringify output or the YAML flow scalar breaks (iam-bootstrap.yaml:20-29).
    - Access key uses DeletionPolicy RetainExceptOnCreate (line 73) so stack delete leaves the already-rotated key but a failed create still rolls back.
    - SecretAccessKey is emitted as a stack Output (line 87-89) — the bootstrap secret is readable from stack outputs by anyone with cloudformation:DescribeStacks.
    - Only HyveonDeployAllPolicyArn is output; HyveonSelfRotate's ARN is not (lines 77-89).
```

## app/packages/desktop-main/src (root files)

```yaml
- path: app/packages/desktop-main/src/main.ts
  purpose: Nest IPC microservice bootstrap; module-level side effects initialise PATH and the file logger.
  exports: bootstrap(): Promise<INestMicroservice>
  dependencies: AppModule, applyFixPath, BridgedElectronIPCTransport/registerIpcMainBridges, createLogger, RpcErrorMessageFilter; @nestjs/core NestFactory; electron (dynamic import)
  data_shapes: returns the Nest microservice app (used by electron-entry for DI lookups)
  side_effects: applyFixPath() at import (main.ts:12); throws if not Electron (18-23); top-level await import('electron') + createLogger(userData/logs) at import (25-26); app.listen(); registers ipcMain handlers via bridge
  role: bootstrap / entry
  observations:
    - Global filter registered before listen() (main.ts:49-51), then registerIpcMainBridges after listen (53).
    - Uses top-level await (main.ts:25), so importing this module is itself async and Electron-only.

- path: app/packages/desktop-main/src/electron-entry.ts
  purpose: Electron main-process entry — window creation, platform chrome, lifecycle, wiring Nest bootstrap + updater + WindowService.
  exports: resolveWindowIcon()
  dependencies: electron (app, BrowserWindow, Menu, shell), ./main.bootstrap, ./env (electronRendererUrl, isTestMode), ./updater.initUpdater, services ElectronStoreService, WindowService
  data_shapes: BrowserWindow options 1200x800, contextIsolation+sandbox, preload ../preload/preload.cjs
  side_effects: Menu.setApplicationMenu(null) at import (206); app.whenReady → bootstrap → initUpdater → createWindow; shell.openExternal for target=_blank links; app.quit on load failure / bootstrap failure / window-all-closed (non-darwin); console.error logging (not winston)
  role: entry point
  observations:
    - Hard-coded header colors #1a1d2e / #e1e4ed and height 56 must track app/packages/web/src/index.css and the h-14 header (electron-entry.ts:94-98,111) — "no runtime theme switching yet".
    - macOS traffic-light position recomputed on resize and zoom-changed using CSS-px (width / zoomFactor) vs 768 breakpoint (144-156); constants 252/20 derived from the w-60 sidebar (77-89).
    - Linux gets neither trafficLightPosition nor titleBarOverlay; renderer draws buttons (92). Memory notes a deferred plan to move Linux to native titleBarOverlay.
    - WindowService re-attached on macOS 'activate' so it doesn't hold a destroyed window (226-236).
    - initUpdater is .catch()-guarded even though it's designed never to reject (215-221).
    - Uses console.error rather than the winston logger (47, 197, 220, 239).

- path: app/packages/desktop-main/src/app.module.ts
  purpose: Root Nest module wiring feature modules, 16 IPC controllers, and loose providers.
  exports: AppModule
  dependencies: all modules/*.module.ts, all controllers/*.controller.ts, services DiagnosticsService (+DIAGNOSTICS_LOG_DIR), DiagnosticsBundleService, DriftService, GamesWriteService, GameWizardDraftService, AuditService, WindowService
  data_shapes: DIAGNOSTICS_LOG_DIR factory → userData/logs (Electron) or $DIAGNOSTICS_LOG_DIR ?? os.tmpdir() (Node)
  side_effects: lazy createRequire('electron') in the DIAGNOSTICS_LOG_DIR factory (98-105)
  role: Nest root module
  observations:
    - RunRecordModule imported explicitly so ModuleRef.get(..., {strict:false}) lookups from PulumiService resolve (app.module.ts:56-62).
    - Doc says PulumiEngineModule/PulumiWorkspaceModule "have no controller of their own yet" (48-50), but IacSettingsController now exposes engineVersion (iac-settings.controller.ts:210) — comment partially stale.
    - Seven services provided directly on AppModule rather than via feature modules (107-113).

- path: app/packages/desktop-main/src/ipc-main-bridge.ts
  purpose: Bridges every Nest @MessagePattern onto ipcMain.handle, normalizing errors to plain cloneable Errors.
  exports: SELF_BRIDGED_PATTERNS, BridgedElectronIPCTransport (extends ElectronIPCTransport), registerIpcMainBridges(transport)
  dependencies: nestjs-electron-ipc-transport, rxjs (firstValueFrom, isObservable), ./logger; electron ipcMain (dynamic)
  data_shapes: handler invoked as handler(payload, { evt }); Observable results unwrapped
  side_effects: ipcMain.removeHandler + ipcMain.handle per pattern; logger.error on handler failure
  role: IPC transport glue
  observations:
    - SELF_BRIDGED_PATTERNS (27-37) = logs.stream, logs.lambda.stream, iac.plan, iac.apply, iac.destroy, iac.rollback.confirm, iac.runs.logs, iac.stack.initialize, iac.settings.autoUpdate.download — must stay in sync with each controller's onModuleInit (implicit coupling; no compile-time check).
    - Comment at 99-100 says "This app has no NestJS exception filter anywhere", contradicted by RpcErrorMessageFilter (registered main.ts:49) and the same docblock's own line 117 — stale.
    - on()/unwrap() throw because Nest 11 made them abstract and the library targets Nest 8 (55-82).
    - Silent no-op outside Electron (124-128).

- path: app/packages/desktop-main/src/rpc-error-message.filter.ts
  purpose: Global catch-all RPC exception filter preserving the original error .message instead of Nest's "Internal server error".
  exports: RpcErrorMessageFilter
  dependencies: @nestjs/common Catch, rxjs throwError, errMessage (@hyveon/shared)
  data_shapes: any exception → Observable erroring with new Error(message)
  side_effects: none
  role: Nest exception filter
  observations:
    - Catches HttpException subclasses too (@Catch() with no args, line 25). BadRequestException({success,error}) thrown throughout controllers is reduced to errMessage(exception) — appears to yield Nest's derived message rather than the `error` field; the `{success:false,error}` body is lost at the IPC boundary (not verified at runtime).

- path: app/packages/desktop-main/src/logger.ts
  purpose: winston logger singleton; console-only until createLogger() upgrades it with a daily-rotating file transport.
  exports: logger (live `let` binding), createLogger(logDir), __testing { devPrintf }
  dependencies: winston, winston-daily-rotate-file
  data_shapes: file name main-%DATE%.log, YYYY-MM-DD, maxFiles 14d
  side_effects: writes log files under logDir; console output
  role: logging utility
  observations:
    - isDev = NODE_ENV !== 'production' evaluated at import (logger.ts:4); dev uses multi-line printf, prod uses JSON.
    - Reassigning an exported `let` (88) relies on ESM live bindings; CJS-bundled consumers would see the stale console-only logger.

- path: app/packages/desktop-main/src/env.ts
  purpose: Thin process.env accessors for the Electron entry.
  exports: isTestMode() (HYVEON_TEST_MODE === '1'), electronRendererUrl()
  dependencies: none
  data_shapes: n/a
  side_effects: none (reads env)
  role: utility
  observations:
    - WizardController has its own protected isTestMode() reading the same var (wizard.controller.ts:217-219) instead of importing env.isTestMode — duplicate.

- path: app/packages/desktop-main/src/fix-path-bootstrap.ts
  purpose: Applies fix-path so GUI-launched app inherits login-shell PATH (no-op on win32).
  exports: applyFixPath()
  dependencies: fix-path
  data_shapes: n/a
  side_effects: spawns a login shell and mutates process.env.PATH (non-Windows)
  role: bootstrap utility
  observations: none

- path: app/packages/desktop-main/src/app-version.ts
  purpose: Reads app.getVersion() lazily; 'unknown' outside Electron or on error.
  exports: readAppVersion()
  dependencies: node:module createRequire, electron (lazy)
  data_shapes: string
  side_effects: none
  role: utility
  observations:
    - Doc says it "mirrors CloudHealthService.readIsPackaged's pattern" (app-version.ts:5-6); the lazy createRequire('electron') idiom is repeated across app.module.ts:102, diagnostics.controller.ts:104,140, and several services.

- path: app/packages/desktop-main/src/cloudformationTemplate.ts
  purpose: Resolves on-disk path to iam-bootstrap.yaml across packaged / electron-vite dev / plain tsc dist layouts.
  exports: resolveCloudFormationTemplatePath(): string | undefined
  dependencies: node:fs existsSync, node:path, node:url
  data_shapes: candidate list (resourcesPath/cloudformation, out/main→repo/app/packages/desktop-main/resources, dist→../resources)
  side_effects: filesystem existence checks
  role: utility
  observations:
    - Duplicates electron-entry.ts's resolveWindowIcon candidate-list pattern (cloudformationTemplate.ts:16 says "Mirrors").
    - Second candidate hard-codes the repo layout segments 'app','packages','desktop-main' (31-41).

- path: app/packages/desktop-main/src/updater.ts
  purpose: electron-updater integration — gated boot-time check, manual check/download/install, fallback-feed retry.
  exports: initUpdater(store), checkForUpdatesNow(), downloadUpdateNow(onProgress), installDownloadedUpdate()
  dependencies: electron-updater (dynamic, via .default), ./logger, ./updater-fallback (PRIMARY_FEED, resolveFallbackFeedUrl), ElectronStoreService type, errMessage, shared types ManualUpdateCheckResult/UpdateDownloadProgress/UpdateDownloadResult/UpdateInstallResult
  data_shapes: { ok, updateAvailable?, version?, message? } results
  side_effects: network to GitHub update feed; mutates autoUpdater singleton (setFeedURL, listeners); quitAndInstall quits the app
  role: Electron main utility
  observations:
    - autoDownload / autoInstallOnAppQuit forced false on every load (updater.ts:25-26).
    - initUpdater no-ops unless Electron AND store.enableAutoUpdate truthy (75-80) — default zero outbound traffic.
    - checkWithFallback restores PRIMARY_FEED in finally (56-59) because setFeedURL mutates a process-wide singleton.
    - downloadUpdateNow retries via re-check only when the error message equals the literal 'Please check update first' (172, 217) — couples to electron-updater's error text.
    - quitAndInstall(false, true) → relaunch after install (249).

- path: app/packages/desktop-main/src/updater-fallback.ts
  purpose: Finds the newest GitHub release carrying the platform's feed file, as a generic-provider fallback feed.
  exports: PRIMARY_FEED, GithubRelease, pickFallbackRelease(releases, platform), resolveFallbackFeedUrl(platform)
  dependencies: global fetch, ./logger, errMessage
  data_shapes: GitHub releases REST subset; feed asset per platform latest.yml / latest-mac.yml / latest-linux.yml
  side_effects: HTTPS GET api.github.com/repos/CoderCoco-Studios/Hyveon/releases?per_page=10 with 10s timeout
  role: utility
  observations:
    - RELEASES_REPO must match electron-builder.yml publish (updater-fallback.ts:4-5) — cross-file sync point with no check; PRIMARY_FEED repeats the owner/repo (8).
    - Only the 10 most recent releases are considered (10).
```

Root tests:

```yaml
- path: app/packages/desktop-main/src/main.test.ts
  purpose: Pins bootstrap: throws outside Electron, uses BridgedElectronIPCTransport strategy, registers RpcErrorMessageFilter before listen, calls registerIpcMainBridges once after listen, returns app, calls applyFixPath and createLogger(userData) at import.
  role: test
- path: app/packages/desktop-main/src/electron-entry.test.ts
  purpose: Pins menu cleared on import, bootstrap inside whenReady, initUpdater gets ElectronStoreService and its rejection doesn't block window, loadURL vs loadFile, quit rules (window-all-closed non-darwin, load fail, bootstrap fail), test-mode log, icon resolution, per-platform chrome options, macOS resize traffic-light switching, WindowService attach/re-attach on activate.
  role: test
  observations:
    - mockOpenExternal/mockSetWindowOpenHandler are set up (electron-entry.test.ts:33-37) but no case asserts setDefaultBrowserOpener's behaviour; the zoom-changed listener (electron-entry.ts:155) has no case either.
- path: app/packages/desktop-main/src/ipc-main-bridge.test.ts
  purpose: Pins no-op outside Electron, removeHandler-before-handle per pattern, handler(payload,{evt}) call shape, skips for logs.stream / iac.plan / iac.rollback.confirm / iac.stack.initialize / iac.settings.autoUpdate.download, result pass-through, error normalization (custom-field Error, string, error-like object, Observable throwError).
  role: test
  observations:
    - logs.lambda.stream, iac.apply, iac.destroy, iac.runs.logs are in SELF_BRIDGED_PATTERNS but have no dedicated skip case.
- path: app/packages/desktop-main/src/updater.test.ts
  purpose: Pins initUpdater gating (non-Electron, flag false/unset), single check, listeners, auto flags off, no rejection, fallback retry + primary-feed restore; checkForUpdatesNow event-driven resolution, null-result "disabled", listener cleanup, fallback semantics (original error surfaced); download progress forwarding, re-check-on-no-prior-check, listener cleanup, install relaunch, non-Electron refusals.
  role: test
- path: app/packages/desktop-main/src/updater-fallback.test.ts
  purpose: Pins pickFallbackRelease (skip zero-asset "v0.7.0 incident", drafts/prereleases, max published_at, invalid date = oldest, per-platform asset, unsupported platform null) and resolveFallbackFeedUrl (URL shape, API URL, null on non-200/reject/non-array).
  role: test
- path: app/packages/desktop-main/src/logger.test.ts
  purpose: Pins createLogger has Console + DailyRotateFile with given dirname, devPrintf prefixes every line and tab-indents continuations, singleton live-binding reassignment.
  role: test
  observations:
    - createLogger('/tmp/test-logs…') in tests constructs real DailyRotateFile transports under /tmp (logger.test.ts:16,27,99).
- path: app/packages/desktop-main/src/rpc-error-message.filter.test.ts
  purpose: Pins message preservation for plain Error, AWS-like Error with $metadata, and bare string.
  role: test
- path: app/packages/desktop-main/src/cloudformationTemplate.test.ts
  purpose: Pins candidate precedence (resourcesPath first, repo-relative fallback, dist-layout third candidate, undefined when none).
  role: test
- path: app/packages/desktop-main/src/fix-path-bootstrap.test.ts
  purpose: Pins fix-path called on darwin/linux, not on win32.
  role: test
- path: app/packages/desktop-main/src/app-version.test.ts
  purpose: Pins 'unknown' outside Electron and on require failure, real version under fake Electron.
  role: test
```

## app/packages/desktop-main/src/modules

```yaml
- path: app/packages/desktop-main/src/modules/aws.module.ts
  purpose: Groups AWS-facing services; re-exports ConfigModule and CloudProviderModule.
  exports: AwsModule
  dependencies: ConfigModule, CloudProviderModule, ElectronStoreModule, DeploymentConfigModule; services Ec2Service, EcsService, LogsService, CostService, SchedulerService, PublicIpService, FileManagerService
  data_shapes: n/a
  side_effects: none
  role: Nest feature module
  observations:
    - PublicIpService is provided (aws.module.ts:48) but not exported (49-58) — only reachable inside AwsModule (FileManagerService uses it).
    - Doc lists "the FileBrowser task helper" (16) = FileManagerService.

- path: app/packages/desktop-main/src/modules/cloud-provider.module.ts
  purpose: Binds seven cloud-agnostic tokens to per-cloud implementations chosen by ConfigService.getActiveCloud(); config-resolver helpers.
  exports: CloudBindings, CLOUD_BINDINGS (only 'aws'), resolveCloudBindings(config), resolveDeploymentConfigFileStoreConfig, resolveAuditLogStoreConfig, resolveDiscordConfigStoreConfig, resolveRunRecordStoreConfig, CloudProviderModule
  dependencies: @hyveon/cloud-aws (AwsSecretsStore, AwsRemoteFileStore, AwsDiscordEventReceiver, AwsAuditLogStore, AwsDiscordConfigStore, AwsRunRecordStore), @hyveon/shared (resolvePreApplyRunsTableName + interfaces), services ConfigService, ElectronStoreService, awsCredentialSource.resolveAwsClientCredentialsWithSignature, EcsService.createAwsCloudProvider; tokens file
  data_shapes: { bucket|tableName, region, credentials, credentialsSignature } config objects, resolved lazily per call
  side_effects: none at construction; resolvers call getStackOutputs (Pulumi/S3) and read electron-store credentials when invoked
  role: Nest module / DI factory registry
  observations:
    - Region precedence: outputs.awsRegion over config.getRegion() for audit/discord/runs stores (109, 131, 180) but remote file store always uses getRegion() (80).
    - Runs table pre-apply fallback via resolvePreApplyRunsTableName(remoteFileStore) fixes the bootstrap deadlock (145-151, 175); uses `||` so an empty-string output also falls back (175).
    - Bucket/table names fall back to '' so the store surfaces its own "not configured" error (66-67, 89-90).
    - Credentials resolved twice per secrets-store call (credentials and signature lambdas each call resolveAwsClientCredentialsWithSignature, 199-200).
    - The cloudProvider factory lives in services/EcsService.ts (createAwsCloudProvider, imported line 26) rather than @hyveon/cloud-aws like the other six.
    - resolveDiscordConfigStoreConfig is exported but cloud-provider.module.test.ts imports no Discord config store helper (test lines 33-39) — untested.

- path: app/packages/desktop-main/src/modules/cloud-provider.tokens.ts
  purpose: Symbol DI tokens for the seven cloud contracts.
  exports: CLOUD_PROVIDER, SECRETS_STORE, REMOTE_FILE_STORE, DISCORD_RECEIVER, AUDIT_LOG_STORE, DISCORD_CONFIG_STORE, RUN_RECORD_STORE
  dependencies: none
  data_shapes: Symbol
  side_effects: none
  role: DI tokens
  observations: none

- path: app/packages/desktop-main/src/modules/config.module.ts
  purpose: Provides ConfigService and binds CONFIG_CACHE_INVALIDATOR to it.
  exports: ConfigModule
  dependencies: ConfigService, CONFIG_CACHE_INVALIDATOR (from services/PulumiService), ElectronStoreModule, PulumiServiceModule
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations:
    - Imports PulumiServiceModule (config.module.ts:24) — this edge is the reason PulumiServiceModule can't import RunRecordModule/CloudProviderModule/DeploymentConfigModule (cycle).

- path: app/packages/desktop-main/src/modules/deployment-config.module.ts
  purpose: Provides DeploymentConfigService and DEPLOYMENT_CONFIG_SERVICE alias.
  exports: DeploymentConfigModule (re-exports ConfigModule, CloudProviderModule)
  dependencies: ConfigModule, CloudProviderModule, DeploymentConfigService, DEPLOYMENT_CONFIG_SERVICE (services/PulumiService)
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations: none

- path: app/packages/desktop-main/src/modules/discord.module.ts
  purpose: Provides DiscordConfigService and DiscordCommandRegistrar (no discord.js).
  exports: DiscordModule
  dependencies: AwsModule
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations: none

- path: app/packages/desktop-main/src/modules/electron-store.module.ts
  purpose: Provides SafeStorageService + ElectronStoreService.
  exports: ElectronStoreModule
  dependencies: SafeStorageService, ElectronStoreService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations:
    - Imported by ~8 modules; Nest dedupes static modules so one singleton results.

- path: app/packages/desktop-main/src/modules/folder-upload.module.ts
  purpose: Folder-to-volume upload services.
  exports: FolderUploadModule (exports FolderScanService, FolderUploadService)
  dependencies: AwsModule, DeploymentConfigModule, ElectronStoreModule; FileBrowserClientFactory (services/folderUpload/FileBrowserClient), FolderScanService, FolderUploadService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations: none

- path: app/packages/desktop-main/src/modules/pulumi-engine.module.ts
  purpose: Provides PulumiEngineService (sync construction, no I/O).
  exports: PulumiEngineModule
  dependencies: PulumiEngineService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations: none

- path: app/packages/desktop-main/src/modules/pulumi-workspace.module.ts
  purpose: Provides PulumiWorkspaceService (Automation API workspace/backend/passphrase seam).
  exports: PulumiWorkspaceModule
  dependencies: PulumiEngineModule, ElectronStoreModule, PulumiWorkspaceService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations: none

- path: app/packages/desktop-main/src/modules/pulumi-service.module.ts
  purpose: Provides PulumiService.
  exports: PulumiServiceModule
  dependencies: PulumiWorkspaceModule, PulumiEngineModule, ElectronStoreModule, PulumiService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations:
    - Deliberately does not import RunRecordModule / CloudProviderModule / DeploymentConfigModule; PulumiService resolves their tokens via ModuleRef strict:false (pulumi-service.module.ts:16-25).

- path: app/packages/desktop-main/src/modules/run-record.module.ts
  purpose: Provides RunService (apply lock) and RunRecordService plus RUN_RECORD_PERSISTER / RUN_LOCK_SERVICE aliases; hosts the canonical module-cycle note.
  exports: RunRecordModule
  dependencies: ConfigModule, CloudProviderModule, RunService, RunRecordService, tokens from services/PulumiService
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations:
    - Duplicate provider declaration would split RunService's in-memory currentLock (run-record.module.ts:13-15).
    - Canonical cycle explanation PulumiServiceModule → RunRecordModule → ConfigModule → PulumiServiceModule (22-42); other modules link here.

- path: app/packages/desktop-main/src/modules/wizard.module.ts
  purpose: First-run wizard providers.
  exports: WizardModule (AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService, GuidedIamService, CloudHealthService)
  dependencies: ElectronStoreModule, ConfigModule, DeploymentConfigModule
  data_shapes: n/a
  side_effects: none
  role: Nest module
  observations:
    - CloudHealthService (a Settings-page concern) lives in WizardModule (wizard.module.ts:37).
    - References openspec/changes/add-first-run-wizard (13-14) — may be archived.

- path: app/packages/desktop-main/src/modules/cloud-provider.module.test.ts
  purpose: Pins aws routing to each Aws* class, bucket/table/region resolution and '' fallbacks, outputs.awsRegion preference, pre-apply runsTableName fallback (incl. runsTableName override, prefer outputs once applied, '' when no config), fake-cloud registration routing, unsupported cloud throws.
  role: test
  observations:
    - No case for discordConfigStore / resolveDiscordConfigStoreConfig.
```

## app/packages/desktop-main/src/controllers

```yaml
- path: app/packages/desktop-main/src/controllers/validation.ts
  purpose: Shared payload validators.
  exports: isNonEmptyString(value), requireStringArray(field, value)
  dependencies: @nestjs/common BadRequestException
  data_shapes: throws BadRequestException({ success:false, error })
  side_effects: none
  role: utility
  observations:
    - Doc says Nest "maps to a 400 with the same shape the legacy Express handlers used" (validation.ts:14-16) — stale; there is no HTTP transport.
    - Ad-hoc non-empty-string checks are reimplemented inline in iac-runs.controller.ts:212,264,341,377,410 instead of using isNonEmptyString.

- path: app/packages/desktop-main/src/controllers/audit.controller.ts
  purpose: Audit log page read.
  exports: AuditController; channel audit.list
  dependencies: AuditService (ListAuditEntriesOpts), AuditPageResult
  data_shapes: { limit?, before? } → AuditPageResult
  side_effects: logs
  role: IPC controller
  observations: none

- path: app/packages/desktop-main/src/controllers/cloud-health.controller.ts
  purpose: Settings Cloud Health checklist.
  exports: CloudHealthController, CloudHealthCheckSummary; channels cloudHealth.list, cloudHealth.fix, cloudHealth.downloadPolicy, cloudHealth.openPolicyConsole
  dependencies: CloudHealthService, OpenConsoleResult type from GuidedIamService
  data_shapes: { id, label, status, message? }[]; fix → CloudHealthFixResult
  side_effects: logs; downloadPolicy writes file to disk (via service); openPolicyConsole opens browser
  role: IPC controller
  observations:
    - list runs every check in parallel with Promise.all — one throwing check rejects the whole list (cloud-health.controller.ts:28-33).
    - Unknown id returns outcome 'failed' rather than throwing (41-43).
    - downloadPolicy/openPolicyConsole only covered by the channel-name test.

- path: app/packages/desktop-main/src/controllers/costs.controller.ts
  purpose: Hourly Fargate cost estimates from task-definition cpu/memory.
  exports: CostsController; channel costs.estimate
  dependencies: ConfigService, CostService.estimateForSpec, EcsService.getTaskDefinition
  data_shapes: { games: Record<game, estimate>, totalPerHourIfAllOn (rounded 4dp) }
  side_effects: ECS DescribeTaskDefinition per game (sequential)
  role: IPC controller
  observations:
    - Falls back to 2048 cpu / 8192 MiB when no task def (costs.controller.ts:39).
    - Doc says "Reads the game list from tfstate" (25) — Terraform-era wording; it reads Pulumi stack outputs.
    - No AWS Cost Explorer calls (11-12, openspec/changes/remove-cost-explorer-calls).

- path: app/packages/desktop-main/src/controllers/diagnostics.controller.ts
  purpose: Local log tail/path, renderer error/log forwarding, diagnostics zip export, reveal-in-folder.
  exports: DiagnosticsController, ReportRendererErrorInput, ReportRendererLogBatchInput, ShowInFolderInput; channels diagnostics.tail, diagnostics.path, diagnostics.reportError, diagnostics.reportLog, diagnostics.exportBundle, diagnostics.showInFolder
  dependencies: DiagnosticsService, DiagnosticsBundleService, electron dialog/shell (lazy createRequire)
  data_shapes: ExportDiagnosticsBundleResult { status: 'written'|'cancelled'|'error' }
  side_effects: reads log file; native save dialog; writes zip; shell.showItemInFolder; logs
  role: IPC controller
  observations:
    - Tail hard-coded to 500 lines (diagnostics.controller.ts:48).
    - showSaveDialog/revealInFolder are protected seams for tests (103, 139).
    - Default filename hyveon-diagnostics-<ISO with : and . replaced>.zip (110).

- path: app/packages/desktop-main/src/controllers/discord.controller.ts
  purpose: Serverless Discord bot config — credentials, guild allowlist, admins, per-game permissions, command registration.
  exports: DiscordController; channels discord.getConfig, discord.putConfig, discord.listGuilds, discord.addGuild, discord.removeGuild, discord.registerCommands, discord.getAdmins, discord.putAdmins, discord.getPermissions, discord.putPermission, discord.deletePermission
  dependencies: DiscordConfigService (DiscordAction), DiscordCommandRegistrar, ConfigService, requireStringArray
  data_shapes: redacted config + interactionsEndpointUrl (outputs.interactionsInvokeUrl); { guilds, baseGuilds }; admins + baseAdmins; gamePermissions map
  side_effects: Secrets Manager / DynamoDB writes (via service); Discord REST PUT (via registrar); logs (field presence only for putConfig)
  role: IPC controller
  observations:
    - putConfig logs only which fields were present, never values (discord.controller.ts:52-57).
    - discord.putPermission payload collapsed to { game, body } because the transport delivers only the first invoke arg (178-181).
    - `actions` cast to DiscordAction[] without validating membership (198).
    - Docs say "from tfstate" (31) and "Returns 400" (108, 175, 206) — stale HTTP/Terraform wording.
    - All validation failures throw BadRequestException (59-217); see RpcErrorMessageFilter observation re message flattening.
    - The `Promise.all([getConfig(), getBaseConfig()])` re-read repeats 5 times (89, 103, 122, 148, 162).

- path: app/packages/desktop-main/src/controllers/drift.controller.ts
  purpose: Drift report read.
  exports: DriftController; channel drift.get
  dependencies: DriftService
  data_shapes: DriftReport
  side_effects: logs
  role: IPC controller
  observations: none

- path: app/packages/desktop-main/src/controllers/env.controller.ts
  purpose: Top-bar env pill data.
  exports: EnvController; channel env.get
  dependencies: ConfigService
  data_shapes: { region (outputs.awsRegion ?? 'local'), domain, environment: 'PROD'|'local' }
  side_effects: logs
  role: IPC controller
  observations:
    - environment is 'PROD' iff domainName is non-empty — cosmetic (env.controller.ts:26-28).

- path: app/packages/desktop-main/src/controllers/files.controller.ts
  purpose: Ad-hoc EFS file-manager task controls.
  exports: FilesController; channels files.list, files.start, files.stop
  dependencies: FileManagerService
  data_shapes: game: string payload
  side_effects: ECS RunTask/StopTask via service; logs
  role: IPC controller
  observations:
    - files.list actually returns status (getStatus), not a file list (files.controller.ts:15-19).
    - No payload validation (contrast FolderUploadController.requireGame).

- path: app/packages/desktop-main/src/controllers/folder-upload.controller.ts
  purpose: Seed a game's volume from a local folder; progress push channel.
  exports: FolderUploadController, FOLDER_UPLOAD_PROGRESS_CHANNEL ('folderUpload.progress'); channels folderUpload.pickFolder, .rescanSelection, .getSelection, .setSelection, .clearSelection, .startUpload, .cancelUpload, .confirmOverwrite, .getProgress, .cleanupStrayHelpers
  dependencies: FolderUploadService, FolderScanService, @hyveon/shared/folderUpload types, validation helpers, electron BrowserWindow (dynamic)
  data_shapes: FolderUploadRequest { game, scanId, destination, include[] }, FolderOverwriteDecision { game, proceed }, FolderUploadProgress
  side_effects: native folder dialog; local FS scan; upload to FileBrowser helper; broadcasts progress to all windows via webContents.send; logs
  role: IPC controller
  observations:
    - Progress is broadcast to every BrowserWindow (folder-upload.controller.ts:45-49), unlike streaming controllers which reply to evt.sender only.
    - Unsubscribes on onModuleDestroy (53-55) — the only controller in scope implementing OnModuleDestroy.
    - File contents and helper credential never cross IPC (22-25).

- path: app/packages/desktop-main/src/controllers/games.controller.ts
  purpose: Game list/status/start/stop, game_servers CRUD, add-game wizard draft.
  exports: GamesController; channels games.list, games.status, games.getStatus, games.start, games.stop, games.create, games.update, games.delete, games.draft.get, games.draft.save, games.draft.updateStepIndex, games.draft.clear
  dependencies: ConfigService, EcsService, DeploymentConfigService, GamesWriteService, GameWizardDraftService, computeDriftFromOutputs (DriftService), mergeGameLists
  data_shapes: { games: GameListEntry[] }; GameWriteResult discriminated union; StoredGameWizardDraft
  side_effects: S3 read of deployment-config.json; ECS ListTasks/DescribeTasks/RunTask/StopTask; electron-store draft writes; logs
  role: IPC controller
  observations:
    - games.list and games.status invalidate DeploymentConfigService cache but NOT ConfigService stack-outputs cache (games.controller.ts:41-48, 63-69, 54, 74).
    - Drift computed locally from the same declared/outputs pair to avoid a second racing S3 read (35-39).
    - Write handlers never throw; return GameWriteResult because ipcMain strips custom error props (113-120).
    - games.draft.updateStepIndex (179) is not in either expectChannels list in games.controller.test.ts (85-95, 321-327).

- path: app/packages/desktop-main/src/controllers/logs.controller.ts
  purpose: CloudWatch log reads and live streams for game tasks and Lambda functions.
  exports: LogsController; channels logs.get, logs.getOlder, logs.getNewer, logs.stream, logs.lambda.get, logs.lambda.getOlder, logs.lambda.getNewer, logs.lambda.stream
  dependencies: LogsService (RecentLogsPage/OlderLogsPage/NewerLogsPage), LambdaFunctionKey, electron ipcMain (dynamic)
  data_shapes: stream ack { streamId }; side channels <prefix><streamId>.chunk / .end ({ error? }) / .cancel
  side_effects: CloudWatch Logs reads; ipcMain.handle self-bridging; ipcMain.once cancel listener; WebContents.send pushes; logs
  role: IPC controller (self-bridged streaming)
  observations:
    - Default limits: get 50, getOlder/getNewer 100 (65, 86, 110, 229, 246, 270).
    - Per-stream channels are uuid-scoped (dynamic) unlike iac's fixed channels; cancel via renderer ipcRenderer.send on .cancel (129-130, 163-165).
    - AbortError ends cleanly with {} end message; other errors send { error: String(err) } (180-188).
    - logs.get / logs.lambda.get have no try/catch normalization while getOlder/getNewer do (62-69 vs 88-95) — inconsistent.
    - Four near-identical try/catch/log/rethrow blocks (88-95, 112-119, 248-255, 272-279).
    - Doc says "the app's 5 Lambda functions" (220, 237, 260); CLAUDE.md describes six Lambda packages.

- path: app/packages/desktop-main/src/controllers/iac.controller.ts
  purpose: Pulumi orchestration over IPC — stack init, plan, approve, apply, destroy, rollback resolve/confirm, backend-lock clear, outputs.
  exports: IacController; channels iac.stack.initialize, iac.plan, iac.apply, iac.destroy, iac.destroy.mintToken, iac.lock.clear.mintToken, iac.lock.clear, iac.output, iac.approve, iac.rollback.resolve, iac.rollback.confirm; fixed side channels iac.plan.chunk/.end, iac.apply.chunk/.end, iac.destroy.chunk/.end, iac.rollback.confirm.chunk, iac.stack.initialize.chunk/.end
  dependencies: PulumiService (+ PulumiOperationInFlightError, PulumiRollbackPlanFailedError, PulumiStackInitializationError, result types), PulumiEngineService phase types, PulumiLockRecovery.PulumiUnrecognizedLockError, ConfigService, AuditService, RunRecordService, RunLockHeldError (shared), node:os userInfo, isNonEmptyString
  data_shapes: IacPlanAck { started, runId?, error?, conflict?, staleLock?, runLock? }; end messages { runId, exitCode: 0|null, error?, result?, staleLock? }; StaleLockInfo with lockedAt ISO string; approve/rollback/lock-clear acks
  side_effects: Pulumi engine runs (via service); audit-log writes; WebContents.send pushes; ipcMain.handle self-bridging for 5 channels; logs
  role: IPC controller (self-bridged streaming)
  observations:
    - plan pre-mints runId and starts the generator synchronously after the in-flight check to close a TOCTOU (iac.controller.ts:704-708, 721-735); acks before the gate runs.
    - apply/destroy await the generator's first .next() before acking so the gate result maps to { started:false, ... } (805-809, 832-866, 988-1016); apply reuses planRunId as runId (827).
    - conflict mapping: RunLockHeldError → 'up' (apply) / 'destroy' (destroy) + runLock; PulumiOperationInFlightError → err.inFlight; PulumiUnrecognizedLockError → staleLock (836-862, 992-1012).
    - The plan/apply/destroy streaming loops are three near-identical ~30-line blocks (766-792, 890-921, 1032-1063) — duplication.
    - confirmRollback is NOT fire-and-forget: it drives the whole restore+plan generator before acking (1236-1293); chunk channel has no subscriber yet (49-53).
    - confirmed rollback produces two PulumiRunRecords tagged rolledBackFrom (1205-1209) — documented "accepted consequence".
    - activePlans/activeApplies/activeDestroys maps exist for "a future iac.*.cancel channel" (525, 535, 545) — no cancel channel exists.
    - initializeStack's inline comment points to "this method's own TSDoc" for the TOCTOU rationale (665-667), but initializeStack's TSDoc (617-635) doesn't contain it — dangling reference.
    - approver = os.userInfo().username, never client-supplied (1359-1361).
    - iac.output ignores payload.force (1076-1078, 1088) — kept for preload compat.
    - Audit entries recorded with game '' and before/after null for plan/apply/destroy/approve/rollback (755-761, 885, 1029, 1126-1131, 1285-1291).
    - Several logger.error calls pass the raw `err` object (784, 908, 1050, 1135, 1191, 1295, 1345) rather than a normalized message, contrary to .claude/rules/logging.md rule 2.
    - Payload interface comments say "keep this shape in sync with" @hyveon/desktop-preload/src/hyveon-api.ts (250-252, 297-299, 401-403, 458-460) — the duplication rule flags such comments as bug reports.
    - audit/runRecord/config constructor params optional purely for tests (507-521).

- path: app/packages/desktop-main/src/controllers/iac-runs.controller.ts
  purpose: Run detail/status, run-log streaming, run history list, offloaded log URL, durable apply-lock clear.
  exports: IacRunsController, IacRunsLogUrlResult, IacRunsLogUrlPayload, IacRunsLockMintAck, IacRunsLockMintPayload, IacRunsLockClearPayload, IacRunsLockClearAck, IacRunsGetPayload, IacRunsGetResult; channels iac.runs.get, iac.runs.logs (self-bridged; side channels iac.runs.logs.chunk/.end), iac.runs.list, iac.runs.logUrl, iac.runs.lock.clear.mintToken, iac.runs.lock.clear
  dependencies: PulumiService (readRunRecord, hasPlanArtifact, streamRunOutput), RunService (+ RunLockChangedError, RunLockClearNotConfirmedError), RunRecordService (listRuns, getLogUrl), computeRunDetailStatus (shared)
  data_shapes: IacRunsGetResult { found, status?, record? }; RunStatus filter success|failed|aborted
  side_effects: reads local run.json / plan artifacts; DynamoDB run-record reads; presigned URL generation; WebContents.send pushes; logs
  role: IPC controller (partly self-bridged)
  observations:
    - get: in-flight lock match → 'running' without record; else persisted record + computeRunDetailStatus (219-237).
    - RUN_STATUSES duplicated locally (16) rather than derived from the shared RunStatus type.
    - mintLockClearToken binds the token to expectedRunId (TOCTOU) and converts both race errors into BadRequestException (373-392); clearLock returns { cleared:false, error } rather than throwing (406-428).
    - Two different "mint lock clear token" channels exist: iac.lock.clear.mintToken (Pulumi backend lock) and iac.runs.lock.clear.mintToken (durable run lock) (352-356).
    - logger.error passes raw err (293).

- path: app/packages/desktop-main/src/controllers/iac-settings.controller.ts
  purpose: Top-level DeploymentConfig settings editor, engine version, auto-update flag + manual check/download/install.
  exports: IacSettingsController; channels iac.settings.get, iac.settings.update, iac.settings.engineVersion, iac.settings.autoUpdate.get, iac.settings.autoUpdate.update, iac.settings.autoUpdate.check, iac.settings.autoUpdate.download (self-bridged; side channels iac.settings.autoUpdate.download.chunk/.end), iac.settings.autoUpdate.install
  dependencies: DeploymentConfigService (+ ConfigurationNotConfiguredError, RunsTableRenameError), PulumiEngineService, ElectronStoreService, validateDeploymentSettingsPatch / OptimisticLockError (shared), readAppVersion, updater functions
  data_shapes: { ok, code: 'validation'|'conflict'|'setup_incomplete'|'error', ... } results; settings + etag/versionId
  side_effects: S3 read/write of deployment-config.json; electron-store enableAutoUpdate read/write; update download/install; logs
  role: IPC controller
  observations:
    - Never throws from get/update — all failures mapped to result codes (128-198); validation inside try so malformed envelopes map to code 'error' (150-155).
    - RunsTableRenameError mapped to code 'validation' with one issue per field (171-181).
    - enableAutoUpdate write only takes effect on next app start (243-247).
    - Value (not type) imports for PulumiEngineService/ElectronStoreService are load-bearing for Nest DI metadata (22-32).
    - engine/store optional purely for test construction (85-102).
    - logger.error('Failed to read/write deployment settings', { err }) logs raw error objects (139, 195).
    - Class doc says it mirrors EnvController's minimal shape (70-74) though it is now one of the larger controllers.

- path: app/packages/desktop-main/src/controllers/window.controller.ts
  purpose: Custom title-bar window controls.
  exports: WindowController; channels window.minimize, window.toggleMaximize, window.close, window.isMaximized
  dependencies: WindowService
  data_shapes: void / boolean
  side_effects: BrowserWindow mutations via service; logs
  role: IPC controller
  observations: none

- path: app/packages/desktop-main/src/controllers/wizard.controller.ts
  purpose: First-run wizard IPC — state, AWS profile/credentials, bootstrap resources, IAM simulation, progress, guided IAM CloudFormation flow.
  exports: WizardController, BootstrapStateBucketInput, BootstrapConfigurationBucketInput, BootstrapDeploymentConfigInput, SaveWizardProgressInput, OpenGuidedIamConsoleInput, WizardAwsChoice, WizardBootstrapNames, WizardState, SaveWizardStateInput; channels wizard.state.get, wizard.state.save, wizard.aws.listProfiles, wizard.aws.saveCredentials, wizard.bootstrap.stateBucket, wizard.bootstrap.configurationBucket, wizard.bootstrap.deploymentConfig, wizard.bootstrap.runsTable, wizard.iam.simulate, wizard.progress.get, wizard.progress.save, wizard.complete, wizard.reset, wizard.guidedIam.prepareTemplate, wizard.guidedIam.openConsole, wizard.guidedIam.submitBootstrapKey, wizard.guidedIam.rotate, wizard.guidedIam.revokeBootstrapKey
  dependencies: AwsProfileService, ElectronStoreService, BootstrapService, IamCheckService, FirstRunWizardService, GuidedIamService; DEPLOYMENT_CONFIG_DEFAULTS, resolveRunsTableName (shared)
  data_shapes: WizardState { wizardCompleted, activeCloud?: 'aws', aws?: { profile?, region? }, bootstrap?: { stateBucket, configurationBucket } }
  side_effects: electron-store writes; ~/.aws profile reads; S3 bucket/object creation; DynamoDB table creation; IAM SimulatePrincipalPolicy; STS; IAM key rotation; browser launch; logs (secret fields never logged)
  role: IPC controller
  observations:
    - wizardCompleted defaults to true when unset under HYVEON_TEST_MODE (wizard.controller.ts:132-152, 168) — test seam in production code path.
    - isTestMode() duplicates env.ts:12 (217-219).
    - activeCloud runtime-validated to 'aws' only (194-201); aws merged, bootstrap replaced wholesale (203-208).
    - Doc says bootstrap "always submits all three resource names" (185) but WizardBootstrapNames has two fields (78-81) — stale after lockTable removal (73-77).
    - wizard.bootstrap.runsTable computes name from DEPLOYMENT_CONFIG_DEFAULTS.projectName with no override (307-311).
    - Relies on ipc-main-bridge for failure logging rather than per-handler catches (117-119).
    - References issue numbers #192, #211 in comments (69, 88, 179-180).
```

Controller tests:

```yaml
- path: app/packages/desktop-main/src/controllers/audit.controller.test.ts
  purpose: Pins audit.list channel, delegation with opts, {} default, empty result.
  role: test
- path: app/packages/desktop-main/src/controllers/cloud-health.controller.test.ts
  purpose: Pins four channel names, list → one summary per check, fix delegation, unknown id → failed outcome.
  role: test
- path: app/packages/desktop-main/src/controllers/costs.controller.test.ts
  purpose: Pins costs.estimate channel, zeros when no outputs, per-game getTaskDefinition/estimateForSpec, 2048/8192 fallback, totalPerHourIfAllOn sum.
  role: test
  observations:
    - "should not register an actual handler" (costs.controller.test.ts:53-56) asserts absence of a removed Cost Explorer `actual` member — residual guard.
    - makeEcs uses `as unknown as EcsService` (44), the cast style testing/config-service.fixture.ts:3-4 calls banned.
- path: app/packages/desktop-main/src/controllers/diagnostics.controller.test.ts
  purpose: Pins six channels, tail(500), path, reportError/reportLog pass-through returning undefined, exportBundle written/cancelled/error-result, showInFolder never throws.
  role: test
- path: app/packages/desktop-main/src/controllers/discord.controller.test.ts
  purpose: Pins 11 channels, secret redaction (never raw token/public key, never echoed), BadRequest on wrong types / empty ids / failed removal / unknown game, trimming, omitted arrays → [], success shapes with base lists.
  role: test
- path: app/packages/desktop-main/src/controllers/drift.controller.test.ts
  purpose: Pins drift.get channel and delegation.
  role: test
- path: app/packages/desktop-main/src/controllers/env.controller.test.ts
  purpose: Pins env.get region/domain, PROD iff domain, 'local' fallbacks.
  role: test
- path: app/packages/desktop-main/src/controllers/files.controller.test.ts
  purpose: Pins files.list/start/stop delegation and pass-through of one-time credentials from start.
  role: test
- path: app/packages/desktop-main/src/controllers/folder-upload.controller.test.ts
  purpose: Pins 10 channels, pickFolder delegation, include defaults to [], rejection of missing scanId / non-array include / empty game / malformed overwrite decisions, set/clear selection, no progress subscription outside Electron.
  role: test
- path: app/packages/desktop-main/src/controllers/games.controller.test.ts
  purpose: Pins channels, games.list/status invalidate only DeploymentConfig cache (not stack outputs), merge/drift states (pending_create, pending_delete, config_drift), ordering, delegation of start/stop/CRUD verbatim, draft get/save/clear.
  role: test
  observations:
    - games.draft.updateStepIndex has no channel-name assertion or behaviour case.
    - Test names still say "tfstate" (games.controller.test.ts:135, 189, 203).
- path: app/packages/desktop-main/src/controllers/games.controller.integration.test.ts
  purpose: Real DeploymentConfigService + GamesWriteService with stubbed RemoteFileStore/ConfigService; pins declared-only/deployed-only/both merge, create/update/delete round-trip through config JSON, validation (Fargate cpu/memory mismatch, duplicate name) and conflict (stale etag) codes, and fs never touched.
  role: test
- path: app/packages/desktop-main/src/controllers/iac.controller.test.ts
  purpose: Pins 11 channels, onModuleInit self-bridging (and not bridging iac.destroy.mintToken), ctx-construction for initializeStack/confirmRollback, initializeStack streaming/conflict/destroyed/phase logging, plan streaming/forwarding/audit/conflict and concurrent-submission guard, apply/destroy gate-before-ack + conflict mapping + streaming + stream.return on destroyed, output fallback/force ignored, approve OS username + failure cases, rollback resolve with best-effort diff, confirmRollback full-drive/audit/defensive branches/PulumiRollbackPlanFailedError versionId, clearStaleLock, mintLockClearToken.
  role: test
  observations:
    - No case references PulumiUnrecognizedLockError or staleLock (0 matches) — the staleLock ack/end-message mapping (iac.controller.ts:850-862, 914, 1003-1012, 1056) is untested here.
- path: app/packages/desktop-main/src/controllers/iac-runs.controller.test.ts
  purpose: Pins channels, get status derivation (running/success/failed/aborted/awaiting_approval/not found) and runId validation, onModuleInit bridging, logs streaming order/end/error/destroyed handling/listener cleanup, list status filter validation, mintLockClearToken BadRequest mapping, clearLock ack shapes, logUrl delegation.
  role: test
- path: app/packages/desktop-main/src/controllers/iac-settings.controller.test.ts
  purpose: Pins channels, get/update result-code mapping (setup_incomplete, conflict, validation incl. RunsTableRenameError, error, malformed envelope), re-read after write, engineVersion null cases, auto-update get/update (absent store, throwing store, non-boolean), check/install pass-through, download streaming, onModuleInit outside Electron.
  role: test
- path: app/packages/desktop-main/src/controllers/logs.controller.test.ts
  purpose: Pins 8 channels, both self-bridges, limit defaults, error normalization, stream lifecycle (streamId, cancel listener, chunks, end on exhaustion/AbortError/error, own AbortController, cancel aborts, listener removal, destroyed WebContents) for both game and Lambda streams.
  role: test
- path: app/packages/desktop-main/src/controllers/window.controller.test.ts
  purpose: Pins four window channels and delegation.
  role: test
- path: app/packages/desktop-main/src/controllers/wizard.controller.test.ts
  purpose: Pins channels, profile listing, saveCredentials returns only profileName and never logs key material, getState defaults incl. test-mode true, saveState persistence/merge/replace/unsupported cloud, bootstrap delegations, runsTable default name, IAM simulate pass-through, progress get/save with guidedIam, complete, reset, guided-IAM handlers log bare messages only.
  role: test
  observations:
    - No behaviour cases for bootstrapDeploymentConfig, prepareGuidedIamTemplate, openGuidedIamConsole, revokeGuidedIamBootstrapKey (only channel registration).
```

## app/packages/desktop-main/src/testing

```yaml
- path: app/packages/desktop-main/src/testing/config-service.fixture.ts
  purpose: Shared ConfigService stub (getRegion, getStackOutputs, invalidateCache).
  exports: configServiceStub({ outputs?, region? })
  dependencies: vitest vi, StackOutputs, stack-outputs.fixture
  data_shapes: Partial<ConfigService> cast
  side_effects: none
  role: test fixture
  observations:
    - Consolidates ~18 local makeConfig copies (issue #557 finding 63, config-service.fixture.ts:2-5).

- path: app/packages/desktop-main/src/testing/deployment-config.fixture.ts
  purpose: GameServer fixture + DeploymentConfigService stub.
  exports: gameServer(name, overrides), deploymentConfigStub({ declared?, projectName? }, overrides)
  dependencies: vitest, GameServer, DeploymentConfigService type
  data_shapes: GameServer default image example/image:latest, 1024/2048, tcp 25565, volume saves:/data
  side_effects: none
  role: test fixture
  observations:
    - Issue #557 finding 64 consolidation; infra keeps its own differently-shaped fixture (deployment-config.fixture.ts:6-8).

- path: app/packages/desktop-main/src/testing/stack-outputs.fixture.ts
  purpose: Complete StackOutputs default object.
  exports: stackOutputs(overrides)
  dependencies: StackOutputs
  data_shapes: 20 fields incl. fileBrowserCredentialSecretArn, fileBrowserSchedulerRoleArn, appliedGameServers
  side_effects: none
  role: test fixture
  observations:
    - Mirrors @hyveon/infra testing/fixtures.ts and @hyveon/web e2e/fixtures/stack-outputs.fixture.ts (stack-outputs.fixture.ts:2-4) — three copies of the same shape across packages.

- path: app/packages/desktop-main/src/testing/message-pattern.test-utils.ts
  purpose: Asserts @MessagePattern metadata per method.
  exports: PATTERN_METADATA_KEY ('microservices:pattern'), expectChannels(proto, rows)
  dependencies: reflect-metadata, vitest expect
  data_shapes: [method, channel] rows
  side_effects: none
  role: test utility
  observations:
    - Depends on Nest's internal metadata key string (message-pattern.test-utils.ts:10).

- path: app/packages/desktop-main/src/testing/fake-filebrowser-client.ts
  purpose: In-memory FileBrowserApi double.
  exports: FakeClient, fakeClient(overrides)
  dependencies: vitest, FileBrowserApi/RemoteEntry/UploadFileArgs (services/folderUpload/FileBrowserClient)
  data_shapes: uploads[], sizes Map
  side_effects: none
  role: test double
  observations: none

- path: app/packages/desktop-main/src/testing/fake-filebrowser-server.ts
  purpose: HTTPS fake of the FileBrowser REST slice (/api/login, POST/GET /api/resources).
  exports: FakeFileBrowserOptions, FakeFileBrowser, startFakeFileBrowser(options)
  dependencies: node:https, EphemeralCert (services/folderUpload/ephemeralCert)
  data_shapes: files Map<path,size>, dirs Set, requests log; auth via X-Auth 'fake-jwt'
  side_effects: binds 127.0.0.1 ephemeral port
  role: test double
  observations:
    - drain() and collect() are two near-identical body readers (fake-filebrowser-server.ts:29-33, 118-122).
    - Directory create detected by trailing '/' on POST; 409 if exists (70-75).
```

## app/packages/desktop-main/src/test-mocks

```yaml
- path: app/packages/desktop-main/src/test-mocks/mock-store.ts
  purpose: Process-wide FIFO queues of ECS mock responses, shared by ECS interceptors and the web package's Playwright fixtures.
  exports: MockResponse, mockStore
  dependencies: none
  data_shapes: { type: 'success'|'error', data?, code?, message? } per command queue
  side_effects: none (in-memory singleton)
  role: test double
  observations:
    - Consumed from compiled dist/ by app/packages/web/e2e/fixtures/server-mocks.ts (mock-store.ts:13-15).
    - Doc's default RunTask ARN uses account 123 (24) while ecs-mock.ts:60 returns 123456789012.

- path: app/packages/desktop-main/src/test-mocks/ecs-mock.ts
  purpose: aws-sdk-client-mock interceptors on ECSClient for ListTasks/DescribeTasks/RunTask/StopTask.
  exports: installEcsMock()
  dependencies: aws-sdk-client-mock, @aws-sdk/client-ecs, mockStore
  data_shapes: SDK command outputs
  side_effects: patches ECSClient prototype globally
  role: test double
  observations:
    - Four near-identical handler blocks differing only by command and default (ecs-mock.ts:31-74).

- path: app/packages/desktop-main/src/test-mocks/pulumi-mock.ts
  purpose: PulumiServiceStub injected at the DI seam by the web package's ipc-harness — no engine, no AWS.
  exports: PulumiOperationName, ScriptedPulumiRun<T>, PulumiServiceStub
  dependencies: PulumiService result/record types, DeploymentConfigDiff, StackOutputs
  data_shapes: scripted chunks + result|failure
  side_effects: none
  role: test double
  observations:
    - PulumiOperationName duplicates PulumiService.getOperationInFlight's return union by hand (pulumi-mock.ts:10-11).
    - No mintLockClearConfirmationToken method though IacController calls it (iac.controller.ts:956); confirmRollback/resolveRollbackTarget/etc. have no script setters (153-191).

- path: app/packages/desktop-main/src/test-mocks/remote-file-store-mock.ts
  purpose: S3Client interceptors backing a single versioned configuration object.
  exports: remoteFileStoreMockStore, installRemoteFileStoreMock()
  dependencies: aws-sdk-client-mock, @aws-sdk/client-s3, CONFIGURATION_OBJECT_KEY, DeploymentConfig
  data_shapes: StoredVersion { versionId 'mock-version-N', lastModified, body }; versionId doubles as etag
  side_effects: patches S3Client prototype globally (all buckets/keys)
  role: test double
  observations:
    - PLACEHOLDER_CONFIG hand-maintains every DeploymentConfig field (remote-file-store-mock.ts:14-30) — another copy that breaks when a required field is added.

- path: app/packages/desktop-main/src/test-mocks/run-record-mock.ts
  purpose: Stateful DynamoDBDocumentClient interceptors emulating AwsRunRecordStore's RUN items and LOCK/CURRENT apply-lock item.
  exports: runRecordMockStore, installRunRecordDynamoMock()
  dependencies: aws-sdk-client-mock, @aws-sdk/lib-dynamodb, ConditionalCheckFailedException
  data_shapes: items Record<string,unknown>[], lockItem; conditional put attribute_not_exists OR expiresAt < :now
  side_effects: patches DynamoDBDocumentClient prototype globally
  role: test double
  observations:
    - LOCK_PK/LOCK_SK duplicated from AwsRunRecordStore (run-record-mock.ts:5-7).
    - patchApprovedAt simulates a stale approval outside the 15-minute window (47-57).
    - GetCommand only answers the lock key; any other Get returns undefined (134-140).
```

## Observed behaviours

- desktop-main refuses to start outside Electron with a readable error — app/packages/desktop-main/src/main.ts:18-23
- PATH is fixed from the login shell at import on non-Windows — app/packages/desktop-main/src/main.ts:12, src/fix-path-bootstrap.ts:17-22
- File logger writes `userData/logs/main-YYYY-MM-DD.log`, 14-day retention, JSON in production — src/main.ts:26, src/logger.ts:72-85
- The exported `logger` starts console-only and is swapped via ESM live binding — src/logger.ts:61, 88
- RpcErrorMessageFilter is registered globally before listen() so handler errors keep their real message — src/main.ts:49-51, src/rpc-error-message.filter.ts:35-38
- Every non-self-bridged @MessagePattern gets `ipcMain.removeHandler` then `ipcMain.handle` — src/ipc-main-bridge.ts:132-138
- Handler rejections and Observable errors are normalized to `new Error(message)` and logged with pattern + stack — src/ipc-main-bridge.ts:139-154
- Nine channels self-bridge in their controllers' onModuleInit — src/ipc-main-bridge.ts:27-37
- All ipcMain wiring is skipped when `process.versions.electron` is unset — src/ipc-main-bridge.ts:125, controllers/logs.controller.ts:36, iac.controller.ts:569, iac-runs.controller.ts:175, iac-settings.controller.ts:114, folder-upload.controller.ts:41
- Default app menu is removed — src/electron-entry.ts:206
- Window is 1200x800, contextIsolation + sandbox, preload at out/preload/preload.cjs — src/electron-entry.ts:168-183
- target=_blank links open in the OS browser and the new window is denied — src/electron-entry.ts:44-51
- Renderer load failure or Nest bootstrap failure quits the app — src/electron-entry.ts:196-199, 238-241
- App quits on window-all-closed except on macOS; macOS activate recreates the window and re-attaches WindowService — src/electron-entry.ts:232-236, 246-248
- macOS traffic lights move between x=252 and x=12 at the 768 CSS-px breakpoint, zoom-aware — src/electron-entry.ts:144-156
- Windows uses titleBarOverlay #1a1d2e/#e1e4ed height 56; Linux draws its own buttons — src/electron-entry.ts:108-114
- Auto-update check runs at boot only if `enableAutoUpdate` is set; default makes zero feed requests — src/updater.ts:74-80
- Updater never auto-downloads or auto-installs — src/updater.ts:25-26
- A failed primary update check retries once against the newest GitHub release carrying the platform feed file, then restores the primary feed — src/updater.ts:40-61, src/updater-fallback.ts:48-83
- Manual download re-runs the check once if electron-updater reports "Please check update first" — src/updater.ts:213-221
- Install relaunches the app after quitAndInstall — src/updater.ts:249
- enableAutoUpdate changes only take effect on next launch — controllers/iac-settings.controller.ts:243-247
- Cloud bindings resolve by ConfigService.getActiveCloud(); anything but 'aws' throws "Unsupported cloud provider" — modules/cloud-provider.module.ts:193-226
- Store configs resolve lazily per call, preferring deployed `outputs.awsRegion` over the wizard region for audit/discord/runs — modules/cloud-provider.module.ts:101-184
- The runs table name falls back to a deterministic pre-apply name from the persisted DeploymentConfig — modules/cloud-provider.module.ts:174-175
- PulumiService gets RunRecord/RemoteFileStore/DeploymentConfig tokens via ModuleRef strict:false to avoid an ESM module cycle — modules/run-record.module.ts:22-42, pulumi-service.module.ts:16-25
- games.list/games.status invalidate only the DeploymentConfig cache, never the stack-outputs cache — controllers/games.controller.ts:54, 74
- games.list computes drift locally from one S3 read + one outputs read — controllers/games.controller.ts:55-57
- Game write channels return GameWriteResult and never throw — controllers/games.controller.ts:113-152
- Games are started only via RunTask (no ECS Service) — controllers/games.controller.ts:91-100
- Cost estimate falls back to 2048 CPU / 8192 MiB per game; total rounded to 4 dp — controllers/costs.controller.ts:39, 46
- Env label is 'PROD' iff a domain is deployed, else 'local' — controllers/env.controller.ts:23-28
- Discord putConfig logs only field presence; redacted config never carries raw secrets — controllers/discord.controller.ts:52-57, 33-40
- Removing a base (deployment-config) guild is rejected — controllers/discord.controller.ts:118-121
- Log streams use per-stream uuid channels `<prefix><id>.chunk/.end/.cancel`; AbortError ends cleanly — controllers/logs.controller.ts:151-196
- Folder-upload progress is broadcast to every open window on `folderUpload.progress` — controllers/folder-upload.controller.ts:45-49
- Plan acks immediately with a pre-minted runId; a busy workspace returns `{ started:false, conflict }` — controllers/iac.controller.ts:721-735, 794
- Apply/destroy ack only after the PulumiService gate passes; gate failures map to conflict/runLock/staleLock — controllers/iac.controller.ts:832-866, 988-1016
- Apply's runId equals the planRunId; destroy mints a fresh runId — controllers/iac.controller.ts:827, 983
- Streaming loops call `stream.return()` and stop sending once the WebContents is destroyed — controllers/iac.controller.ts:770-774, 894-898, 1036-1040
- End messages use exitCode 0 on success, null on failure — controllers/iac.controller.ts:780, 786
- Plan approver is the local OS username, never client-supplied — controllers/iac.controller.ts:1120, 1359-1361
- Accepted plan/apply/destroy/approve/rollback each write a workspace-wide audit entry (game '') — controllers/iac.controller.ts:755, 885, 1029, 1126, 1285
- Rollback resolve never fails on diff errors; diff is just omitted — controllers/iac.controller.ts:1174-1189
- Rollback confirm awaits the whole restore+plan unit and recovers versionId from the persisted run record; plan failure after restore still returns the restored versionId — controllers/iac.controller.ts:1236-1302
- Stack-init phase transitions are logged even after the renderer closes — controllers/iac.controller.ts:653-663
- iac.output ignores `force` — controllers/iac.controller.ts:1088
- Run detail reports 'running' when runId matches the held apply lock — controllers/iac-runs.controller.ts:219-222
- Run-lock clear tokens are bound to the displayed lock's runId; mismatches become BadRequest — controllers/iac-runs.controller.ts:383-391
- Deployment-settings writes map OptimisticLockError → conflict, RunsTableRenameError → validation, missing bucket → setup_incomplete — controllers/iac-settings.controller.ts:170-197
- wizardCompleted defaults to true under HYVEON_TEST_MODE when unset — controllers/wizard.controller.ts:168
- wizard.state.save rejects any activeCloud other than 'aws' at runtime — controllers/wizard.controller.ts:197-199
- Wizard runs table is created with the default project-prefixed name — controllers/wizard.controller.ts:310
- Diagnostics tail returns the last 500 lines; export cancel is a silent `{status:'cancelled'}` — controllers/diagnostics.controller.ts:48, 84-86
- DIAGNOSTICS_LOG_DIR is userData/logs in Electron, else $DIAGNOSTICS_LOG_DIR or os.tmpdir() — src/app.module.ts:98-105
- CloudFormation bootstrap key is retained on stack delete except on failed create; secret key is a stack output — resources/cloudformation/iam-bootstrap.yaml:71-75, 87-89

## Cross-scope references

Into `app/packages/desktop-main/src/services/` (excluded from this sweep):
- Every controller is a thin delegator to a service: AuditService, CloudHealthService, CostService, EcsService, ConfigService, DiagnosticsService (+DIAGNOSTICS_LOG_DIR), DiagnosticsBundleService, DiscordConfigService, DiscordCommandRegistrar, DriftService (+computeDriftFromOutputs), FileManagerService, FolderScanService, FolderUploadService, GamesWriteService, GameWizardDraftService, DeploymentConfigService (+ConfigurationNotConfiguredError, RunsTableRenameError), mergeGameLists, LogsService, PulumiService (+PulumiOperationInFlightError, PulumiRollbackPlanFailedError, PulumiStackInitializationError, CONFIG_CACHE_INVALIDATOR, DEPLOYMENT_CONFIG_SERVICE, RUN_RECORD_PERSISTER, RUN_LOCK_SERVICE), PulumiEngineService (phase types), PulumiLockRecovery.PulumiUnrecognizedLockError, RunService (+RunLockChangedError, RunLockClearNotConfirmedError), RunRecordService, AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService, GuidedIamService, ElectronStoreService, SafeStorageService, WindowService, PublicIpService, Ec2Service, SchedulerService, PulumiWorkspaceService.
- modules/cloud-provider.module.ts uses services/awsCredentialSource.resolveAwsClientCredentialsWithSignature and services/EcsService.createAwsCloudProvider.
- modules/folder-upload.module.ts uses services/folderUpload/FileBrowserClient.FileBrowserClientFactory; testing/fake-filebrowser-* use FileBrowserApi types and folderUpload/ephemeralCert.EphemeralCert.
- resources/cloudformation/iam-bootstrap.yaml is rendered by GuidedIamService via resolveCloudFormationTemplatePath.

Into other packages:
- `@hyveon/shared`: errMessage, RunLockHeldError, OptimisticLockError, validateDeploymentSettingsPatch, computeRunDetailStatus, resolveRunsTableName, resolvePreApplyRunsTableName, DEPLOYMENT_CONFIG_DEFAULTS, CONFIGURATION_OBJECT_KEY, StackOutputs, DeploymentConfig, GameServer, GameListEntry, DriftReport, AuditPageResult, RunLock, RunPageResult, LambdaFunctionKey, cloud interfaces (CloudProvider, SecretsStore, RemoteFileStore, DiscordEventReceiver, AuditLogStore, DiscordConfigStore, RunRecordStore), updater result types, `@hyveon/shared/folderUpload` types; iamPolicy.generateHyveonDeployAllPolicy (referenced by the YAML).
- `@hyveon/cloud-aws`: AwsSecretsStore, AwsRemoteFileStore, AwsDiscordEventReceiver, AwsAuditLogStore, AwsDiscordConfigStore, AwsRunRecordStore (LOCK_PK/LOCK_SK mirrored in test-mocks/run-record-mock.ts).
- `@hyveon/infra`: tsconfig project reference; stack outputs consumed through ConfigService/PulumiService.
- `@hyveon/desktop-preload` (`src/hyveon-api.ts`): payload interfaces IacLockClearPayload, approve opts, IacApplyPayload, IacDestroyPayload must be kept in sync by hand (iac.controller.ts:250-252, 297-299, 401-403, 458-460); the preload invokes every channel listed above and subscribes to the side channels.
- `@hyveon/web`: renderer constants mirrored in electron-entry.ts (index.css colors, app-layout.component.tsx `hidden md:flex` / `w-60` / `h-14`); dashboard 20s poller GAME_STATUS_INTERVAL_MS backs games.status; iac.page.tsx reads ack.conflict; RollbackAction consumes confirmRollback's ack; e2e fixtures `e2e/fixtures/ipc-harness.ts`, `server-mocks.ts`, `stack-outputs.fixture.ts`, `playwright.integration.config.ts`, `integration-specs/*` import src/test-mocks/* (from dist) and use PulumiServiceStub; e2e specs rely on the HYVEON_TEST_MODE wizardCompleted default and `window.hyveon.__test.mock`.
- Repo root: `electron.vite.config.ts` (dev script, forces preload .cjs), `electron-builder.yml` (publish repo must equal RELEASES_REPO; extraResources for icon.png and cloudformation/), `build/icon.png`, `out/main|preload|renderer` layout.
- External services: GitHub Releases API + update feed (updater-fallback.ts), Discord REST (via registrar), AWS ECS/S3/DynamoDB/CloudWatch Logs/Secrets Manager/IAM/STS/CloudFormation console (via services).
