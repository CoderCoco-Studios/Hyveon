## ADDED Requirements

### Requirement: Infrastructure program workspace

The infrastructure definition SHALL live in a dedicated npm workspace (`@hyveon/infra`) as TypeScript, replacing the `terraform/` HCL tree. The program MUST be consumable by the desktop main process without shipping loose source files as packaged resources, so that a packaged build carries its infrastructure definition in the application bundle rather than in `extraResources`. The program MUST be independently type-checked, linted, and unit-testable by the repo's existing root scripts.

#### Scenario: Packaged build carries the program

- **WHEN** the app is packaged and launched on a clean machine
- **THEN** an infrastructure preview can be run without any infrastructure source files needing to be present outside the application bundle

#### Scenario: Program is covered by root tooling

- **WHEN** `npm run app:lint` and `npm run app:test` run from the repo root
- **THEN** the infrastructure workspace is included in both

### Requirement: Typed game-server configuration model

The `game_servers` configuration SHALL be a typed structure exported from `@hyveon/shared` and consumed directly by both the infrastructure program and the desktop app, replacing the HCL `game_servers` map. Adding or removing an entry MUST remain the only edit required to add or remove a game — every per-game resource (task definition, save-data access point, log group, security-group ingress, and the certificate access point for HTTPS games) SHALL be derived from the map by iteration, not hand-written per game.

#### Scenario: Adding a game requires only a config entry

- **WHEN** a new entry is added to the game-server configuration
- **THEN** a preview reports the full per-game resource set for it with no other source edits

#### Scenario: Removing a game removes its resources

- **WHEN** an entry is removed from the game-server configuration
- **THEN** a preview reports deletion of exactly that game's resources and no others

#### Scenario: Config type is shared, not duplicated

- **WHEN** the game-server configuration shape changes
- **THEN** both the infrastructure program and the desktop app fail to type-check until both are updated, because they import the same type

### Requirement: Configuration persisted as versioned JSON

The canonical game-server configuration SHALL be persisted as a JSON object in the operator's versioned S3 configuration bucket, replacing `terraform.tfvars`. The S3 configuration bucket MUST be the only configuration source — the local-file mode, in which configuration is read from and written to a path on disk when no bucket is configured, is removed rather than retained as a fallback. Reads and writes MUST go through the existing `RemoteFileStore` contract so every write inherits its conditional-write optimistic locking and version history; the unguarded synchronous local write path is deleted, not patched. Writing configuration MUST NOT require parsing or emitting HCL, and the app MUST NOT depend on any HCL parser.

The configuration model SHALL cover the top-level deployment settings as well as the per-game map — project name, region, hosted zone, and the watchdog tunables — so that no setting anywhere requires editing a file by hand.

#### Scenario: No local configuration fallback

- **WHEN** configuration is read and no configuration bucket is configured
- **THEN** the read reports that setup is incomplete rather than falling back to a file on disk

#### Scenario: Editing a game writes JSON

- **WHEN** the operator edits a game through the app
- **THEN** a new version of the JSON configuration object is written to the configuration bucket and no HCL is parsed or emitted

#### Scenario: Configuration round-trips losslessly

- **WHEN** a configuration containing every supported field is written and read back
- **THEN** the parsed result is deeply equal to what was written, including boolean and numeric fields

#### Scenario: No HCL parser dependency remains

- **WHEN** the dependency tree of the desktop main process is inspected
- **THEN** no HCL parsing package is present

### Requirement: No secret material enters the stack

The infrastructure program SHALL NOT accept secret values as configuration inputs. It declares the Discord bot-token and public-key secrets and creates their initial placeholder versions, but never carries their real values — those reach Secrets Manager only through the app's existing AWS SDK path, which is already the documented route and already guarantees neither secret is sent to the renderer. The `discord_bot_token` and `discord_public_key` variables are removed rather than ported, closing the one path by which a real token could be written into infrastructure state.

Because the stack holds no secret material, the stack's secrets provider is chosen for cost rather than recoverability. Any future change that introduces genuine secret values into the stack MUST revisit that choice before doing so — the current provider is machine-bound and has no recovery path if the operator's machine is lost, which is acceptable only while there is nothing to recover.

#### Scenario: Program exposes no secret inputs

- **WHEN** the infrastructure program's configuration inputs are inspected
- **THEN** no input accepts a bot token, a signing key, or any other credential

#### Scenario: Secrets are created as placeholders only

- **WHEN** the program is deployed to a fresh account
- **THEN** the Discord secrets exist with placeholder values, and the operator supplies the real values through the app

#### Scenario: Real credentials never enter state

- **WHEN** the operator configures Discord credentials through the app and infrastructure state is subsequently inspected
- **THEN** the credential values do not appear in state, because the app wrote them directly to Secrets Manager

Preservation MUST be enforced by the program's construction, not merely asserted. The secret's value SHALL be declared as create-only — written once when the secret version does not yet exist, and thereafter excluded from reconciliation — so a later deployment computes no diff against whatever value the app has since written. This is the equivalent of the `ignore_changes = [secret_string]` lifecycle rule the Terraform module relies on, and without it a re-deploy would silently revert working Discord credentials to `"placeholder"` and break the bot.

#### Scenario: Re-deploying does not overwrite configured secrets

- **WHEN** the operator has supplied real Discord credentials through the app and a later deployment runs
- **THEN** the deployment does not reset those secret values back to placeholders

#### Scenario: Secret values are excluded from reconciliation

- **WHEN** a preview runs after the app has written real credential values to Secrets Manager
- **THEN** the preview reports no change for the secret versions, because their values are not reconciled against the program

#### Scenario: Preservation is covered by a test

- **WHEN** the infra program's test suite runs
- **THEN** it includes a case that writes real values through the app's Secrets Manager path, re-deploys, and asserts the values survive unchanged

### Requirement: Resource parity with the retired Terraform module

The infrastructure program SHALL provision the same set of AWS resources the retired Terraform module provisioned, preserving the architectural decisions the system depends on: no long-running ECS service (tasks are run on demand), DNS records managed by the update-dns Lambda rather than by the infrastructure program, HTTPS terminated by a per-task Caddy sidecar with certificates persisted on a dedicated access point rather than by a load balancer, and watchdog idle state stored as tags on the ECS task.

#### Scenario: No persistent ECS service is created

- **WHEN** the program is previewed
- **THEN** it declares per-game task definitions and no long-running ECS service

#### Scenario: No DNS records are declared

- **WHEN** the program is previewed
- **THEN** it declares the hosted-zone lookup and the update-dns Lambda but no per-game DNS record resources, so the Lambda remains the sole writer

#### Scenario: HTTPS games get a sidecar, not a load balancer

- **WHEN** a game is configured with HTTPS enabled
- **THEN** its task definition contains a reverse-proxy sidecar container with a persistent certificate volume, and no load balancer, target group, or managed certificate is declared

#### Scenario: Lambda bundles are deployed from prebuilt output

- **WHEN** the program is previewed after the Lambda bundles have been built
- **THEN** each Lambda's code is sourced from its prebuilt bundle output without invoking a container runtime

### Requirement: Stack outputs contract

The program SHALL export the values the desktop app reads to discover deployed infrastructure, covering at minimum the cluster, networking, and security-group identifiers, the Discord table and secret locations, the interactions invoke URL, and the runs table name. The app MUST read these from the stack rather than from a state file on disk. A stack that has never been deployed MUST resolve as "not deployed yet" rather than raising.

#### Scenario: App reads outputs from the stack

- **WHEN** the app needs deployed infrastructure identifiers
- **THEN** it reads them from the stack's outputs, not by parsing a state file from the filesystem

#### Scenario: Never-deployed stack degrades gracefully

- **WHEN** outputs are requested for a stack that has never been deployed
- **THEN** the app treats the result as "not deployed yet" and renders its empty state without throwing

#### Scenario: Output set covers every consumer

- **WHEN** the app's infrastructure-dependent features are exercised against a deployed stack
- **THEN** every identifier they need is present in the stack outputs
