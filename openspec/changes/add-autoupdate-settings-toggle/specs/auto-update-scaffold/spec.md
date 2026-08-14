## MODIFIED Requirements

### Requirement: enableAutoUpdate flag lives in the typed electron-store schema

The `AppStoreSchema` in `ElectronStoreService` SHALL include an `enableAutoUpdate: boolean` field. Reads MUST treat an absent value as `false` (default off). The flag SHALL be readable and writable through the existing typed `get`/`set` surface of `ElectronStoreService`, and additionally through a dedicated IPC channel pair reachable from the renderer, so the Settings page can display and change the flag without direct electron-store access.

#### Scenario: Absent flag defaults to disabled

- **WHEN** the updater module reads `enableAutoUpdate` from a store that has never persisted the key
- **THEN** the value resolves to `false` and the updater stays inert

#### Scenario: Flag round-trips through the store

- **WHEN** `enableAutoUpdate` is set to `true` via `ElectronStoreService.set` and read back via `ElectronStoreService.get`
- **THEN** the read returns `true`, in both the real electron-store backing and the in-memory Map backing used outside Electron

#### Scenario: Flag readable via IPC

- **WHEN** the renderer invokes the `iac.settings.autoUpdate.get` IPC channel
- **THEN** it receives the current `enableAutoUpdate` value (`false` when never set)

#### Scenario: Flag writable via IPC

- **WHEN** the renderer invokes the `iac.settings.autoUpdate.update` IPC channel with a new boolean value
- **THEN** `ElectronStoreService` persists the new value and the channel's response reflects the value now in effect

#### Scenario: Settings page renders and updates the flag

- **WHEN** an operator opens the Settings page
- **THEN** the page displays the current `enableAutoUpdate` state via a toggle control, and flipping the toggle calls the update channel and updates the displayed state on success

#### Scenario: Toggling the flag does not affect the running session

- **WHEN** an operator changes `enableAutoUpdate` while the app is running
- **THEN** no update check is triggered immediately — the new value takes effect on the next app start, since `initUpdater` only runs once at boot
