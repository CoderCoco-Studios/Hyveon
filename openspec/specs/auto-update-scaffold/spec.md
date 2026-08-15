# auto-update-scaffold Specification

## Purpose
Defines the electron-updater integration scaffolding: wired but inert by
default, gated entirely behind an `enableAutoUpdate` electron-store flag,
so packaging carries the update-feed metadata without any app performing
network calls to an update server unless an operator opts in.

## Requirements
### Requirement: Updater is wired but inert by default

The Electron main process SHALL construct the `electron-updater` integration in a dedicated `desktop-main/src/updater.ts` module during application startup, and it MUST NOT call `checkForUpdates` (or any other method that performs network I/O against an update feed) unless the `enableAutoUpdate` feature flag is `true`. A first launch with default settings MUST produce zero outbound traffic to update servers.

#### Scenario: First launch with default settings performs no update check

- **WHEN** the packaged app starts and `enableAutoUpdate` is unset or `false` in electron-store
- **THEN** the updater module is initialized but `checkForUpdates` is never invoked and no network request is made to any update feed

#### Scenario: Flag enabled triggers an update check

- **WHEN** the app starts and `enableAutoUpdate` is `true` in electron-store
- **THEN** the updater calls `checkForUpdates` against the GitHub Releases feed and surfaces update events (available / downloaded / error) through the main-process logger

#### Scenario: Updater initialization is skipped outside Electron

- **WHEN** the desktop-main code runs in a plain-Node environment (unit tests, integration harness) where `process.versions.electron` is undefined
- **THEN** updater initialization is a no-op and no Electron-only module import is attempted

### Requirement: Update-check telemetry is gated by the same flag

All logging, event reporting, or telemetry emitted as part of update checks SHALL be gated by the `enableAutoUpdate` flag so that a disabled updater produces no update-related network calls and no silent background activity.

#### Scenario: Disabled updater emits no update telemetry

- **WHEN** `enableAutoUpdate` is `false` and the app runs through a full session
- **THEN** no update-check events are emitted and no update-related network activity occurs beyond at most a single local log line stating the updater is disabled

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

### Requirement: Packaged builds carry GitHub publish metadata

`electron-builder.yml` SHALL declare `publish: github` so packaged artifacts embed the update-feed metadata (`app-update.yml`) that `electron-updater` requires. Adding the publish configuration MUST NOT cause CI packaging runs to publish releases themselves — release publishing remains owned by the tag-triggered workflow.

#### Scenario: Packaging embeds the update feed configuration

- **WHEN** `npm run desktop:package` builds an installer
- **THEN** the packaged app contains electron-updater feed metadata pointing at the project's GitHub Releases

#### Scenario: CI packaging does not auto-publish

- **WHEN** the Package workflow runs `npm run desktop:package` on a pull request
- **THEN** electron-builder does not attempt to publish to GitHub Releases (publishing stays gated to the tag-triggered release job)

### Requirement: Operator can trigger an on-demand update check

The system SHALL provide a way for an operator to trigger an update check
immediately, independent of the `enableAutoUpdate` flag. The check MUST NOT
download or install an update — it only reports whether one is available.

#### Scenario: Manual check succeeds with no update available

- **WHEN** an operator triggers a manual update check and the update feed
  reports the running version is current
- **THEN** the check reports no update is available, and no download or
  install occurs

#### Scenario: Manual check succeeds with an update available

- **WHEN** an operator triggers a manual update check and the update feed
  reports a newer version
- **THEN** the check reports the newer version number, and no download or
  install occurs

#### Scenario: Manual check works regardless of the auto-update flag

- **WHEN** an operator triggers a manual update check while `enableAutoUpdate`
  is `false`
- **THEN** the check still runs and reports a result — the flag only gates
  the automatic boot-time check, not the manual one

#### Scenario: Manual check fails gracefully

- **WHEN** an operator triggers a manual update check and the update feed is
  unreachable or returns an error
- **THEN** the check reports a failure with an error message, and no
  exception escapes to the caller

#### Scenario: Manual check is unavailable outside the packaged app

- **WHEN** an operator triggers a manual update check outside a real Electron
  main process
- **THEN** the check reports it is unavailable, without attempting any
  network call

#### Scenario: Manual check reachable via IPC

- **WHEN** the renderer invokes the `iac.settings.autoUpdate.check` IPC
  channel
- **THEN** it receives the manual check result (no update / update available
  with version / error)

#### Scenario: Settings page exposes a manual check control

- **WHEN** an operator opens the Settings page's Updates section
- **THEN** a "Check for Updates" control is available, and activating it
  shows the check's result inline (checking / up to date / update available
  with version / error)
