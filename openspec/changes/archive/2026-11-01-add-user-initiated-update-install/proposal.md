## Why

Settings → Updates → "Check for Updates" (`add-manual-update-check`) only reports `Update available: v<version>`. An operator who sees that has no way to act on it from the app and must leave to download and run the installer by hand.

## What Changes

- Add `downloadUpdateNow(onProgress)` and `installDownloadedUpdate()` to `desktop-main/src/updater.ts`. Both run only on an explicit operator click; `autoDownload` and `autoInstallOnAppQuit` stay pinned `false`.
- Add two IPC channels on `IacSettingsController`: `iac.settings.autoUpdate.download` (streams progress over the `iac.settings.autoUpdate.download.chunk` / `.end` side channels) and `iac.settings.autoUpdate.install` (plain invoke, calls `quitAndInstall(false, true)`).
- Add `autoUpdateDownload` (a `HyveonStreamHandle<UpdateDownloadProgress>`) and `autoUpdateInstall` to the preload settings bridge.
- Settings' Updates row gains a `Download & Install` button when a manual check reports an update, a progress description, a `Restart & Install` button once downloaded, and the existing `Download manually` link on any failure.
- The automatic boot-time check is untouched: it still never downloads or installs.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `auto-update-scaffold`: adds a user-initiated download/install requirement and extends the "Download manually" link requirement to cover download and install failures.

## Impact

- `app/packages/desktop-main/src/updater.ts`, `ipc-main-bridge.ts`, `controllers/iac-settings.controller.ts`
- `app/packages/shared/src/autoUpdateSetting.ts` (new types)
- `app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts`
- `app/packages/web/src/pages/settings.page.tsx`, `web/e2e/fixtures/hyveon-http-bridge.ts`
- Docs: `docs/docs/app/settings.md`, `docs/docs/components/management-app.md`
