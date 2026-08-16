## ADDED Requirements

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
