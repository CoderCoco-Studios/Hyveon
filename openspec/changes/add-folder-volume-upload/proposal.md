## Why

Seeding a game volume today means hand-adding one `file_seeds` row per file (path + inline text or base64 + mode). That is unworkable for real server data: the operator's FoundryVTT folder has `Config` (3 files) and `Data` (~1,030 files, 1.2 GB, files up to 168 MB), and only those two directories should reach the server. Inline seeds cannot carry that (they live in `deployment-config.json` and ride a 6 MB Lambda invoke payload), and a Lambda/Pulumi-driven path would give no live progress. The app already has a way to reach a game's EFS volume directly: the on-demand FileBrowser helper task, which mounts the game's EFS access point and serves an authenticated HTTP API.

## What Changes

- The Storage step (and the game page) gains "Seed from folder": pick a local folder via the native dialog, get a checkbox tree (all selected by default), tick only the entries to include (e.g. `Config`, `Data`), and set the in-container destination (e.g. `/data`, relative layout preserved).
- Once the game's infrastructure is applied (the EFS volume exists), desktop-main uploads the selection **directly into the mounted volume** through the existing FileBrowser helper: it launches the helper, authenticates with the per-launch credential (never leaves the main process), creates directories, and streams each file to the helper's resource API, then stops the helper.
- A **live determinate progress meter** (percent, bytes of total, files, current file, speed, ETA) with cancel, shown in the wizard's final step and on the game page. Uploads are resumable: files already on the volume with matching size are skipped on retry.
- The helper is tagged, always stopped when the run ends, auto-stops after 2 h as a backstop, and a new orphan sweep (on startup and a Diagnostics action) stops stray helpers.
- **Secure by construction:** the helper is reachable only from the operator's public IP (an app-managed `/32` security-group rule, removed on stop; Pulumi no longer opens 8080 to the world), requires the per-launch password, and is served over TLS with a per-launch certificate the app pins.
- After upload the app verifies the volume against the selection (file count and sizes) and reports the result.
- No changes to `deployment-config.json`, IAM, the seeder Lambda, or S3, and the only infra edit is removing the helper security group's world-open ingress: the folder selection and last-upload state are stored per game in app-local state (electron-store). Existing inline `file_seeds` are unchanged.

## Capabilities

### New Capabilities
- `game-volume-folder-upload`: choosing a local folder and entries, uploading them into a game's EFS volume via the file-manager helper with live progress, resume and verification.

### Modified Capabilities
<!-- None: no existing spec covers file seeds or the file manager helper. -->

## Impact

- `@hyveon/desktop-main`: new upload service built on `FileManagerService`/`EcsService` (launch, wait for URL, login, mkdir/upload, verify, stop), folder-pick/scan IPC controller, progress event channel, electron-store state; `FileManagerService` gains an internal "start for upload" entry that returns credentials in-process.
- `@hyveon/desktop-preload` / `@hyveon/shared`: IPC channel and progress/event types (shared subpath module, not the barrel).
- `@hyveon/web`: Storage step folder picker + include tree, progress meter component, game page action, wizard final-step upload.
- Docs: `components/management-app.md`, `app/games` and dashboard pages, `architecture.md`.
- `@hyveon/infra`: `securityGroups.ts` drops the `0.0.0.0/0:8080` ingress on the file-manager SG; the existing dashboard file manager also becomes operator-IP-only.
