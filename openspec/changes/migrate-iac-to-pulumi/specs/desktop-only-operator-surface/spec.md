## ADDED Requirements

### Requirement: No operator-editable configuration files

The app SHALL be the only supported way to read or change Hyveon's configuration. No configuration file on the operator's machine may be load-bearing: the canonical game-server and deployment configuration lives in the operator's versioned S3 configuration bucket, the infrastructure program ships inside the application bundle, and infrastructure state lives in the self-managed S3 backend. There MUST NOT be a local-file configuration mode — reading configuration from a path on disk when a bucket is not configured is removed, not retained as a fallback, because a silent fallback reintroduces exactly the hand-editable file this requirement exists to eliminate.

This is a supportability boundary, not a security boundary. The application bundle is not tamper-proof and is not claimed to be; the guarantee is that there is no *supported* path by which hand-editing a local file changes what gets deployed, so no such edit can silently diverge from what the app believes is deployed.

#### Scenario: No local configuration fallback exists

- **WHEN** the configuration source is resolved and no configuration bucket is configured
- **THEN** the app reports that setup is incomplete and directs the operator to the wizard, rather than falling back to reading a configuration file from disk

#### Scenario: Configuration changes go through the app

- **WHEN** the operator changes any deployment setting or game-server entry
- **THEN** the change is written as a new version of the configuration object in S3 through the app, and no file on the operator's machine needs to be edited

#### Scenario: No unguarded local writes remain

- **WHEN** the desktop main process is searched for synchronous filesystem writes of configuration content
- **THEN** none exist — every configuration write goes through the remote store's conditional-write path, which carries optimistic locking and version history

#### Scenario: Deployment settings are editable in the UI

- **WHEN** the operator opens the deployment settings section
- **THEN** every setting that previously required hand-editing a variables file is presented as a form control, validated before write

### Requirement: Nothing but the app runs in a terminal

Provisioning, updating, inspecting, and destroying infrastructure SHALL be achievable entirely from the desktop app. No operator-facing workflow may require running an infrastructure CLI, a cloud provider CLI, a build tool, or a shell script. Operator-facing documentation MUST NOT instruct the operator to run any command other than launching the app itself.

#### Scenario: Clean machine reaches a deployed cluster through the app alone

- **WHEN** an operator installs the app on a machine with no infrastructure tooling, no cloud CLI, and no repository checkout, and completes the wizard
- **THEN** infrastructure is deployed without their having run any command in a terminal

#### Scenario: Documentation prescribes no CLI steps

- **WHEN** operator-facing documentation is searched for instructions to run an infrastructure or cloud CLI
- **THEN** no such instruction exists outside sections explicitly labelled as maintainer or contributor workflow
