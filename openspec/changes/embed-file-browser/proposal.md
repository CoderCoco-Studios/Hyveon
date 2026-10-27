## Why

The dashboard's file manager hands the operator a plain-HTTP link to a raw task IP and a password to copy, then relies on `shell.openExternal` and the OS browser. In the reported case the browser opened behind another application without focus, so from inside the app the click appeared to do nothing. The same hop also fails silently when it does fail (rejections only reach `console.error`) and depends on the browser egressing from the same IP the app opened the `/32` rule for. The FileBrowser project behind the helper was archived on 2026-09-01 with unfixed advisories, so its web UI should not become a surface we embed or grow. Moving browsing into the app, with desktop-main as the only client of the helper, removes the failing hop, keeps credentials out of the renderer and out of the operator's hands, and makes the archived image replaceable.

## What Changes

**Where the operator browses volume files**
- From: Files → modal → Launch → `<a target="_blank">` to `http://<ip>:8080` in the OS browser, with the plaintext username/password shown in the modal to copy.
- To: Files → a routed in-app page `/games/:name/files` with a session bar (start/stop, state, auto-stop countdown), a volume picker, breadcrumb navigation, a file table, and upload, download, new folder, rename, delete, and small-text-file view/edit. desktop-main does all helper traffic over IPC.
- Reason: removes the external-browser hop (unfocused windows, silent failures, a context switch out of the app), and keeps the UI consistent and testable.
- Impact: replaces the modal (breaking for the operator's workflow, but there is no persisted state). The external link and copy-password UI are removed.

**Helper transport and credentials**
- From: browse sessions serve plain HTTP, and the per-launch credential is returned over IPC (`FileMgrResult.credentials`) and rendered.
- To: every helper session (browse and upload) serves TLS with a per-launch certificate that desktop-main pins. The credential never leaves the main process, and `credentials` is removed from the IPC contract.
- Reason: closes the plaintext-HTTP and renderer-secret gaps.
- Impact: non-breaking for infra and IAM — the same AWS calls are made, and TLS is container args only.

**Helper session ownership**
- From: one helper per game, with upload refusing (`helper-open`) whenever a browse session exists because the app does not hold its credential.
- To: a main-process helper session registry per game. Browse and upload acquire and release a shared session, and the helper stops when the last holder releases, when the operator clicks Stop, after leaving the Files page (after a grace period), or on app quit. The 2 h auto-stop and startup orphan sweep stay as backstops. A helper with no registry entry (after an app restart) is offered as **Restart session**.
- Reason: browse sessions are now app-owned, so the refusal's premise is gone, and sessions end with use instead of idling.
- Impact: modifies the in-flight `game-volume-folder-upload` behaviour for an already-open session.

**FileBrowser coupling**
- From: FileBrowser's API is called directly by the upload engine, and the image is `filebrowser/filebrowser:latest`.
- To: a `VolumeFileBackend` interface in desktop-main with FileBrowser as its first implementation, and the image pinned to the final release by digest.
- Reason: the project is archived, so this makes the backend swappable (a maintained image, a purpose-built helper, or Lambda-on-EFS) without touching UI or IPC.
- Impact: internal refactor only.

**Mutations while the game server runs**
- To: the Files page is read-only while the game's server task is starting or running, and mutating actions are disabled with an explanation. The check fails closed: if the server state can't be read, mutations (including folder uploads) are refused with "Couldn't confirm the server is stopped" and a Retry.

**Which volumes the helper can reach**
- From: the helper mounts only the game's first volume (the only access point the stack exports), and a #672 folder upload aimed at a second volume silently lands in the first volume.
- To: the stack exports every volume's access point, the helper mounts every applied volume under its own directory, the page has a volume picker, and uploads land in their destination's volume. Until the new output is applied, the helper falls back to the first volume and uploads into an unmounted volume are refused.
- Reason: config and saves often sit on different volumes; the shipped upload bug writes files to the wrong place.
- Impact: one new stack output, so one plan + apply after the multi-volume PR ships (output-only, no resource changes). No IAM change.

## Capabilities

### New Capabilities
- `game-volume-file-browser`: browsing and managing a game's EFS volume files from inside the app — the helper session lifecycle, the transport and credential boundary, file operations, downloads, the read-only-while-running rule, and the backend abstraction.

### Modified Capabilities
- `game-volume-folder-upload`: when a file-manager session is already open for the game, the upload reuses that app-owned session instead of asking the operator to stop it, and does not stop a helper it did not launch; an upload aimed at any of the game's volumes lands in that volume (fixing the shipped first-volume bug); and an upload is refused when the server state can't be confirmed. (The base spec now exists: `add-folder-volume-upload` was archived on 2026-10-26.)

## Impact

- `@hyveon/infra`: `buildStackOutputs` adds the `efsVolumeAccessPoints` output (game → volume name → access point ID) from the existing `efs.gameAccessPoints`. No new resources.
- `@hyveon/desktop-main`: `FileManagerService` split into a helper session registry plus launch/teardown; every launch uses TLS and mounts every applied volume through a volume mount layout; `PulumiService` projects the new output; `EcsService` gains `tagTask` and a throwing `findRunningTaskOrThrow`; a new `NativeDialogService` replaces two private dialog copies; a new `VolumeFilesService` with a `VolumeFileBackend` interface (FileBrowser implementation extending `FileBrowserClient`); new `volumeFiles.*` IPC handlers (session status/start/attach/detach/stop/restart, list, mkdir, rename, delete, read/write text, download, cancel transfer, upload files, upload folder); session and transfer events; a quit hook; and `FolderUploadService` acquiring a shared session, writing into the destination's volume, and failing closed on the server check.
- `@hyveon/desktop-preload` / `@hyveon/shared`: `StackOutputs.efsVolumeAccessPoints`; new `volumeFiles` path helpers and channel shapes in a shared subpath module (not the barrel); legacy `files.*` channels and `FileMgrResult.credentials` removed; dropped files resolved to paths inside the preload (`webUtils.getPathForFile`).
- `@hyveon/web`: new `/games/:name/files` page with a volume picker, its hooks and components, and the dashboard card and game detail page link to it. `FileManagerModal`, `useFileManager`, the legacy `files.*` preload API and the folder-upload card's `files.stop` call are removed.
- Infra / IAM: one new stack output, no new resources, no IAM change. The operator runs one plan + apply after the multi-volume PR ships to record the output; until then the app falls back to first-volume browsing.
- Tests: desktop-main unit tests against `fake-filebrowser-server` (including a second-volume upload regression and the fail-closed guard), infra output tests, a jsdom routed-page test, a Playwright chromium spec via the IPC mock seam, a tier-2 integration spec, and one electron-project smoke test.
- Docs: `docs/docs/components/infra.md` (new output), `docs/docs/app/dashboard.md`, `docs/docs/app/games.md`, `docs/docs/components/management-app.md`, `docs/docs/architecture.md` (secrets-in-renderer, helper transport), and `docs/docs/setup.md` if it mentions the file manager link.
