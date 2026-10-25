## Purpose

Lets an operator copy a chosen local folder tree into a game server's EFS volume from the desktop app, with a live progress meter, instead of declaring one file seed per file.

## ADDED Requirements

### Requirement: Operator selects a local folder and which entries to include
The Storage step and the game page SHALL let the operator choose a local folder through the native folder dialog and present its contents as a tree in which every directory and file can be individually included or excluded, all included by default. The operator SHALL set the in-container destination directory; the relative layout of included entries beneath the chosen folder SHALL be preserved beneath that destination, and the destination SHALL lie within a volume of the game.

#### Scenario: Seed only two subdirectories
- **WHEN** the operator picks a folder containing `Config`, `Data`, `Logs`, `Backups` and `container_cache`, deselects all but `Config` and `Data`, and sets the destination to `/data`
- **THEN** only entries under `Config/` and `Data/` are uploaded, to `/data/Config/...` and `/data/Data/...`

#### Scenario: Excluding a directory excludes its contents
- **WHEN** the operator deselects a directory
- **THEN** no file beneath it is uploaded

#### Scenario: Destination outside any volume
- **WHEN** the destination is not an absolute path under one of the game's volume `container_path`s
- **THEN** the form reports a validation error and does not allow upload

### Requirement: Upload goes directly into the mounted volume
The system SHALL upload the selected files into the game's EFS volume through the file-manager helper task, launched by the application for the duration of the upload and stopped when it finishes, fails or is cancelled. File contents and the helper's credential SHALL stay in the desktop main process and SHALL NOT reach the renderer, `deployment-config.json` or any log. Upload SHALL be available only once the game's infrastructure has been applied.

#### Scenario: Upload after apply
- **WHEN** the operator starts an upload for a deployed game
- **THEN** the helper is launched, files are written into the volume at their destinations, and the helper is stopped on completion

#### Scenario: Game not deployed
- **WHEN** the game's infrastructure has not been applied
- **THEN** the upload action is disabled with an explanation, and the selection is kept so it can be uploaded after apply

#### Scenario: Game server is running
- **WHEN** the game's server task is running
- **THEN** the upload action is disabled with an explanation that the server must be stopped first

#### Scenario: Helper already open for this game
- **WHEN** the operator already has a file-manager session open for the game
- **THEN** the application asks the operator to stop it first rather than reusing a session whose credential it does not hold

### Requirement: Only the operator can reach the upload helper
The upload helper SHALL be reachable only from the operator's current public IP address, SHALL require the per-launch credential, and SHALL be served over TLS using a certificate generated for that launch that the application pins; the application SHALL refuse to send the credential or any file content over a connection that does not present that certificate. The helper's security group SHALL NOT allow inbound access from any other source by default, and any access rule the application adds SHALL be removed when the helper stops.

#### Scenario: Other source address
- **WHEN** a host with a different public IP connects to the helper's port during an upload
- **THEN** the connection is not accepted

#### Scenario: Impersonated helper
- **WHEN** the endpoint presents a certificate other than the one generated for this launch
- **THEN** the application aborts the connection without sending the credential or files

#### Scenario: Access rule removed
- **WHEN** the helper stops (success, failure, cancel or sweep)
- **THEN** the operator-IP ingress rule the application added is revoked

#### Scenario: IP changes mid-upload
- **WHEN** the operator's public IP changes during an upload and the connection fails
- **THEN** the run is reported failed with a Resume action that re-detects the IP and re-authorizes

### Requirement: Helper sessions are tagged and stray ones are cleaned up
The upload helper SHALL be tagged as an upload session for its game and the project, SHALL always be stopped when the upload finishes, fails or is cancelled, and SHALL still be stopped by its auto-stop schedule if the application exits mid-upload. The application SHALL provide a cleanup that finds file-manager helper tasks with no active upload run (on startup and on operator request from Diagnostics) and stops them, reporting what it stopped.

#### Scenario: Helper stopped after upload
- **WHEN** an upload completes, fails or is cancelled
- **THEN** the helper task for the game is no longer running

#### Scenario: App closed mid-upload
- **WHEN** the application exits during an upload and is reopened later
- **THEN** the startup sweep stops any helper older than 15 minutes that no active run owns, and the game shows a resumable partial state

#### Scenario: Manual cleanup
- **WHEN** the operator runs "Clean up stray helpers"
- **THEN** every file-manager helper task not owned by an active run is stopped and listed in the result

### Requirement: Live progress meter
During an upload the application SHALL show a determinate progress meter with percent complete, bytes done of total, files done of total, the current file, transfer rate and estimated time remaining, updating at least once per second, in the wizard's final step and on the game page. The meter SHALL show distinct phases (starting helper, uploading, verifying, done/failed) and SHALL offer cancel.

#### Scenario: Meter advances during upload
- **WHEN** a 1.2 GB selection is uploading
- **THEN** the percentage and byte counts increase over time and reach 100% when the last file is written

#### Scenario: Large single file
- **WHEN** a 168 MB file is uploading
- **THEN** the meter advances within the file, not only when the file completes

#### Scenario: Cancel
- **WHEN** the operator cancels
- **THEN** uploads stop, the helper is stopped, and the game shows a partial state that can be resumed

### Requirement: Resume and failure handling
The system SHALL skip, on a retry, files already present in the volume with the expected size, SHALL report the failing path and error when an upload fails, and SHALL retry transient per-file failures a bounded number of times before failing the run. A file left partially written by an interrupted upload SHALL be overwritten on retry.

#### Scenario: Retry after interruption
- **WHEN** an upload is interrupted after 600 of 1,033 files and then retried
- **THEN** the 600 completed files are skipped and only the remainder is uploaded

#### Scenario: Helper expires during a long upload
- **WHEN** the helper's auto-stop elapses mid-upload
- **THEN** the run is reported failed with a Resume action that launches a fresh helper and continues

### Requirement: Verification after upload
After uploading, the system SHALL compare the volume's listing against the selection (file count and per-file size) and SHALL report either success with totals or the list of missing or mismatched paths.

#### Scenario: Verified success
- **WHEN** every selected file exists on the volume with matching size
- **THEN** the run is reported complete with the file count and total bytes

#### Scenario: Mismatch
- **WHEN** a selected file is missing or has a different size on the volume
- **THEN** the run is reported failed listing those paths, with a Retry action

### Requirement: Safety limits and scope of state
The system SHALL skip symbolic links (noting how many were skipped), SHALL reject any entry whose destination would escape the destination directory, and SHALL persist the folder selection and last-upload state per game in application-local state, not in `deployment-config.json`. Existing inline `file_seeds` SHALL be unaffected.

#### Scenario: Symlink in the folder
- **WHEN** the folder contains a symbolic link
- **THEN** it is omitted and the UI notes how many links were skipped

#### Scenario: Selection survives restart
- **WHEN** the operator selects a folder, closes the app, and reopens it
- **THEN** the selection and the last-upload status for the game are still shown
