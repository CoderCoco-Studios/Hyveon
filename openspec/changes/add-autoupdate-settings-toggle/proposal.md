## Why

`auto-update-scaffold` shipped the `electron-updater` integration wired but inert behind an `enableAutoUpdate` electron-store flag, with no way to set it except manual store editing — by design, as a v1 scaffold. Windows differential (blockmap) updates are already published by CI. For v0.4.0, operators need a Settings-page control to turn auto-update on/off themselves, so the shipped mechanism becomes usable without a manual store edit.

## What Changes

- Add `iac.settings.autoUpdate.get` / `iac.settings.autoUpdate.update` IPC channels on `IacSettingsController` (mirrors the existing `get`/`update` pattern for other top-level deployment settings) to read and write the `enableAutoUpdate` flag through `ElectronStoreService`'s typed `get`/`set` surface.
- Expose the two channels on the preload bridge (`hyveon-api.ts`), under the existing `hyveon.iac.settings` namespace.
- Add a toggle control to the Settings page's Cloud Setup section (or a new section, per design) — label, description, and current on/off state, following the existing row pattern used for the Pulumi Engine row.
- Toggling the flag takes effect on the next app start (`initUpdater` only runs once at boot) — no live "check now" action is in scope.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `auto-update-scaffold`: the "enableAutoUpdate flag lives in the typed electron-store schema" requirement gains a new scenario — the flag is now readable and writable through a dedicated IPC channel pair, not only through `ElectronStoreService`'s programmatic surface, and the Settings page renders and updates it.

## Impact

- `app/packages/desktop-main/src/controllers/iac-settings.controller.ts` — two new `@MessagePattern` handlers.
- `app/packages/desktop-main/src/controllers/iac-settings.controller.test.ts` — new handler tests.
- `app/packages/desktop-preload/src/hyveon-api.ts` — two new bridge methods under `hyveon.iac.settings`.
- `app/packages/web/src/pages/settings.page.tsx` — new toggle UI, wired to the new bridge methods.
- `app/packages/web/src/pages/settings.page.test.tsx` (or equivalent jsdom spec) — new coverage for the toggle.
- `docs/docs/app/settings.md` (or wherever the Settings page is documented) — new toggle documented.
- `openspec/specs/auto-update-scaffold/spec.md` — delta spec for the modified requirement.
- No changes to `desktop-main/src/updater.ts` itself, the release/packaging pipeline, or macOS/Linux update behavior.
