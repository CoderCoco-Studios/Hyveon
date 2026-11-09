# Arrow: helper-task

Put files onto a game's storage volume: the shared file-manager helper session, the in-app volume file browser, folder upload with progress, and `file_seeds` seeding during deploy.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Re-synced after the in-app file browser shipped (PRs #694-#699, #701): one main-process helper session per game, served over pinned HTTPS, is shared by the in-app file browser page and folder uploads; the external-browser modal and `files.*` channels are gone.

## References

### HLD
- `docs/high-level-design.md`

### LLD
- `docs/intent/helper-task/helper-task-design.md`

### EARS
- `docs/intent/helper-task/helper-task-specs.md` (168 specs)

### Tests
- desktop-main: `app/packages/desktop-main/src/controllers/folder-upload.controller.test.ts`, `app/packages/desktop-main/src/controllers/volume-files.controller.test.ts`, `app/packages/desktop-main/src/helper-quit-hook.test.ts`, `app/packages/desktop-main/src/services/Ec2Service.test.ts`, `app/packages/desktop-main/src/services/FileManagerService.test.ts`, `app/packages/desktop-main/src/services/FolderScanService.test.ts`, `app/packages/desktop-main/src/services/FolderUpload.integration.test.ts`, `app/packages/desktop-main/src/services/FolderUploadService.test.ts`, `app/packages/desktop-main/src/services/PublicIpService.test.ts`, `app/packages/desktop-main/src/services/SchedulerService.test.ts`, `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.test.ts`, `app/packages/desktop-main/src/services/folderUpload/ProgressAggregator.test.ts`, `app/packages/desktop-main/src/services/folderUpload/RegistryUploadBackend.test.ts`, `app/packages/desktop-main/src/services/folderUpload/uploadEngine.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/VolumeFilesService.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/helperVolumeLayout.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/localNames.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/transfers.test.ts`, `app/packages/desktop-main/src/services/volumeFiles/uploadReservations.test.ts`
- lambda: `app/packages/lambda/efs-seeder/src/handler.test.ts`
- shared: `app/packages/shared/src/fileManagerLogGroup.test.ts`, `app/packages/shared/src/folderUpload/paths.test.ts`, `app/packages/shared/src/volumeFiles/paths.test.ts`
- web (jsdom): `app/packages/web/src/components/folder-upload/folder-include-tree.component.test.tsx`, `app/packages/web/src/components/folder-upload/folder-seed-section.component.test.tsx`, `app/packages/web/src/components/folder-upload/folder-seed.utils.test.ts`, `app/packages/web/src/components/folder-upload/folder-upload-card.component.test.tsx`, `app/packages/web/src/components/folder-upload/folder-upload-progress-meter.component.test.tsx`, `app/packages/web/src/components/folder-upload/overwrite-confirmation.component.test.tsx`, `app/packages/web/src/components/stray-helpers-button.component.test.tsx`, `app/packages/web/src/components/volume-files/session-bar.component.test.tsx`, `app/packages/web/src/components/volume-files/use-volume-files.hook.test.tsx`, `app/packages/web/src/components/volume-files/use-volume-session.hook.test.tsx`, `app/packages/web/src/components/volume-files/use-volume-transfers.hook.test.tsx`, `app/packages/web/src/components/volume-files/volume-files.utils.test.ts`, `app/packages/web/src/pages/volume-files.page.test.tsx`
- web (Playwright): `app/packages/web/e2e/specs/volume-files.spec.ts`, `app/packages/web/e2e/specs/volume-files-electron.spec.ts`, `app/packages/web/e2e/integration-specs/helper-session.spec.ts`, `app/packages/web/e2e/integration-specs/volume-outputs.spec.ts`
- test doubles (non-test files that exist only for tests): `app/packages/desktop-main/src/testing/fake-filebrowser-server.ts`, `app/packages/desktop-main/src/testing/fake-volume-backend.ts`, `app/packages/desktop-main/src/test-mocks/ec2-mock.ts`, `app/packages/desktop-main/src/test-mocks/scheduler-mock.ts`, `app/packages/web/src/components/folder-upload/folder-upload.test-utils.ts`, `app/packages/web/src/components/volume-files/volume-files.test-utils.ts`, `app/packages/web/e2e/pages/VolumeFilesPage.ts`

### Code
- **desktop-main**
  - `app/packages/desktop-main/src/controllers/folder-upload.controller.ts`
  - `app/packages/desktop-main/src/controllers/volume-files.controller.ts`
  - `app/packages/desktop-main/src/helper-quit-hook.ts`
  - `app/packages/desktop-main/src/modules/folder-upload.module.ts`, `volume-files.module.ts`, `volume-files-api.module.ts`
  - `app/packages/desktop-main/src/services/Ec2Service.ts`
  - `app/packages/desktop-main/src/services/FileManagerService.ts`
  - `app/packages/desktop-main/src/services/FolderScanService.ts`
  - `app/packages/desktop-main/src/services/FolderUploadService.ts`
  - `app/packages/desktop-main/src/services/PublicIpService.ts`
  - `app/packages/desktop-main/src/services/SchedulerService.ts`
  - `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.ts`, `ProgressAggregator.ts`, `RegistryUploadBackend.ts`, `ephemeralCert.ts`, `tlsLaunch.ts`, `uploadEngine.ts`
  - `app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts`, `VolumeFileBackend.ts`, `VolumeFilesService.ts`, `fileOps.ts`, `helperVolumeLayout.ts`, `localFiles.ts`, `localNames.ts`, `textFiles.ts`, `transferOps.ts`, `transfers.ts`, `UploadLeaseService.ts`, `uploadReservations.ts`, `volumeFileErrors.ts`
- **lambda/efs-seeder**
  - `app/packages/lambda/efs-seeder/src/handler.ts`
  - `app/packages/lambda/efs-seeder/esbuild.config.mjs`, `package.json`, `tsconfig.json`
- **shared**
  - `app/packages/shared/src/fileManagerLogGroup.ts`
  - `app/packages/shared/src/folderUpload/index.ts`, `paths.ts`, `types.ts`
  - `app/packages/shared/src/volumeFiles/index.ts`, `paths.ts`, `types.ts`
- **web**
  - `app/packages/web/src/pages/volume-files.page.tsx`
  - `app/packages/web/src/components/volume-files/drop-zone.component.tsx`, `file-actions.component.tsx`, `file-table.component.tsx`, `name-dialog.component.tsx`, `server-banner.component.tsx`, `session-bar.component.tsx`, `text-editor-dialog.component.tsx`, `transfer-list.component.tsx`, `volume-breadcrumb.component.tsx`, `volume-browser.component.tsx`, `volume-picker.component.tsx`, `use-server-guard.hook.ts`, `use-volume-files.hook.ts`, `use-volume-session.hook.ts`, `use-volume-transfers.hook.ts`, `volume-files.utils.ts`
  - `app/packages/web/src/components/stray-helpers-button.component.tsx`
  - `app/packages/web/src/components/folder-upload/folder-include-tree.component.tsx`, `folder-seed-section.component.tsx`, `folder-seed.utils.ts`, `folder-upload-card.component.tsx`, `folder-upload-progress-meter.component.tsx`, `overwrite-confirmation.component.tsx`, `use-folder-seed.hook.ts`, `use-folder-upload-progress.hook.ts`

### Cited from other leaves
- `iac/program`: `app/packages/infra/src/program.ts` (`efsAccessPoints` and the new per-volume `efsVolumeAccessPoints` output, `:404-415,476-511`), `app/packages/infra/src/escapes.ts` (`defineEfsSeederInvocations`, synchronous seeder invocation during apply), `app/packages/infra/src/lambdas.ts` (per-game efs-seeder functions, `:711-721`), `app/packages/infra/src/efs.ts` (per-volume access points), `app/packages/infra/src/ecs.ts` (pre-created `/ecs/filebrowser-{game}` log groups, `:195-202`), `app/packages/infra/src/securityGroups.ts` (file-manager and efs-seeder groups), `app/packages/infra/src/iam.ts` (`filebrowser-scheduler` role, `:382,577`), `app/packages/shared/src/stackOutputs.ts` (`efsVolumeAccessPoints`, `:79-83`).
- `game-runtime/task-and-dns`: `app/packages/desktop-main/src/modules/aws.module.ts` (provides `FileManagerService`, `SchedulerService`, `PublicIpService`, `:48`), `EcsService.ts` (`findRunningTaskOrThrow`, `:242-268`, used by the fail-closed server guard).
- `game-server`: `app/packages/desktop-main/src/controllers/games.controller.ts` (`games.start` refuses while an upload holds the session, `:97-108`), `app/packages/web/src/pages/game-detail.page.tsx` (upload card and Files link, `:143`), `add-game-wizard.component.tsx` (`FolderSeedSection`).
- `game-runtime/task-and-dns`: `app/packages/web/src/pages/dashboard.page.tsx` (Files action navigates with `autoStart`, `:80`), `game-card.component.tsx` (Files button, `:266-268`).
- `deployment-config`: `DeploymentConfigService.ts` (game volumes for destination validation and layout planning).
- `operator-app/wizard-and-bootstrap`: `ElectronStoreService.ts` (folder selection and last-run state), `ConfigService.ts` (stack outputs, region).
- `operator-app/ipc-bridge`: `app/packages/desktop-main/src/controllers/validation.ts`, `app/packages/desktop-main/src/ipc-broadcast.ts` (`forwardToWindows`), preload `volumeFiles.*`/`folderUpload.*` channels and `uploadDropped` path resolution (`desktop-preload/src/preload.ts:488-525`), `app/packages/web/src/api.service.ts`.
- `operator-app/desktop-shell`: `app/packages/desktop-main/src/electron-entry.ts` (installs the quit hook, `:225`), `app/packages/desktop-main/src/services/NativeDialogService.ts` and `modules/native-dialog.module.ts` (open/save dialogs), `app/packages/web/src/app.component.tsx` (route `/games/:name/files`, `:109`).
- `operator-app/diagnostics`: `app/packages/web/src/components/DiagnosticsPanel.tsx` hosts `StrayHelpersButton`.

## Architecture

**Purpose:** Get bytes onto a game's EFS volumes without SSH, by three routes: an in-app file browser page that drives a main-process-owned FileBrowser Fargate task over pinned HTTPS (browse, edit, download, upload), a folder-to-volume upload that runs through the same session, and declarative `file_seeds` written by a per-game Lambda during the infra apply.

**Key Components:**
1. `HelperSessionRegistry` (`services/volumeFiles/HelperSessionRegistry.ts:123`): one session per game, reference-counted by holders (`browse`, `upload:<id>`, `download:<id>`, `:17`); `acquire` (`:159`) shares a launch, waits for public IP then pinned login before reporting `running` (`:471-513`); 5 min browse grace (`:126,655-663`); `withBackend` (`:294`) retries once after an operator-IP change; pin mismatch fails the session (`:320,331`); `stop`/`stopAll` notify before-stop listeners (`:224,415`).
2. `FileManagerService.launchHelper` (`FileManagerService.ts:306-490`): registers a throwaway `filebrowser-{game}` task definition with one EFS volume per mounted game volume (`:410-435`), the digest-pinned image (`:23-24`), a per-launch cert and HTTPS entry point (`:393-394`), an operator `/32` ingress rule (`:374`) and a 2 h auto-stop schedule (`:487,498-515`). Also `stop` (`:538`), `reauthorizeOperatorIp` (`:580`) and `sweepStrayHelpers` (`:611`) with CIDR reference-counted rule revocation (`:204-226`).
3. `helperVolumeLayout.ts`: `buildHelperVolumeLayout` (`:71`) maps `efsVolumeAccessPoints[game]` to `/srv/<dir>` mounts, with a first-volume fallback flagged `usedFallback` (`:76,88`); `toHelperPath` (`:120`).
3a. `UploadLeaseService` (`services/volumeFiles/UploadLeaseService.ts`): holds the game's start lease as holder `upload` for the life of the upload holders, with a 30 s heartbeat; the registry takes it on `acquire` of an `upload:` holder, drops it on `release` and entry drop, and force-stops the session when it is lost (`HELPER-FB-042` to `-047`).
4. `VolumeFilesService` (`VolumeFilesService.ts:73`) with `FileOps` (`fileOps.ts:50`) and `TransferOps` (`transferOps.ts:42`): validated, fail-closed file operations (list, mkdir, rename, delete, text read/write) and background downloads and uploads via `TransferManager` (`transfers.ts:129`); `UploadReservations` (`uploadReservations.ts:14`) keeps in-app writers off the same path.
5. `FileBrowserClient` (`folderUpload/FileBrowserClient.ts:116`): the only `VolumeFileBackend` (`volumeFiles/VolumeFileBackend.ts:57`) implementation, fingerprint-pinned TLS (`:125-133`), `PinMismatchError` fails closed (`:290`), zip archive support (`:248`). `RegistryUploadBackend` (`:19`) routes the upload engine through the registry.
6. `FolderUploadService` (`FolderUploadService.ts:105`): upload orchestrator; preflight guards (`prepare`, `:257-312`), run (`execute`, `:344-386`) holding `upload:<runId>`, overwrite confirmation, upload, verify; startup stray sweep (`:134-139`); manual sweep excludes registry-owned games (`:202-207`).
7. Upload engine (`folderUpload/uploadEngine.ts`): `uploadAll` (`:277`), `verifyUpload` (`:198`), `classifyUpload` (`:180`); concurrency 4, 3 attempts (`:27-31`). `ProgressAggregator.ts` publishes snapshots.
8. IPC controllers: `volume-files.controller.ts:26-43` (`volumeFiles.*`, plus `volumeFiles.session` and `volumeFiles.transfer` pushes, `:103-109`) and `folder-upload.controller.ts:49-125` (`folderUpload.*`, plus the `folderUpload.progress` push).
9. `createHelperQuitStopper` (`helper-quit-hook.ts`): the helper step of the quit coordinator `installOperationQuitHook`; stops owned sessions within the coordinator's bound.
10. `shared/volumeFiles` (`paths.ts` path and entry-name validation, `types.ts` IPC shapes and error codes) and `shared/folderUpload` (`planUpload`, `toRemotePath`, `validateDestination`).
11. efs-seeder Lambda (`lambda/efs-seeder/src/handler.ts:57`): writes each `file_seeds` entry under `/mnt/efs` with a traversal guard (`:27-49`); invoked synchronously from `infra/src/escapes.ts:252-260`.
12. Web: `volume-files.page.tsx` (route page, auto-start from the dashboard, `:52-59`), `components/volume-files/*` (session bar, picker, browser, editor, transfers, server guard), `folder-upload/*` (selection tree, card, meter, overwrite prompt), `stray-helpers-button.component.tsx`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Folder selection | `HELPER-SELECT-001` to `HELPER-SELECT-007` | 7 | 0 | 0 |
| Upload into the volume | `HELPER-UPLOAD-001` to `HELPER-UPLOAD-020` (no 007) | 19 | 0 | 0 |
| Upload helper reach and transport | `HELPER-REACH-001` to `HELPER-REACH-008` | 8 | 0 | 0 |
| Helper launch and lifetime | `HELPER-LAUNCH-001` to `HELPER-LAUNCH-008` | 8 | 0 | 0 |
| Helper tagging and stray cleanup | `HELPER-STRAY-001` to `HELPER-STRAY-006` | 6 | 0 | 0 |
| Progress meter | `HELPER-PROG-001` to `HELPER-PROG-006` | 6 | 0 | 0 |
| Resume and failure handling | `HELPER-RESUME-001` to `HELPER-RESUME-007` | 7 | 0 | 0 |
| Verification | `HELPER-VERIFY-001` to `HELPER-VERIFY-003` | 3 | 0 | 0 |
| Overwrite warning | `HELPER-OVER-001` to `HELPER-OVER-008` | 8 | 0 | 0 |
| Safety limits and state | `HELPER-SAFE-001` to `HELPER-SAFE-006` | 6 | 0 | 0 |
| IPC contract | `HELPER-IPC-001` to `HELPER-IPC-008` (no 003) | 7 | 0 | 0 |
| Deploy-time seeding | `HELPER-SEED-001` to `HELPER-SEED-006` | 6 | 0 | 0 |
| In-app file browser | `HELPER-FB-001` to `HELPER-FB-047` | 47 | 0 | 0 |
| Helper session registry | `HELPER-SESS-001` to `HELPER-SESS-008` | 8 | 0 | 0 |
| Volume layout | `HELPER-LAYOUT-001` to `HELPER-LAYOUT-005` | 5 | 0 | 0 |
| Upload reservations | `HELPER-RSV-001` to `HELPER-RSV-005` | 5 | 0 | 0 |
| Page transfers | `HELPER-XFER-001` to `HELPER-XFER-010` | 10 | 0 | 0 |
| Text editor | `HELPER-EDIT-001` to `HELPER-EDIT-004` | 4 | 0 | 0 |
| Application quit | `HELPER-QUIT-001` to `HELPER-QUIT-003` | 3 | 0 | 0 |

**Summary:** 173 of 173 active specs implemented; 0 deferred; 0 gaps. Retired IDs (`HELPER-UPLOAD-007`, `HELPER-BROWSE-001` to `-006`, `HELPER-IPC-003`) are listed at the end of the specs file.

## Key Findings

1. **efs-seeder is first-volume-only by design, and conditional.** Each seeder function mounts the first volume's access point and receives only `volumes[0].container_path` (`infra/src/lambdas.ts`, `infra/src/escapes.ts`); the shared game-server validator rejects a seed outside that path at save time (`IAC-PROGRAM-SEED-004`), and the handler validates its event and applies each seed's mode on rewrite. Functions exist only for games that declare `file_seeds` (`IAC-PROGRAM-LAMBDA-013`).
2. **A folder-upload run is guarded for its whole life.** The server is re-checked before each file (throttled, fail-closed, `FolderUploadService.serverGuard`); the run reserves its target paths in the `UploadReservations` instance shared with the file browser; cancel and a force-stop honour a start still in `preparing`; an upload acquires its session with `requireAutoStop`; a launch failure after the operator rule was added revokes it.
3. **Upload errors that the renderer acts on are coded.** `FolderUploadStartResult` carries `code: 'helper-open'` and a failed snapshot carries `errorCode: 'verification-failed'` with `failedPaths`; `withStopReason` still string-matches `'stopped before it was reachable'` (`HelperSessionRegistry.ts`) from `FileManagerService.ts`.
4. **A missing auto-stop schedule reaches the operator.** `autoStopWarning` rides the session snapshot and the renderer status, and the session bar shows it as a manual-stop warning; the quit coordinator `installOperationQuitHook` still bounds the helper stop (`createHelperQuitStopper`), so a session that also misses the backstop is caught only by the next startup sweep, which skips helpers younger than 15 min.
5. **Credentials and addresses stay in main, structurally.** Snapshots are built field by field and never read `credentials`, `cert` or `operatorIp` (`HelperSessionRegistry.ts:684-697`); the renderer status is re-mapped again and its error text passes through `scrubAddresses` (`VolumeFilesService.ts:38-50`, `volumeFileErrors.ts:75-77`); backend errors carry the helper address only in `cause` (`FileBrowserClient.ts:292`); IPC entry logs whitelist string identifiers (`volume-files.controller.ts:67-75`).
6. **Fail-closed server guard on every mutation.** `FileOps.assertWritable` uses `EcsService.findRunningTaskOrThrow` and turns any error into `server-check-failed` (`fileOps.ts:112-122`); the page latches the same block from a failed result until a later status reads `stopped` (`use-server-guard.hook.ts:30-47`). The folder-upload card does not: a failed status read leaves the upload button enabled (`folder-upload-card.component.tsx:52-53,62`), and only the main-process refusal stops it.
7. **`supportsArchive` has two sources of truth.** The snapshot reports `typeof backend.archiveStream === 'function'` (`HelperSessionRegistry.ts:694`) while the download probe checks `backend.supportsArchive` (`transferOps.ts:105`). They agree for `FileBrowserClient` (`:117,248`); a future backend that sets one without the other would show a folder download that then fails.
8. **Per-game progress snapshots are never cleared.** `latest` is set in `publish` (`FolderUploadService.ts:332`) and never deleted, so `getProgress` returns the last terminal snapshot for the life of the process (`:148-150`) [inferred: intended, so the card can show the last run]. Page-started runs publish to the same map, so the game detail card's meter can show a run started from the file browser page.
9. **Stray cleanup has no confirmation.** `StrayHelpersButton` stops every unowned helper regardless of age on one click (`stray-helpers-button.component.tsx:19-25`, `minAgeMs: 0` at `FolderUploadService.ts:205`); registry-owned sessions are now excluded (`:204`), so an open browse session survives, but a helper from another app instance on the same account does not.
10. **Ownership smell (sweep disagreement, final-clustering §6).** `PublicIpService`, `SchedulerService` and `FileManagerService` are still provided by `AwsModule` (`aws.module.ts:48`) rather than a helper-owned module, although `VolumeFilesModule` now exists (`volume-files.module.ts:6-11`). `use-folder-seed.hook.ts` sits under `components/` not `hooks/`. `VolumeFilesApiModule` exists only to break an import cycle with `FolderUploadModule` (`volume-files-api.module.ts:9-13`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/helper-task/helper-task-specs.md`; none remain open. Items with no matching gap spec carry none.

### Nice to Have
1. Treat a failed server status read as busy on the folder-upload card, matching the page's guard (finding 6).
2. Derive `supportsArchive` from one place (finding 7).
3. Move `PublicIpService`/`SchedulerService`/`FileManagerService` into `VolumeFilesModule`; move `use-folder-seed.hook.ts` to `hooks/` (finding 10).
4. Confirm before operator-requested stray cleanup (finding 9).
