## 1. Backend updater

- [x] 1.1 Add `downloadUpdateNow(onProgress)` to `updater.ts`: outside-Electron guard, `download-progress` forwarding, `update-downloaded` version capture, one re-check-and-retry on "Please check update first", listener cleanup, `autoDownload`/`autoInstallOnAppQuit` stay `false`.
- [x] 1.2 Add `installDownloadedUpdate()` calling `quitAndInstall(false, true)` with try/catch and an info log.
- [x] 1.3 Cover both in `updater.test.ts`.

## 2. Shared types

- [x] 2.1 Add `UpdateDownloadProgress`, `UpdateDownloadResult`, `UpdateInstallResult` to `shared/src/autoUpdateSetting.ts`.

## 3. IPC controller

- [x] 3.1 Add `downloadAutoUpdate` (`iac.settings.autoUpdate.download`, side-channel stream, self-bridged in `onModuleInit` and `SELF_BRIDGED_PATTERNS`) and `installAutoUpdate` (`iac.settings.autoUpdate.install`) with entry debug logs.
- [x] 3.2 Update `iac-settings.controller.test.ts` and `ipc-main-bridge.test.ts`.

## 4. Preload bridge

- [x] 4.1 Add `streamUpdateDownload` / `openUpdateDownloadStream`, `autoUpdateDownload` and `autoUpdateInstall` to `preload.ts`.
- [x] 4.2 Add the type signatures and docs to `hyveon-api.ts`; stub both in `hyveon-http-bridge.ts`.

## 5. Renderer

- [x] 5.1 Extend `ManualCheckState`; add `Download & Install`, progress text, `Restart & Install`, failure + `Download manually`.
- [x] 5.2 Add `settings.page.test.tsx` cases.

## 6. Docs

- [x] 6.1 Update `docs/docs/app/settings.md` and `docs/docs/components/management-app.md`.
