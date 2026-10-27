## ADDED Requirements

### Requirement: In-app file browser page per game
The application SHALL provide a page inside the desktop app, routed per game, for browsing and managing every applied EFS volume of that game, with a volume picker that lists each volume's name and container path. The page SHALL be reachable from the dashboard game card's Files action and from the game detail page. The application SHALL NOT open the game's volume files in an external browser or in any embedded remote web content.

#### Scenario: Opening files from the dashboard
- **WHEN** the operator clicks Files on a deployed game's dashboard card
- **THEN** the app navigates to that game's in-app file browser page and starts a helper session for the game

#### Scenario: Opening the page directly
- **WHEN** the operator navigates to a game's file browser page without using the dashboard Files action
- **THEN** the page shows the current session state and does not start a helper until the operator clicks Start session

#### Scenario: Game not deployed
- **WHEN** the game's infrastructure has not been applied
- **THEN** the page explains that the volume does not exist yet and offers no session or file actions

#### Scenario: No external browser
- **WHEN** a helper session is running
- **THEN** no control on the page opens the helper in the OS browser or loads the helper's web interface in any window

#### Scenario: Choosing a volume
- **WHEN** the game has more than one volume and the operator selects a different volume in the picker
- **THEN** the listing shows that volume's root, and file operations and uploads apply to that volume

#### Scenario: Volume not yet available to the helper
- **WHEN** a volume's access point has not been recorded by an infrastructure apply yet
- **THEN** the picker shows that volume as unavailable with an explanation to apply the infrastructure, and the other volumes remain browsable

### Requirement: Helper credentials and address stay in the main process
The per-launch helper credential, the helper's network address and any authentication token SHALL exist only in the desktop main process. They SHALL NOT be returned over IPC, rendered, persisted or logged. The renderer SHALL receive only session state, the game's volume names and container paths, file metadata (names, types, sizes, modification times) and operation results.

#### Scenario: Session start result
- **WHEN** a helper session starts successfully
- **THEN** the IPC result carries the session state and contains no username, password, token, IP address or URL

#### Scenario: Status polling
- **WHEN** the renderer polls session status while the helper is running
- **THEN** each result contains no credential, IP address or URL

### Requirement: Encrypted, pinned, operator-only transport for every helper session
Every helper session, whether launched for browsing or uploading, SHALL be served over TLS with a certificate generated for that launch, and the application SHALL pin that certificate. The application SHALL refuse to send the credential or any file content over a connection that does not present it. The helper SHALL be reachable only from the operator's current public IP through an application-managed access rule, and that rule SHALL be revoked when no remaining helper needs it.

#### Scenario: Browse session uses TLS
- **WHEN** a browse session's helper is launched
- **THEN** it serves HTTPS with the launch's certificate, and the application communicates with it only over that pinned connection

#### Scenario: Impersonated helper
- **WHEN** the helper endpoint presents a different certificate
- **THEN** the application aborts the connection without sending the credential, and the session reports an error

#### Scenario: Operator IP changes mid-session
- **WHEN** a file operation fails to connect and the operator's detected public IP has changed since launch
- **THEN** the application authorizes the new address, revokes the access rule no remaining helper needs, and retries the operation once before reporting the helper unreachable with a Restart action

### Requirement: One application-owned helper session per game shared by browsing and uploading
The application SHALL hold at most one helper session per game in the main process. Browsing and uploads SHALL share it. The application SHALL stop the helper when the operator stops the session, when no browse page or upload run holds it any longer (for the browse page, after a grace period following departure from the page), and on application quit. The helper's auto-stop schedule SHALL remain as a backstop. No long-running ECS service SHALL be used.

#### Scenario: Upload while browsing
- **WHEN** an upload starts for a game whose browse session is running
- **THEN** the upload uses the existing helper instead of launching a second one or asking the operator to stop it

#### Scenario: Leaving the page
- **WHEN** the operator leaves the file browser page, no upload holds the session, and the grace period elapses
- **THEN** the helper is stopped and its access rule is revoked

#### Scenario: Returning within the grace period
- **WHEN** the operator returns to the page before the grace period elapses
- **THEN** the existing session is reused without relaunching the helper

#### Scenario: Stop while an upload holds the session
- **WHEN** the operator clicks Stop while an upload run holds the session
- **THEN** the application asks for confirmation, then cancels the upload and stops the helper

#### Scenario: Application quit
- **WHEN** the application quits with a helper session open
- **THEN** the application attempts to stop the helper before exiting, and any helper left running is stopped by its auto-stop schedule or the next startup sweep

#### Scenario: Helper without an application session
- **WHEN** a file-manager helper is running for the game but the main process holds no session for it (for example after an application restart)
- **THEN** the page reports the session as orphaned and offers only Restart, which stops that helper and launches a new session

### Requirement: Session readiness and state reporting
The page SHALL show the session state (stopped, starting, running, stopping, orphaned, failed, not deployed), the elapsed time and the time remaining before auto-stop. A session SHALL be reported running only after the helper task is running, has a reachable address, and has accepted the application's authentication over the pinned connection. While a session is starting, the page SHALL keep refreshing until it becomes running or fails. A failure SHALL surface its reason, including the task's stop reason when the helper exited.

#### Scenario: Task running before address resolves
- **WHEN** the helper task reports RUNNING but its public address is not yet available
- **THEN** the session stays in the starting state and the page keeps refreshing

#### Scenario: Helper exits during start
- **WHEN** the helper task stops before becoming ready
- **THEN** the session reports failed with the task's stop reason

#### Scenario: Helper disappears during a session
- **WHEN** a running session's helper task is no longer present in ECS (for example after its auto-stop fired)
- **THEN** the session reports failed with the task's stop reason and offers Start

#### Scenario: Auto-stop approaching
- **WHEN** fewer than 10 minutes remain before the helper's auto-stop
- **THEN** the page warns the operator

### Requirement: Browsing and file operations
While a session is running, the page SHALL let the operator navigate directories with a breadcrumb path, and list each directory's entries with name, type, size and modification time, sortable by each column. The page SHALL also let the operator create a folder, rename an entry, delete an entry, upload local files or a local folder into the current directory of the selected volume, and download a file or a folder (as an archive). Every operation SHALL report success or a specific failure, and SHALL log in the main process.

#### Scenario: Navigate into a folder
- **WHEN** the operator opens a folder entry
- **THEN** the listing shows that folder's entries and the breadcrumb path updates

#### Scenario: Delete a folder
- **WHEN** the operator deletes a folder
- **THEN** the application asks for confirmation stating that the folder and its contents will be removed, and deletes it only after confirmation

#### Scenario: Download a file
- **WHEN** the operator downloads a file
- **THEN** a native save dialog opens, the main process streams the file to the chosen path with progress, and a cancelled or failed download leaves no partial file

#### Scenario: Upload a folder into the current directory
- **WHEN** the operator uploads a local folder from the page
- **THEN** the folder-upload flow runs with the selected volume's container path joined with the current directory as its destination, does not replace the game's saved folder-upload selection, and shows its progress meter

#### Scenario: Drag and drop from the OS
- **WHEN** the operator drops local files onto the listing
- **THEN** they are uploaded into the current directory

#### Scenario: Name conflict on create or rename
- **WHEN** a new folder or rename target already exists
- **THEN** the operation is refused with a message naming the conflict, and nothing is overwritten

### Requirement: Volume path safety
The main process SHALL validate every volume path it receives before using it. Every request SHALL name a volume the current session mounted. A path SHALL be absolute within that volume's root, SHALL NOT contain `..` segments or NUL bytes, and new entry names SHALL NOT contain path separators. Local file paths for upload and download SHALL come only from native dialogs opened by the main process, or from OS drag-and-drop resolved to paths in the preload script; renderer code SHALL NOT supply local path strings.

#### Scenario: Traversal attempt
- **WHEN** a file operation is requested with a path containing a `..` segment
- **THEN** the main process rejects it without contacting the helper

#### Scenario: Separator in a new name
- **WHEN** a rename or new-folder name contains `/`
- **THEN** the operation is rejected with a validation message

#### Scenario: Unknown volume
- **WHEN** a file operation names a volume the current session did not mount
- **THEN** the main process rejects it without contacting the helper

### Requirement: Read-only while the game server is running
While the game's server task is starting or running, the page SHALL allow browsing and downloading. Creating, renaming, deleting, uploading and saving edits SHALL be disabled with an explanation, and the main process SHALL refuse those operations. When the application cannot determine whether the server task is running, it SHALL treat the server as running for these operations.

#### Scenario: Server running
- **WHEN** the operator opens the page while the game's server is running
- **THEN** listing and download work, and mutating actions are disabled with an explanation that the server must be stopped first

#### Scenario: Server starts during a session
- **WHEN** the game's server starts while the page is open
- **THEN** mutating actions become disabled, and a mutating request already sent is refused by the main process

#### Scenario: Server state cannot be confirmed
- **WHEN** the check for a running server task fails
- **THEN** the main process refuses the mutation, and the page shows that it couldn't confirm the server is stopped with a Retry action, while listing and download keep working

### Requirement: Small text file view and edit
The page SHALL let the operator open a UTF-8 text file of at most 1 MiB in an in-app editor and save changes. Saving SHALL be refused if the file changed on the volume since it was opened. Larger or non-text files SHALL be offered for download instead.

#### Scenario: Edit a config file
- **WHEN** the operator opens a small text file, edits it and saves while the server is stopped
- **THEN** the file on the volume contains the edited content

#### Scenario: Concurrent change
- **WHEN** the file's modification time on the volume differs from when it was opened
- **THEN** the save is refused with a conflict message, and the operator's edits remain in the editor

#### Scenario: Binary or large file
- **WHEN** the operator opens a file over 1 MiB or one that is not valid UTF-8
- **THEN** the page offers a download instead of the editor

### Requirement: Replaceable file backend
The main process SHALL access volume files only through a backend interface covering list, stat, read, write, create folder, move/rename, delete, and optional folder archive. The renderer and the IPC contract SHALL NOT depend on the helper implementation. The helper container image SHALL be pinned to an immutable version.

#### Scenario: Backend without archive support
- **WHEN** the active backend does not support folder archives
- **THEN** the folder download action is hidden, and all other operations work

#### Scenario: Pinned helper image
- **WHEN** a helper is launched
- **THEN** its task definition references the helper image by an immutable digest or exact version tag, not a floating tag
