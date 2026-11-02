---
parent: high-level-design
prefix: HELPER
---

# Helper Task

## Context and Design Philosophy

A game's data lives on its EFS volumes, and nothing in Hyveon gives the operator a shell on them. This leaf owns every way bytes reach a volume outside the game server itself: the in-app file browser page that lets the operator list, edit, download and upload files through a FileBrowser Fargate task that only the main process talks to (the helper session), the folder-to-volume upload that runs through the same session, and the declarative `file_seeds` that a per-game efs-seeder Lambda writes during the infra apply.

Browsing and uploading share one helper per game owned by `HelperSessionRegistry` (`app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts:123`). The registry is the only caller of `FileManagerService.launchHelper` (`app/packages/desktop-main/src/services/FileManagerService.ts:306-490`). `VolumeFilesService` (`services/volumeFiles/VolumeFilesService.ts:73`) serves the `volumeFiles.*` IPC channels, `FolderUploadService` (`services/FolderUploadService.ts:105`) orchestrates folder uploads, and every byte goes through the `VolumeFileBackend` interface (`services/volumeFiles/VolumeFileBackend.ts:57`), implemented today only by `FileBrowserClient` (`services/folderUpload/FileBrowserClient.ts:116`). The seeder is `app/packages/lambda/efs-seeder/src/handler.ts:57-93`.

Guiding principles visible in the code:

- **A helper is throwaway.** Every launch registers a fresh `filebrowser-{game}` task definition (`FileManagerService.ts:346,403`), and every stop deregisters it (`:529`). There is no persistent ECS Service.
- **One helper per game, owned by the main process.** Holders reference-count the session (`HelperSessionRegistry.ts:13-20,118-120`); an ECS helper the registry does not own is reported `orphaned` and never reused, because its credential is unknown (`:422-424,432`).
- **A helper is reachable only from the operator, only over pinned TLS.** The file-manager security group declares no ingress (`app/packages/infra/src/securityGroups.ts:342-343`); each launch opens a `/32` for the operator's detected public IPv4 (`FileManagerService.ts:367-377`, `PublicIpService.ts:18-30`) and serves HTTPS with a per-launch certificate (`:393-394`) that `FileBrowserClient` pins by fingerprint (`FileBrowserClient.ts:125-133`).
- **A helper always has a bounded life.** A one-time EventBridge Scheduler schedule stops the task after 2 h (`FileManagerService.ts:44,498-515`), because the watchdog only evaluates `{game}-server` tasks (`:36-43`). Sessions also end with use: a 5 min grace after the page leaves (`HelperSessionRegistry.ts:126`), immediate teardown when the last upload releases (`:203-210`), and a quit hook (`app/packages/desktop-main/src/helper-quit-hook.ts:27-57`).
- **Secrets and addresses stay in the main process.** The credential, certificate and helper IP live on the registry's private entry (`HelperSessionRegistry.ts:64-85`) and never on a snapshot (`:684-697`); the renderer receives volume names, container paths, file metadata and coded results (`app/packages/shared/src/volumeFiles/types.ts:17-31,61-78`).
- **Mutations fail closed.** Every write is refused while the game's server task exists or cannot be confirmed stopped (`services/volumeFiles/fileOps.ts:112-122`, `FolderUploadService.ts:290-297`).

What this leaf deliberately does not own:

- The per-volume EFS access points, the `efsAccessPoints` and `efsVolumeAccessPoints` stack outputs, the file-manager and efs-seeder security groups, the `/ecs/filebrowser-{game}` log groups, the `filebrowser-scheduler` IAM role, and the seeder functions and their invocation all live in `iac/program` (`infra/src/program.ts:404-415,476-511`, `ecs.ts:195-202`, `securityGroups.ts:336-346`, `lambdas.ts:711-721`, `escapes.ts:249-260`).
- `EcsService` (task listing, `RunTask`, `StopTask`, `findRunningTaskOrThrow`) and the `AwsModule` that provides `FileManagerService`, `SchedulerService` and `PublicIpService` belong to `game-runtime/task-and-dns` (`app/packages/desktop-main/src/modules/aws.module.ts:48`).
- `games.start`, which refuses while an upload holds the session (`app/packages/desktop-main/src/controllers/games.controller.ts:97-108`), belongs to `game-server`; this leaf only supplies `hasUploadHolders` (`HelperSessionRegistry.ts:380-383`).
- Game volumes come from `deployment-config` (`DeploymentConfigService.getGameServers()`, `FileManagerService.ts:145`, `FolderUploadService.ts:271`); folder selection storage comes from `operator-app/wizard-and-bootstrap` (`ElectronStoreService.ts:289,653-668`).
- The preload bridge (including `uploadDropped`'s path resolution, `desktop-preload/src/preload.ts:515-521`), `forwardToWindows` (`desktop-main/src/ipc-broadcast.ts`) and payload helpers belong to `operator-app/ipc-bridge`; `NativeDialogService`, the route table and the quit-hook installation (`electron-entry.ts:225`) belong to `operator-app/desktop-shell`.

CLAUDE.md invariants that apply here: no persistent ECS Service (helpers are `RunTask`-only), secrets never reach the renderer (the credential, certificate and helper address never cross IPC), the desktop app has no HTTP transport (all helper control is Electron IPC; the HTTPS traffic is main process to helper), every `@MessagePattern` handler logs on entry (`volume-files.controller.ts:206,244,258`, `folder-upload.controller.ts:49-125`), and new AWS-touching code stays out of the `@hyveon/shared` barrel (`shared/src/volumeFiles` and `shared/src/folderUpload` are subpaths with no SDK imports).

## Helper Session Lifecycle

### Holders and states

A session entry holds `state` (`starting`, `running`, `stopping`), a `holders` set, the launch outcome and an optional grace timer (`HelperSessionRegistry.ts:61-85`). The renderer-visible state adds `stopped`, `orphaned`, `failed` and `not_deployed`, derived when no entry exists (`:700-715`).

| Holder | Who | Blocks `games.start` | Launches a helper |
|---|---|---|---|
| `browse` | The file browser page, via `attach` on mount and `detach` on unmount (`use-volume-session.hook.ts:80-89`) | No | Yes, through `volumeFiles.session.start` |
| `upload:<runId>` | A folder-upload run (`FolderUploadService.ts:349,397`) | Yes | Yes |
| `upload:xfer-<id>` | A file-browser upload transfer (`transfers.ts:167`) | Yes | No, joins a running session only (`:152-155`) |
| `download:xfer-<id>` | A download transfer | No | No |

`acquire` joins an existing entry, or waits out a teardown and then launches (`HelperSessionRegistry.ts:159-179`). Concurrent acquires share one `ready` promise. `release` drops a holder; releasing `browse` always starts the 5 min grace timer, and any last release with no timer pending stops the session at once (`:203-210,655-663`). `attach` re-adds `browse` and cancels the timer (`:187-193`).

`stop` (an explicit Stop, Restart or quit) runs the before-stop listeners first, which cancel the folder-upload run (`FolderUploadService.ts:128-130`) and abort every page transfer (`VolumeFilesService.ts:89`), then closes the backend and stops the task (`HelperSessionRegistry.ts:224-238,580-613`). With no owned entry, `stop` stops an orphaned helper if one exists (`:229-237`).

### Launch and readiness

`launch` checks for an unowned `filemgr-{game}` task (orphaned, nothing launched), plans the volume layout, calls `launchHelper`, then waits for readiness (`HelperSessionRegistry.ts:420-455`). A session is `running` only after the task has a public IP (polled every 3 s for up to 3 min, `:126-129,488-498`) and the pinned login succeeds (retried for up to 2 min, `:501-513`); this replaced the old modal's stop-early polling by construction (archived `design.md` D9). A pin mismatch aborts without retrying (`:509`). Any failure goes through `failSession`, which stops a task that did launch so its rule is revoked, and keeps the reason for `status` until the next acquire or stop (`:541-551`).

`launchHelper` runs these steps, failing with a modeled `{ ok: false, code, message }` rather than throwing (`FileManagerService.ts:79-93,306-490`):

| Step | Behaviour | Location |
|---|---|---|
| 1. Stack outputs and layout | Refuses when not deployed, when the layout mounts nothing, or when `fileManagerSecurityGroupId` is missing. | `:310-322` |
| 2. One helper per game | Any `startedBy: filemgr-{game}` task returns `code: 'helper-open'`; the registry maps it to `orphaned`. | `:325-333` |
| 3. Execution role | Borrows `executionRoleArn` from the game's own task definition. | `:336-342` |
| 4. Credential | Random 18-byte base64url password, bcrypt cost 10; the hash goes to the container. | `:29-34,352-353` |
| 5. Audit record | Best-effort write of the hash to `fileBrowserCredentialSecretArn`. | `:355-364` |
| 6. Operator IP and ingress | `PublicIpService.detect()` (5 s timeout), then `authorizeIngress(sg, ip/32, 8080, "hyveon-filemgr:{game}:{runId}")`. | `:367-377`, `PublicIpService.ts:7,18-30` |
| 7. TLS | Per-launch self-signed P-256 cert wrapped into an `sh -c` entry point that execs FileBrowser with `--cert/--key`. | `:393-394`, `ephemeralCert.ts:26-48`, `tlsLaunch.ts:22-35` |
| 8. Task definition | Fargate 256 / 512, `filebrowser/filebrowser:v2.63.23@sha256:…`, one EFS volume per mount with transit encryption, each mounted read-write at `/srv/<dir>`. | `:23-24,403-446` |
| 9. RunTask | `startedBy: filemgr-{game}`, public IP, file-manager SG; tag `OperatorIp` always, plus `Purpose=seed-upload`, `Project=hyveon` when an upload launched it. | `:456-470`, `FolderUploadService.ts:397` |
| 10. Auto-stop | `filemgr-stop-{game}` one-time schedule targeting `ecs:stopTask`; failure returns a `scheduleWarning` string. | `:487,498-515`, `SchedulerService.ts:101-131` |

Two defects live here. First, `generateEphemeralCert` and `registerTaskDefinition` run after the ingress grant with no surrounding try, so a throw skips `cleanupAfterFailure` (`:374,380-383,393,403`), and `failSession` has no `taskArn` to stop (`HelperSessionRegistry.ts:544`); the rule survives until the next stop or sweep. Second, the registry copies every outcome field except `scheduleWarning` (`HelperSessionRegistry.ts:435-443`), so a session without an auto-stop schedule gives the operator no signal at all; before the merge the browse modal showed it.

### Volume layout

`buildHelperVolumeLayout` (`services/volumeFiles/helperVolumeLayout.ts:71-104`) maps each declared volume with an access point in `efsVolumeAccessPoints[game]` to a task volume `vol-<index>` mounted at `/srv/<dir>`. `<dir>` is the volume name when it is a safe, unique segment that does not look like `volume-N`, otherwise `volume-<index>` (`:5-7,80-81,98`). Volumes without an access point are listed as unmounted. When the stack predates the per-volume output, only the first volume is mounted through `efsAccessPoints[game]` and the layout is flagged `usedFallback` (`:76,83-88`); because that access point's volume identity is unconfirmed after a possible reorder, every mutation and every folder upload is refused under the fallback (`fileOps.ts:102`, `FolderUploadService.ts:276-278`; archived `design.md` D12). `toHelperPath` turns a clean volume path into `/<dir><path>` (`helperVolumeLayout.ts:120-125`). The layout never crosses IPC (`:22`).

### Operator-IP change and pin failure

`withBackend` runs an operation against the live backend (`HelperSessionRegistry.ts:294-307`). On `unreachable` it detects the current public IP; if it changed, `FileManagerService.reauthorizeOperatorIp` authorizes the new `/32`, re-tags the task's `OperatorIp`, and revokes rules no running helper needs while always keeping the new CIDR (`FileManagerService.ts:580-601`), then the operation is retried exactly once (`HelperSessionRegistry.ts:337-367`). Concurrent failures share one recovery. A pin mismatch instead fails the session once and stops its helper (`:320,331-334`). `RegistryUploadBackend` refuses to replay a consumed upload stream on that retry, so the upload engine reopens the file (`folderUpload/RegistryUploadBackend.ts:71-78`).

### Teardown and rule reference counting

`FileManagerService.stop` stops the task, deletes the schedule (missing counts as success), deregisters the definition, and in a `finally` revokes orphaned rules even when no task was found (`FileManagerService.ts:522-563`, `SchedulerService.ts:143-148`). The security group is shared and `authorizeIngress` treats a duplicate rule as success, so rules are reference-counted by CIDR from every remaining helper's `OperatorIp` tag; a remaining helper without the tag, or a failed listing, keeps every rule (`:189-242`).

### Quit

`installHelperQuitHook` does nothing when the registry owns no session; otherwise it prevents the first `before-quit`, races `stopAll` against a 5 s timeout, and calls `quit()` again, letting the second `before-quit` through (`helper-quit-hook.ts:12,27-57`). Survivors are left to the auto-stop schedule and the next startup sweep. `verify.md` section 7 records that `quitAndInstall` with an owned helper and real OS drag-and-drop were not tested against a live stack.

## File Browser Page and Operations

### Page and session UI

`/games/:name/files` (`app.component.tsx:109`) is reached from the dashboard Files button, which navigates with `state.autoStart` (`dashboard.page.tsx:80`), and from the game detail page (`game-detail.page.tsx:143`). The page starts the session once on arrival with `autoStart` and clears the router state; any other entry only shows state (`web/src/pages/volume-files.page.tsx:52-59`). `useVolumeSession` attaches on mount, detaches on unmount, applies `volumeFiles.session` pushes, and polls every 3 s while starting or stopping and every 30 s while running (`web/src/components/volume-files/use-volume-session.hook.ts:9-15,80-112`). `SessionBar` shows the state badge, elapsed time and auto-stop countdown with a warning under 10 minutes, offers Start (stopped or failed), Stop (running; confirmed when any upload or download runs) and Restart (orphaned only) (`session-bar.component.tsx:51-129`, `AUTO_STOP_WARNING_MS` at `shared/src/volumeFiles/types.ts:5`). An unmounted volume is listed but disabled in the picker with an apply hint (`volume-picker.component.tsx:13-43`).

### IPC contract

| Channel | Service call | Result |
|---|---|---|
| `volumeFiles.session.status` / `start` / `attach` / `detach` | `sessionStatus`, `sessionStart` (acquire in background), `sessionAttach`, `sessionDetach` | `VolumeSessionStatus` |
| `volumeFiles.session.stop` / `restart` | `registry.stop`, then (restart) acquire in background | `VolumeResult<VolumeSessionStatus>` |
| `volumeFiles.list` / `mkdir` / `rename` / `delete` | `FileOps.run` | `VolumeResult<VolumeListing \| VolumeEntryInfo \| true>` |
| `volumeFiles.readText` / `writeText` | text read and mtime-checked write | `VolumeResult<VolumeTextFile \| { modifiedMs }>` |
| `volumeFiles.download` / `uploadFiles` / `uploadFolder` / `cancelTransfer` | `TransferOps` | transfer id, folder-upload start result, or `{ cancelled }` |
| `volumeFiles.session`, `volumeFiles.transfer` (push) | registry and transfer listeners | status and progress to every window |

(`controllers/volume-files.controller.ts:26-43,103-109`, `VolumeFilesService.ts:97-374`.) Every handler validates its own payload and answers a malformed one with an `invalid-path` failure or a failed status rather than throwing (`volume-files.controller.ts:238-260`). Failures carry a `VolumeFilesErrorCode` and a fixed operator message; backend messages, which embed helper mount paths, are only logged (`volumeFileErrors.ts:17-21,42-53,91-97`). Session error text is scrubbed of URLs and IPv4 literals before it crosses (`VolumeFilesService.ts:38-50`, `volumeFileErrors.ts:75-77`).

### Validation and the read-only guard

`FileOps.run` validates paths and names, checks the server for a mutation, then runs inside `withBackend`, where it refuses a volume the session did not mount (or names an unapplied one) and mutations of a fallback layout (`fileOps.ts:64-104`). Paths must be clean absolute POSIX paths with no NUL, backslash, empty, `.` or `..` segment, and entry names must be a single segment of at most 255 UTF-8 bytes (`shared/src/volumeFiles/paths.ts:20-67`). The volume root can never be renamed or deleted (`fileOps.ts:30-34`). `assertWritable` turns any error from `findRunningTaskOrThrow` into `server-check-failed` (`:112-122`); the page mirrors this with `useServerGuard`, which blocks while the poll says starting, running or error, and latches a `server-running` or `server-check-failed` result until a later status reads `stopped` (`use-server-guard.hook.ts:30-56`), with a Retry banner (`server-banner.component.tsx`).

### Text editor

`readText` refuses a folder, a stat size over 1 MiB, a read that exceeds 1 MiB, and bytes with a NUL or invalid strict UTF-8 (`VolumeFilesService.ts:258-272`, `textFiles.ts:4-27`). `writeText` refuses content over 1 MiB, reserves the path, and refuses when either modification time is unknown or they differ (`VolumeFilesService.ts:288-319`). The dialog keeps its text on a failed save, re-reads when the saved mtime could not be read back, and stays mounted with Save disabled when the session ends (`text-editor-dialog.component.tsx:69-78`, `volume-browser.component.tsx:27-34,159-169`). Edit is offered only for files of at most 1 MiB (`file-actions.component.tsx:69`).

### Transfers and reservations

`TransferManager` runs transfers in the background: it joins only a running session, holds it as `download:xfer-<id>` or `upload:xfer-<id>`, throttles `running` events to 150 ms, and releases the hold before the final event (`transfers.ts:14,129-261`). A download is probed before the save dialog opens, its default name is sanitized for Windows, and the bytes go through an exclusive, uniquely named `.part` file renamed over the target only on success (`transferOps.ts:99-139`, `localNames.ts:22-31`, `transfers.ts:37-60`). A file-browser upload refuses everything up front (a dropped item that resolved to an empty path, a running server, no session, a non-regular file, a duplicate name, an existing target), reserves its targets, writes with `overwrite: false`, re-checks the server before each file, and removes a partial target on failure (`transferOps.ts:156-251,306-318`, `localFiles.ts:21-31`).

`UploadReservations` is an in-process per-game set of target paths, all-or-nothing and non-blocking, because FileBrowser's `overwrite=false` is a check followed by a truncating open (`uploadReservations.ts:1-42`). Only text saves and file-browser uploads use it (`VolumeFilesService.ts:301`, `transferOps.ts:172`). Folder-upload runs write with `overwrite: true` (`folderUpload/uploadEngine.ts:251`) and reserve nothing, so they can race a text save of the same file.

## Folder Upload Run

### Guards

`startUpload` reserves the game in a `preparing` set synchronously, runs `prepare()`, persists the selection (only for card-started runs), moves the game into `active`, and starts `execute()` in the background (`FolderUploadService.ts:217-248`). `prepare()` refuses, with the first failure as a plain `Error` message, when (`:257-312`): the request is malformed or a run is active; the scan has expired (`FolderScanService` holds at most 8, `FolderScanService.ts:20,51`); there are no stack outputs ("your selection is kept"); the game is unknown or `validateDestination` rejects the destination; the destination volume is unmounted or the layout is the fallback; the plan is empty; the server is running or cannot be confirmed stopped; or an orphaned helper is running ("Restart it, then retry").

`cancel(game)` consults only `active` (`:183-187`), so a cancel, or a force-stop's before-stop listener, arriving while the game is still in `preparing` does nothing and the run starts anyway. The server is checked only in `prepare` (`:290-297`); the `upload:` holder that blocks `games.start` is added only when `execute` acquires (`:349,355`), and no check runs during `uploadAll`.

### Run phases

`execute()` drives a `ProgressAggregator` through `FolderUploadPhase` values (`shared/src/folderUpload/types.ts:2-9`, `FolderUploadService.ts:344-386`):

| Phase | Work | Exit |
|---|---|---|
| `starting-helper` | Acquire `upload:<runId>` with upload tags, rejecting early on cancel (`:396-420`); a joined browse session is reused. Map the plan onto the session's own layout (`:439-452`). | Refused acquire or an unmounted destination fails the run. |
| `awaiting-confirmation` | Only when the plan overwrites existing files of a different size; waits for `confirmOverwrite`, 10 min timeout. A resume of this card's own cut-short run with conflicts at or below the engine concurrency is not prompted. | Decline or timeout cancels (`:464-516`). |
| `uploading` | `ensureDirs`, then `uploadAll` through `RegistryUploadBackend`. | First file to exhaust attempts fails the run. |
| `verifying` | `verifyUpload` lists every parent directory and compares per-file size. | Mismatch fails with `Verification failed: ...`, at most 5 paths named (`:46,369-376`). |
| `done` / `failed` / `cancelled` | `finally` releases the hold (the registry stops a helper nothing else holds), records `lastRun` when the run persists its selection, and emits the terminal snapshot. | `:382-385,519-535` |

A failure gains the session's ECS stop reason when the helper vanished mid-run (`:428-432`). Runs started from the file browser page pass `persistSelection: false`, so they neither replace the card's selection nor count existing files as their own partials (`:79-93,309`, `transferOps.ts:285`).

### Transfer engine

`uploadAll` skips files already present at the expected size, then uploads the rest through a pool of 4 with 3 attempts and a `500 ms * attempt` backoff (`folderUpload/uploadEngine.ts:27-31,277-312`). A size or mtime change since the scan is a permanent `FileChangedError` (`:245`). Cancellation, a changed file, pin, auth, not-found and conflict failures, and 4xx other than 408/429 are not retried (`:210-221`). `FileBrowserClient` speaks FileBrowser v2 REST (`/api/login`, `/api/resources`, `/api/raw`, `?algo=zip`, `PATCH ?action=rename`) and maps every failure to a `VolumeFileError` code (`FileBrowserClient.ts:104-115,143-294`). `ProgressAggregator` emits a snapshot every 500 ms, forwarded on `folderUpload.progress` (`folder-upload.controller.ts:39-41`). `FolderUploadService.latest` keeps each game's last snapshot for the process lifetime (`FolderUploadService.ts:116,148-150,331-334`).

### Destination mapping

`validateDestination` accepts a clean absolute destination under any of the game's volumes and returns the deepest matching mount (`shared/src/folderUpload/paths.ts:87-100`). `toRemotePath` strips that volume's `container_path` and returns a path inside the volume (`:61-80`), which the run prefixes with the volume's mount directory through `toHelperPath` (`FolderUploadService.ts:448`). This is the fix for the shipped wrong-volume upload (archived `design.md` D13): a destination under a second volume now lands in that volume.

### State and IPC contract

Per-game state `{ localPath, include, destination, lastRun }` lives in electron-store under `folderUpload`, never in `deployment-config.json` (`ElectronStoreService.ts:289,653-668`). The `folderUpload.*` channels are unchanged in shape (`folder-upload.controller.ts:49-125`): pick, rescan, get/set/clear selection, start, cancel, confirm overwrite, get progress, cleanup stray helpers, and the `folderUpload.progress` push. Error outcomes still cross as message strings that the web layer pattern-matches: the card detects an orphaned helper with `/already open/i` (`folder-upload-card.component.tsx:25,87`) and offers to stop it through `volumeFiles.session.stop` and retry (`:94-110`); the meter parses the `Verification failed: ` prefix (`folder-upload-progress-meter.component.tsx:37`). The card also treats a failed server status read as "not busy" (`folder-upload-card.component.tsx:52-53,62`), unlike the page's guard; the main-process refusal still stops the upload.

## Stray Helper Cleanup

`sweepStrayHelpers({ activeGames, minAgeMs })` lists every `filemgr-*` task, tears down each one whose game is not in `activeGames` and whose age is at least `minAgeMs`, then revokes rules no remaining helper or active game needs (`FileManagerService.ts:611-654`). Per-task failures go into `StrayHelperReport.errors`.

At application bootstrap, under Electron only, `FolderUploadService` sweeps helpers older than 15 minutes (`FolderUploadService.ts:44,134-139`). The operator's "Clean up stray helpers" action sweeps with `minAgeMs: 0` and `activeGames` set to both active runs and every registry-owned game (`:202-207`), so an open browse session survives. `StrayHelpersButton` triggers it with one click and no confirmation (`app/packages/web/src/components/stray-helpers-button.component.tsx:19-25`).

## Deploy-Time Seeding

`file_seeds` entries in a game's `GameServerConfig` are written by a per-game efs-seeder Lambda, provisioned only for games that declare seeds (`infra/src/lambdas.ts:711`) and mounted on that game's first volume's access point at `/mnt/efs` (`:719-721`; mount constant `handler.ts:19-20`). The infra program invokes it synchronously through an `aws.lambda.Invocation` whose trigger is a hash of the seeds, so seeds rewrite only when they change (`infra/src/escapes.ts:249-260`).

The event is `{ game, seeds, container_path }`, where `container_path` is always `volumes[0].container_path` (`escapes.ts:250`, `handler.ts:12-17`). For each seed the handler strips that prefix, resolves under `/mnt/efs` with a traversal guard, rejects a seed with both or neither of `content` and `content_base64`, validates an octal `mode` (default `0644`), creates parent directories, and writes the file (`handler.ts:27-49,62-90`). Any error throws, failing the apply (`:51-56`). The event is destructured without validation (`:58`), and `writeFileSync`'s `mode` applies only on create (`:87`). The helper now mounts every volume, so seeding is the only route still limited to the first volume.

The post-apply runtime check (IAC-PROGRAM-RUNTIME-003 in `docs/intent/iac/program/program-specs.md`) must treat efs-seeder as conditional: a function exists only for games that declare seeds (`lambdas.ts:711`), so a check that expects it in every deployment would disagree with the provisioning.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Browse surface | Native renderer page backed by `volumeFiles.*` IPC; main calls the helper's REST API | `WebContentsView` embedding FileBrowser's SPA in an in-memory partition (pinned certificate, navigation allowlist, token seeded by cookie or proxy-auth header); a hybrid of native core plus embedded SPA as "Advanced"; keeping the external browser and only fixing its rough edges | FileBrowser is archived, so embedding its SPA would put unpatched remote UI in the operator console and leave a token in renderer-adjacent storage (proxy auth trusts anyone who can set the header). A `WebContentsView` also draws above all renderer DOM, so dialogs and toasts cannot overlay it and bounds must be synced over IPC. The hybrid inherits those costs for long-tail features. The external browser keeps a plaintext credential, a hand-copied password and a fragile egress-IP match. The native page keeps the credential in main, matches theme and accessibility, and is testable with the existing seams. |
| Transport | Public IP plus operator `/32` plus pinned per-launch TLS, for browse and upload alike | SSM/ECS Exec port-forward; Caddy sidecar with ACME; Lambda mounted on EFS | With main as the only client, the IP the app detects is the IP requests come from, so the egress-mismatch failure class disappears; pinning removes the plaintext credential; no infra change. Port-forwarding needs a host `session-manager-plugin` binary. ACME costs DNS plus issuance per launch for a client that can pin instead. Lambda on EFS is deferred as a future backend. |
| Upload write path | Drive FileBrowser's REST API from the main process through the helper session | S3 staging plus a seeder Lambda; an ECS init container; SFTP or NFS from the operator machine | Staging needs extra infra, has a 15-minute ceiling and reports progress only through a side channel. An init container reports progress only in logs and delays the first `/server-start`. EFS is not reachable from outside the VPC, ruling out SFTP and NFS. The helper needs no new infrastructure and its bytes are directly observable. |
| Upload concurrency | Up to 4 files in flight, whole files, FileBrowser's single streamed POST | Splitting large files; the TUS chunked endpoint | Per-file resume by size is enough up to roughly 200 MB files; TUS is worth revisiting only if larger files appear. |
| Session ownership | One main-process `HelperSessionRegistry` entry per game, reference-counted by holders | Persisting credentials (safeStorage) to survive restarts; separate browse and upload helpers | Persisting widens secret storage for a rare case and Restart is cheap. Separate helpers break the one-helper-per-game invariant and the shared rule accounting, and double the cost. One shared session also removes the premise of the old "helper already open" refusal, which existed because a running helper's credential was unknown. |
| Backend boundary | `VolumeFileBackend` interface, `FileBrowserClient` the only implementation, used by the upload engine too | A second FileBrowser client in a new service | A second client would duplicate the HTTP layer, which the duplication rule forbids. The interface bounds the archived dependency to one class, so replacing it is a desktop-main-only change (follow-up issue #700). |
| IPC payloads | Names, sizes, times, coded results and progress; local paths only from main dialogs or preload drag-and-drop | Streaming file bytes over IPC | Main reads and writes local paths directly, so only paths and progress cross IPC. This enforces "secrets never reach the renderer" structurally: the renderer cannot open a connection to the helper. |
| Path safety | Validate every volume path and name in main before the backend sees it | Trust FileBrowser's `--root` jail | Defence in depth, and required for any future backend without such a jail. |
| Writes while the server runs | Refuse, failing closed when the state is unknown | Allow with a confirm; fail open on a check error | Concurrent EFS writes under a live server can corrupt saves, and an unconfirmed state is treated as unsafe. The operator rejected fail-open. `findRunningTask` swallows ECS errors and reads as "not running", so the guard uses a throwing variant. |
| Text editing | Plain textarea, UTF-8 at most 1 MiB, mtime conflict check | CodeMirror or Monaco; view-only | Covers config tweaks (for example `options.json`, game `*.ini`) without a dependency. |
| Session start | Explicit Start on the Files page; the dashboard Files button navigates and starts | Auto-start on every page entry | Auto-start bills and opens a `/32` rule silently. The dashboard click states the intent, so it may start. |
| Session end | 5 min grace after leaving the page, immediate stop on last upload release, quit hook, 2 h auto-stop backstop | Stop immediately; rely on auto-stop only | Ends sessions with use while tolerating a quick return. |
| Readiness | Ready means the task is RUNNING, has a public IP, and the backend login succeeds over pinned TLS | Treat the ECS `RUNNING` status as ready | An authenticated round-trip is the real signal; polling continues until it passes, so the page cannot stop early with no address. |
| Multi-volume | Mount every applied volume from one new stack output; fallback to the first volume, browse-only, on older stacks | `DescribeAccessPoints` discovery; one helper per volume | A stack output is already the contract, whereas discovery adds an EFS SDK client and couples the app to the infra program's path convention. One helper per volume breaks the invariant and multiplies cost and `/32` rules. A game's config and saves often sit on different volumes, so first-volume-only browsing would hide files. |
| Fallback layout writes | Refuse every upload while the layout is the legacy first-volume fallback | Allow uploads into the first volume | The legacy access point is whichever volume was first at the last apply; after a reorder the mount would carry the wrong label and an upload could land in the wrong volume. |
| Wrong-volume upload fix | Land in the multi-volume change, mapping through the session layout | A separate bug-fix change | The fix needs the multi-volume mount to exist, and landing together avoids an interim build that mounts several volumes but still writes to the wrong one. |
| External-browser escape hatch | None | An "Open in external browser" action | It would reintroduce the plaintext credential and the egress-mismatch problem. |
| Image | `filebrowser/filebrowser:v2.63.23` pinned by digest | A floating tag | Upstream is archived and v2.63.23 is final; a moving tag only adds supply-chain risk (`FileManagerService.ts:19-24`). |
| Helper lifetime | Throwaway task definition per launch, `RunTask` only | A persistent definition or ECS Service | Keeps the no-persistent-Service cost model; per-launch registration bakes the credential hash and cert into each definition [inferred]. |
| Rule cleanup | Reference-count rules by CIDR from each helper's `OperatorIp` tag, re-tagged on IP change | Revoke by game description | The shared group dedupes rules across games and IP changes need separate rules (`FileManagerService.ts:189-198`). |
| In-app write exclusion | Per-game path reservations, non-blocking | Rely on FileBrowser's `overwrite=false` | That flag is a check followed by a truncating open, not an atomic create (`uploadReservations.ts:6-12`). |
| Resume semantics | Skip a file whose remote size matches; overwrite otherwise | Checksums; TUS chunked resume | Cheap skip-by-size; resume is per file and partial files are overwritten. |
| Seeding route | Per-game Lambda invoked synchronously during apply | Writing seeds through the helper task | Seeds are declarative config that must land as part of the apply and fail it on error (`handler.ts:51-56`) [inferred]. |

## Open Questions & Future Decisions

### Resolved

1. Upload transport, authentication, network scoping, resume, verification and overwrite warning are settled as the Decisions table and the sections above describe them.
2. Browse surface, TLS for browse, session ownership, backend interface, IPC shape, path safety, read-only guard, text editing, grace period, multi-volume mounting and the wrong-volume upload fix are shipped as the Decisions table describes them.

### Deferred

1. How should a missing or failed auto-stop schedule reach the operator, now that `scheduleWarning` has no consumer (`FileManagerService.ts:487`, `HelperSessionRegistry.ts:435-443`)? Should an upload refuse to run without the backstop? (Must Fix)
2. How should `launchHelper` guarantee rule revocation when cert generation or `registerTaskDefinition` throws after `authorizeIngress` (`FileManagerService.ts:374,393,403`)? (Must Fix)
3. Should a folder-upload run hold the session before its preflight server check, and re-check the server during `uploadAll` like file-browser uploads do (`FolderUploadService.ts:290-298,367`, `transferOps.ts:215-218`)? Discord `/server-start` stays outside the refusal by design: the Lambda cannot see the main-process registry. (Must Fix)
4. Should folder-upload runs reserve their targets so a concurrent text save cannot race them (`uploadEngine.ts:251`, `uploadReservations.ts:6-12`)?
5. Should `cancel()` and the before-stop listener honour a game still in `preparing` (`FolderUploadService.ts:128-130,183-187,220-241`)?
6. Should `FolderUploadStartResult` and failure snapshots carry structured codes instead of text matched by regex and prefix (`folder-upload-card.component.tsx:25,87`, `folder-upload-progress-meter.component.tsx:37`, `HelperSessionRegistry.ts:517`)?
7. Should the runtime check in IAC-PROGRAM-RUNTIME-003 treat efs-seeder as conditional, and may `file_seeds` target volumes other than the first now that the helper mounts all of them (`escapes.ts:250`, `lambdas.ts:711-721`, `handler.ts:34-38`)?
8. Should `FileManagerService.stop` normalise errors with `errMessage` and wrap its task listing, should `:315` stop logging whole access-point maps, and should the issue-number narration at `:39,110-111` go (`FileManagerService.ts:315,542,559`)?
9. Should the folder-upload card treat a failed server status read as busy, matching `useServerGuard` (`folder-upload-card.component.tsx:52-53,62`)?
10. Should `supportsArchive` come from one place (`HelperSessionRegistry.ts:694` versus `transferOps.ts:105`)?
11. Should `FileManagerService`, `SchedulerService` and `PublicIpService` move from `AwsModule` into `VolumeFilesModule`, and `use-folder-seed.hook.ts` into `web/src/hooks/` (`aws.module.ts:48`, `volume-files.module.ts:6-11`)? Sweep disagreement in `final-clustering.md` section 6.
12. Should the seeder `chmod` on overwrite and validate its event (`handler.ts:58,87`)?
13. Should operator-requested stray cleanup confirm first, given it stops unowned helpers of any age (`stray-helpers-button.component.tsx:19-25`, `FolderUploadService.ts:202-207`)?
14. Should `latest` progress snapshots be cleared after a terminal phase (`FolderUploadService.ts:116,332`)? Keeping them appears intended [inferred].
15. The original upload design intended a total-size and file-count sanity cap with a confirmation, not a hard block, to guard accidents such as choosing a drive root; none exists in `FolderScanService.ts` or `web/src/components/folder-upload/`. Was it dropped deliberately?
16. The 2 h auto-stop is shared by every session and is not extended by activity; long transfers are cut and must resume (`FileManagerService.ts:44`). The session bar warns at 10 minutes remaining and upload has Resume; extending the schedule was left out of scope. Should a busy session get a longer window?
17. Which backend replaces the archived FileBrowser image (Lambda on EFS, a purpose-built image, or a maintained fork)? Candidates: Lambda on EFS (no public exposure, no cold start; needs a VPC Lambda plus an S3 hop for bodies over 6 MB), a minimal purpose-built helper image, or a maintained fork. The `VolumeFileBackend` interface keeps the swap inside desktop-main. Tracked as issue #700.
18. Two manual checks are still owed from the file-browser rollout: real OS drag-and-drop through `webUtils.getPathForFile` in the sandboxed preload, and `quitAndInstall` with an owned helper on macOS. Automated tests mock `webUtils` and never exercise a real OS drop, and Squirrel.Mac's handling of a delayed `before-quit` is unverified. If the drop check fails, add an electron-project spec that dispatches a synthetic drop with a real temp file.

## References

- Arrow doc: `docs/arrows/helper-task.md`
- EARS specs: `docs/intent/helper-task/helper-task-specs.md`
- Docs pages: `docs/docs/components/management-app.md`, `docs/docs/components/lambdas.md` (efs-seeder), `docs/docs/components/infra.md`, `docs/docs/app/games.md`, `docs/docs/app/dashboard.md`, `docs/docs/architecture.md`, `docs/docs/components/integration-tests.md`
- Neighbouring leaf designs: `docs/intent/iac/program/program-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/diagnostics/diagnostics-design.md`, `docs/intent/game-server/game-server-design.md`
