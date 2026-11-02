## Context

`checkForUpdatesNow()` resolves whether a newer release exists but deliberately never downloads. The existing "never downloads or installs itself" language in `auto-update-scaffold` is about automatic behaviour: nothing may fetch or apply an update without an operator asking.

## Goals / Non-Goals

**Goals:** an explicit, operator-driven download-then-restart flow from the Check Now row, with live progress and a manual fallback link on failure.

**Non-Goals:** background/auto download, install-on-quit, release notes, rollback, code-signing changes.

## Decisions

- **Explicit action only.** `autoDownload` and `autoInstallOnAppQuit` remain `false`; the only code paths that call `downloadUpdate()` / `quitAndInstall()` are the two new handlers. A downloaded-but-not-installed update is simply discarded at quit.
- **Progress reuses the existing side-channel stream pattern** (`iac.stack.initialize`): the handler acks `{ started, streamId }`, pushes `iac.settings.autoUpdate.download.chunk` messages and one `.end` message; preload wraps it with `createBufferedStream` and returns a `HyveonStreamHandle`. A failed download is the end message's `error`, so the renderer's `for await` throws. Because the handler needs the `IpcMainInvokeEvent` sender, it is self-bridged (`SELF_BRIDGED_PATTERNS`, `IacSettingsController.onModuleInit`).
- **Install is a plain invoke** (`iac.settings.autoUpdate.install`) calling `quitAndInstall(false, true)` (not silent, relaunch after install). It resolves `{ ok: true }` just before the app quits.
- **No prior check in this process.** `electron-updater` caches the check's `updateInfo` on the singleton and rejects `downloadUpdate()` with "Please check update first" otherwise. The download re-runs the check-with-fallback once and retries, so a stale UI state does not dead-end.
- **Renderer state** stays one discriminated union (`ManualCheckState`) extended with `downloading`, `downloaded` and `download-failed`; install failures reuse `download-failed`.
- **Unsigned macOS builds** can fail the download with a code-signature error. That surfaces as an ordinary failure with the `Download manually` link; no special handling.

## Risks / Trade-offs

- Closing the Settings page mid-download does not cancel it (the main process keeps downloading); only progress consumption stops.
- Install failure offers a retry that re-downloads (electron-updater serves the cached file when present).
