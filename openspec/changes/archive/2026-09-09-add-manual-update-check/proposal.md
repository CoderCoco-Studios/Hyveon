## Why

The `auto-update-scaffold` capability (PR #524) added an `enableAutoUpdate`
toggle to Settings, but the underlying updater only checks once at Electron
boot and only when that flag is on. There is no way for an operator to
trigger an update check on demand — a click-to-check control that works
regardless of the background-check setting.

## What Changes

- Add `checkForUpdatesNow()` to `desktop-main/src/updater.ts`: an on-demand
  update check via `electron-updater`, independent of the `enableAutoUpdate`
  flag. Still check-only — `autoDownload`/`autoInstallOnAppQuit` stay `false`,
  matching the scaffold's existing "detect, never install" restriction.
- Add a new IPC channel `iac.settings.autoUpdate.check` on
  `IacSettingsController`, backed by `checkForUpdatesNow()`.
- Add `autoUpdateCheck` to the preload settings bridge and its type
  declaration.
- Add a "Check for Updates" button + inline result text to Settings' Updates
  section.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `auto-update-scaffold`: adds an on-demand update-check requirement
  (new IPC channel, new UI control) alongside the existing toggle-gated
  boot-time check. The boot-time behavior is unchanged.

## Impact

- `app/packages/desktop-main/src/updater.ts` (new export)
- `app/packages/desktop-main/src/controllers/iac-settings.controller.ts` (new handler)
- `app/packages/shared/src/autoUpdateSetting.ts` (new result type)
- `app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts` (new bridge method)
- `app/packages/web/src/pages/settings.page.tsx` (new button + status line)
- `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (stub for the new channel)
- Docs: `docs/docs/app/settings.md`, `docs/docs/components/management-app.md`
