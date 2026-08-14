## 1. Shared types

- [x] 1.1 Add `AutoUpdateSettingGetResult` and `AutoUpdateSettingUpdatePayload`/`AutoUpdateSettingWriteResult` types to `@hyveon/shared` (alongside `DeploymentSettingsGetResult` etc.)

## 2. Main-process IPC

- [x] 2.1 Inject `ElectronStoreService` (optional param, matching the `engine?` pattern) into `IacSettingsController`'s constructor
- [x] 2.2 Add `iac.settings.autoUpdate.get` handler — reads `enableAutoUpdate`, defaults to `false` when the store is absent
- [x] 2.3 Add `iac.settings.autoUpdate.update` handler — validates the payload is a boolean, writes via `ElectronStoreService.set`, returns the new value; never throws uncaught
- [x] 2.4 Add entry-log lines for both handlers per the repo's IPC logging convention

## 3. Preload bridge

- [x] 3.1 Add `autoUpdate.get()` / `autoUpdate.update(value)` methods under `hyveon.iac.settings` in `hyveon-api.ts`, typed against the new shared types

## 4. Settings UI

- [x] 4.1 Add an "Updates" row/section to `settings.page.tsx` (label, description noting "applies on next app start", toggle control)
- [x] 4.2 Load initial state via `autoUpdate.get()` on mount, following the existing `engineVersion` load-state pattern (loading/ready/error)
- [x] 4.3 Wire the toggle's `onChange` to `autoUpdate.update()`, updating displayed state from the response

## 5. Tests

- [x] 5.1 `iac-settings.controller.test.ts`: unit tests for both new handlers (default-false, round-trip, absent-store fallback)
- [x] 5.2 jsdom test for the Settings page toggle (renders current state, calls update on toggle, reflects the result) per `docs/docs/components/integration-tests.md` conventions

## 6. Docs and spec sync

- [x] 6.1 Update the Settings page doc (`docs/docs/app/*`) to document the new toggle
- [x] 6.2 Run `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` and confirm clean
- [x] 6.3 `/opsx:sync` to fold the `auto-update-scaffold` delta spec into `openspec/specs/`
