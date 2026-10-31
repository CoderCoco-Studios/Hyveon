# game-volume-folder-upload Specification

## Purpose

Lets an operator copy a chosen local folder tree into a game server's EFS volume from the desktop app, with a live progress meter, instead of declaring one file seed per file.

## Requirements

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
The system SHALL upload the selected files into the EFS volume that owns the destination (the game volume whose `container_path` is the deepest match for the destination) through the file-manager helper task, which mounts each of the game's applied volumes separately. When the application already holds a helper session for the game, the upload SHALL use that session. Otherwise the application SHALL launch a helper for the duration of the upload. The upload SHALL release its hold when it finishes, fails or is cancelled, and the helper SHALL be stopped when no browse page, other upload or download still holds the session. File contents and the helper's credential SHALL stay in the desktop main process and SHALL NOT reach the renderer, `deployment-config.json` or any log. Upload SHALL be available only once the game's infrastructure has been applied.

#### Scenario: Upload after apply
- **WHEN** the operator starts an upload for a deployed game with no helper session open
- **THEN** the helper is launched, files are written into the volume at their destinations, and the helper is stopped on completion

#### Scenario: Game not deployed
- **WHEN** the game's infrastructure has not been applied
- **THEN** the upload action is disabled with an explanation, and the selection is kept so it can be uploaded after apply

#### Scenario: Game server is running
- **WHEN** the game's server task is running
- **THEN** the upload action is disabled with an explanation that the server must be stopped first

#### Scenario: Server state cannot be confirmed
- **WHEN** the check for a running server task fails
- **THEN** the upload is refused with an explanation that the application couldn't confirm the server is stopped, and nothing is written to the volume

#### Scenario: Upload to a second volume
- **WHEN** the game has volumes `config` at `/data/config` and `saves` at `/data/saves`, and the operator uploads a folder to the destination `/data/saves/worlds`
- **THEN** the files are written into the `saves` volume under `worlds`, and nothing is written to the `config` volume

#### Scenario: Destination volume not yet mounted
- **WHEN** the destination belongs to a volume the helper cannot mount because the infrastructure has not been applied since that volume's access point was exported
- **THEN** the upload is refused before any helper is launched, with an explanation to apply the infrastructure first, and the selection is kept

#### Scenario: Stack applied before per-volume access points were exported
- **WHEN** the operator starts an upload for a game whose stack was applied by a build that did not export per-volume access points, even if the destination is in the game's first volume
- **THEN** the upload is refused before any helper is launched, with an explanation to apply the infrastructure first, because the legacy access point's volume cannot be confirmed, and the selection is kept

#### Scenario: Application-held session already open for this game
- **WHEN** the operator starts an upload while the application holds a browse session for the game
- **THEN** the upload uses that session's helper, and the helper keeps running after the upload ends for as long as the browse page holds it

#### Scenario: Helper running without an application session
- **WHEN** a file-manager helper is running for the game but the application holds no session for it
- **THEN** the application asks the operator to restart the session (stop that helper and launch a new one) rather than using a helper whose credential it does not hold

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
A helper launched for an upload SHALL be tagged as an upload session for its game and the project. The upload SHALL always release its hold on the session when it finishes, fails or is cancelled. A helper SHALL still be stopped by its auto-stop schedule if the application exits mid-session. The application SHALL provide a cleanup that finds file-manager helper tasks owned by neither an active upload run nor an application-held session (on startup and on operator request from Diagnostics), stops them, and reports what it stopped.

#### Scenario: Helper stopped after upload
- **WHEN** an upload completes, fails or is cancelled and nothing else holds the session
- **THEN** the helper task for the game is no longer running

#### Scenario: App closed mid-upload
- **WHEN** the application exits during an upload and is reopened later
- **THEN** the startup sweep stops any helper older than 15 minutes that no active run or session owns, and the game shows a resumable partial state

#### Scenario: Manual cleanup
- **WHEN** the operator runs "Clean up stray helpers"
- **THEN** every file-manager helper task not owned by an active run or an application-held session is stopped and listed in the result

#### Scenario: Browse session survives cleanup
- **WHEN** the cleanup runs while the operator has a browse session open
- **THEN** that session's helper is not stopped

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

### Requirement: Warn before overwriting existing volume files
After the helper is running and authenticated and before any file or directory is written, the system SHALL list the destination directories the plan touches and classify each planned file as new, identical (present with the same size) or conflicting (present with a different size). When there is at least one conflict, the system SHALL pause in an `awaiting-confirmation` phase, SHALL present the conflict, identical and new counts with up to 20 sample conflicting paths (existing size and new size), and SHALL write nothing until the operator explicitly confirms. Declining SHALL cancel the run cleanly (helper stopped, IP rule revoked). An unanswered warning SHALL cancel the run after a confirmation timeout. Existing files the plan does not include SHALL only be counted as context and SHALL never be a conflict.

#### Scenario: Conflicts require confirmation
- **WHEN** the volume already holds a planned file at a different size
- **THEN** the run enters `awaiting-confirmation` with the summary, the helper stays up, and no directory is created and no file is written until the operator confirms

#### Scenario: Operator confirms
- **WHEN** the operator chooses "Overwrite and upload"
- **THEN** the run continues to upload, replacing the conflicting files, and skips the identical ones

#### Scenario: Operator cancels
- **WHEN** the operator declines the warning
- **THEN** the run ends as cancelled with nothing written, the helper is stopped and the operator-IP rule is revoked

#### Scenario: Warning goes unanswered
- **WHEN** the operator does not answer within the confirmation timeout
- **THEN** the run is cancelled with a timeout message and the helper is stopped

#### Scenario: No conflicts
- **WHEN** every planned file is new or identical to what the volume holds
- **THEN** the upload starts without a prompt

#### Scenario: Resume of the app's own partial run
- **WHEN** the previous run for the same folder, selection and destination failed or was cancelled after copying files, and the conflicts do not exceed the number of files that can be in flight
- **THEN** those conflicts are treated as that run's partial files and no prompt is shown

### Requirement: Safety limits and scope of state
The system SHALL skip symbolic links (noting how many were skipped), SHALL reject any entry whose destination would escape the destination directory, and SHALL persist the folder selection and last-upload state per game in application-local state, not in `deployment-config.json`. Existing inline `file_seeds` SHALL be unaffected.

#### Scenario: Symlink in the folder
- **WHEN** the folder contains a symbolic link
- **THEN** it is omitted and the UI notes how many links were skipped

#### Scenario: Selection survives restart
- **WHEN** the operator selects a folder, closes the app, and reopens it
- **THEN** the selection and the last-upload status for the game are still shown
