## ADDED Requirements

### Requirement: Operator can download and install an available update

The system SHALL let an operator download and install an update that a manual check reported, via two explicit actions: download, then restart-and-install. Nothing else MAY download or install an update — the automatic boot-time check and the manual check MUST remain detect-only, and `autoDownload` / `autoInstallOnAppQuit` MUST stay `false`. The download MUST report progress and a terminal success or failure, and the install MUST quit the app and run the downloaded installer.

#### Scenario: Download button appears only when an update is available

- **WHEN** a manual check reports `updateAvailable: true`
- **THEN** the Updates row shows a "Download & Install" button next to "Check for Updates"
- **AND** the button is not shown before a check, when up to date, or when the check failed

#### Scenario: Download reports progress

- **WHEN** the operator presses "Download & Install"
- **THEN** the row shows `Downloading v<version>… <percent>%` updating as progress arrives, and both buttons are disabled until the download settles

#### Scenario: Completed download offers restart

- **WHEN** the download completes
- **THEN** the row shows `v<version> downloaded. Restart to install.` and a "Restart & Install" button replaces "Download & Install"

#### Scenario: Restart installs the update

- **WHEN** the operator presses "Restart & Install"
- **THEN** the renderer invokes `iac.settings.autoUpdate.install`, and the main process quits and runs the installer (`quitAndInstall`)

#### Scenario: Download without a prior check in this process

- **WHEN** a download is requested but `electron-updater` has no cached check result
- **THEN** the check is re-run once and the download retried before any failure is reported

#### Scenario: Download is unavailable outside the packaged app

- **WHEN** a download or install is requested outside a real Electron main process
- **THEN** it reports it is unavailable without touching `electron-updater`

#### Scenario: Download reachable via IPC

- **WHEN** the renderer invokes `iac.settings.autoUpdate.download`
- **THEN** it receives a `streamId` acknowledgement, progress messages on `iac.settings.autoUpdate.download.chunk`, and one terminal message on `iac.settings.autoUpdate.download.end` carrying `error` only on failure

## MODIFIED Requirements

### Requirement: Failed manual checks link to the releases page

When the Settings page's manual update check, update download, or update install reports failure (including when the IPC call itself rejects), it SHALL render a "Download manually" link to `https://github.com/CoderCoco-Studios/Hyveon/releases` that opens in a new window. The link MUST NOT appear when the check succeeds or while a download is in progress or completed.

#### Scenario: Check fails

- **WHEN** the operator presses "Check for Updates" and the result is `ok: false`
- **THEN** the error text is shown alongside a "Download manually" link to the GitHub Releases page

#### Scenario: Check succeeds

- **WHEN** the manual check reports up to date or an available update
- **THEN** no "Download manually" link is shown

#### Scenario: Download or install fails

- **WHEN** the operator presses "Download & Install" or "Restart & Install" and it fails
- **THEN** the error text is shown alongside a "Download manually" link, and "Download & Install" is offered again as a retry
