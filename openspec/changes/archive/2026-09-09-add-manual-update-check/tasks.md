## 1. Backend updater

- [x] 1.1 Add `checkForUpdatesNow()` to `app/packages/desktop-main/src/updater.ts`: outside-Electron guard, lazy `electron-updater` import, `autoDownload`/`autoInstallOnAppQuit` pinned false, one-shot event race (`update-available`/`update-not-available`/`error`), listener cleanup.
- [x] 1.2 Add tests to `updater.test.ts` covering: outside Electron, update available, no update available, error, listeners removed after resolution.

## 2. Shared types

- [x] 2.1 Add `ManualUpdateCheckResult` discriminated union to `app/packages/shared/src/autoUpdateSetting.ts`.

## 3. IPC controller

- [x] 3.1 Add `checkAutoUpdate` handler on `iac.settings.autoUpdate.check` in `iac-settings.controller.ts`, calling `checkForUpdatesNow()`.
- [x] 3.2 Add controller tests: pattern registration + call-through with `checkForUpdatesNow` mocked.

## 4. Preload bridge

- [x] 4.1 Add `autoUpdateCheck` to `preload.ts`.
- [x] 4.2 Add `autoUpdateCheck` type signature to `hyveon-api.ts`.

## 5. Chromium e2e stub

- [x] 5.1 Add `autoUpdateCheck` stub to `hyveon-http-bridge.ts`.

## 6. Settings UI

- [x] 6.1 Add "Check for Updates" button + status line to the Updates section in `settings.page.tsx`.
- [x] 6.2 Extend `settings.page.test.tsx`: click → loading → success (no update / update available) → error paths.

## 7. Docs

- [x] 7.1 Update `docs/docs/app/settings.md` and `docs/docs/components/management-app.md` via the `write-docs` skill.

## 8. Verification

- [x] 8.1 `npm run app:lint`
- [x] 8.2 `npm run app:typecheck`
- [x] 8.3 `npm run app:test`
- [x] 8.4 `npm run app:test:e2e`
- [x] 8.5 `/opsx:sync` to fold the delta spec into `openspec/specs/`
