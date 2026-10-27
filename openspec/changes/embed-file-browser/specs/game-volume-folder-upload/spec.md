## MODIFIED Requirements

### Requirement: Upload goes directly into the mounted volume
The system SHALL upload the selected files into the EFS volume that owns the destination (the game volume whose `container_path` is the deepest match for the destination) through the file-manager helper task, which mounts each of the game's applied volumes separately. When the application already holds a helper session for the game, the upload SHALL use that session. Otherwise the application SHALL launch a helper for the duration of the upload. The upload SHALL release its hold when it finishes, fails or is cancelled, and the helper SHALL be stopped when no browse page or other upload still holds the session. File contents and the helper's credential SHALL stay in the desktop main process and SHALL NOT reach the renderer, `deployment-config.json` or any log. Upload SHALL be available only once the game's infrastructure has been applied.

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

#### Scenario: Application-held session already open for this game
- **WHEN** the operator starts an upload while the application holds a browse session for the game
- **THEN** the upload uses that session's helper, and the helper keeps running after the upload ends for as long as the browse page holds it

#### Scenario: Helper running without an application session
- **WHEN** a file-manager helper is running for the game but the application holds no session for it
- **THEN** the application asks the operator to restart the session (stop that helper and launch a new one) rather than using a helper whose credential it does not hold

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
