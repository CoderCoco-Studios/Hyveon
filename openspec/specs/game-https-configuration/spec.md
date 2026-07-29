# game-https-configuration

## Purpose

Operator-facing configuration of a game's in-task TLS termination — how the `https` flag is presented in the game form, what constraints govern a valid HTTPS-enabled game, what the operator is told before enabling it, and how the value round-trips to the tfvars declaration. The infrastructure the flag drives is specified by `in-task-tls-termination`.

## Requirements

### Requirement: Operators can set a game's HTTPS flag from the game form

The web UI SHALL expose the `https` flag as an editable control in both the add-game wizard and the edit-game form. The control SHALL live in the Networking step, which both flows render. The flag SHALL default to disabled for a new game and SHALL reflect the game's current declared value when editing an existing game.

#### Scenario: Creating a game with HTTPS enabled

- **WHEN** an operator starts the add-game wizard, reaches the Networking step, and enables the HTTPS control
- **THEN** the submitted create payload carries `https: true` in the game config

#### Scenario: Creating a game without touching the control

- **WHEN** an operator completes the add-game wizard without interacting with the HTTPS control
- **THEN** the submitted create payload carries `https: false`

#### Scenario: Editing a game that already has HTTPS enabled

- **WHEN** an operator opens the edit form for a game whose declaration sets `https = true`
- **THEN** the HTTPS control renders in the enabled state

#### Scenario: Disabling HTTPS on an existing game

- **WHEN** an operator opens the edit form for a game with `https = true`, disables the control, and saves
- **THEN** the submitted update payload carries `https: false` rather than carrying the previous `true` forward

#### Scenario: Saving an unrelated field does not disturb the flag

- **WHEN** an operator edits only the container image on a game with `https = true` and saves
- **THEN** the submitted update payload still carries `https: true`

### Requirement: An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints

The shared game-server validator SHALL enforce, for any game whose `https` flag is true, the same four constraints that the Terraform `game_servers` variable validation enforces. Because the validator runs on the IPC and HTTP write surfaces as well as behind the form, these constraints SHALL apply to every write path, not only the UI.

The constraints are:

1. the game MUST declare at least one port;
2. the first port entry MUST use protocol `tcp`, matched exactly and in lowercase;
3. every port entry MUST use a protocol of either `tcp` or `udp`;
4. no port entry may use container port 80 or 443.

Each violation SHALL be reported with an issue path anchored to the offending port entry (`ports[N]`) where a specific entry is at fault, so the Networking step can highlight that row. A violation of constraint 1 SHALL be pathed at `ports`.

#### Scenario: HTTPS game with no ports declared

- **WHEN** a game config sets `https: true` and declares an empty `ports` array
- **THEN** validation fails with an issue pathed at `ports` explaining that an HTTPS game must declare at least one port

#### Scenario: HTTPS game whose first port is not TCP

- **WHEN** a game config sets `https: true` and its first port entry uses protocol `udp`
- **THEN** validation fails with an issue pathed at `ports[0]` explaining that the first port must use protocol `tcp`

#### Scenario: HTTPS game whose first port protocol is uppercase

- **WHEN** a game config sets `https: true` and its first port entry uses protocol `TCP`
- **THEN** validation fails with an issue pathed at `ports[0]`, because Terraform matches the literal lowercase string

#### Scenario: HTTPS game using a port reserved for the sidecar

- **WHEN** a game config sets `https: true` and any port entry declares container port 443
- **THEN** validation fails with an issue pathed at that port entry explaining that 80 and 443 are reserved for the Caddy sidecar

#### Scenario: Port with an unsupported protocol

- **WHEN** a game config sets `https: true` and any port entry uses a protocol other than `tcp` or `udp`
- **THEN** validation fails with an issue pathed at that port entry

#### Scenario: Constraints are inert when HTTPS is off

- **WHEN** a game config sets `https: false` or omits the flag entirely, and declares a single `udp` port on container port 443
- **THEN** validation does not report any of the four HTTPS constraints

#### Scenario: A valid HTTPS game passes

- **WHEN** a game config sets `https: true` and declares a first port of container 8080 protocol `tcp`
- **THEN** validation reports no HTTPS-related issues

### Requirement: The form blocks a save that Terraform would reject

The game form SHALL surface HTTPS constraint violations as blocking validation issues, disabling the save action while any remain. Issues pathed at a port entry SHALL be attributed to the Networking step so the operator is directed to the control that caused them.

#### Scenario: Save is blocked while a constraint is violated

- **WHEN** an operator enables HTTPS on a game whose first port uses `udp`
- **THEN** the save action is disabled and the Networking step shows the violation against the offending port row

#### Scenario: Save unblocks once the configuration is corrected

- **WHEN** the operator changes that first port's protocol to `tcp`
- **THEN** the violation clears and the save action becomes available

### Requirement: Operators are warned about the consequences of enabling HTTPS

When the HTTPS control is enabled, the form SHALL display an inline warning callout adjacent to the control. The callout SHALL state all three infrastructure consequences, because none of them are undone by simply disabling the flag after a `terraform apply` has run:

1. ports 443 and 80 become open to the internet for the whole stack, not only for this game;
2. this game's raw container port loses its public ingress rule, and reaching the game goes through the sidecar;
3. the task's first boot performs a Let's Encrypt (ACME) issuance, which requires `{game}.{hosted_zone_name}` to resolve to the running task.

#### Scenario: Callout appears when the flag is enabled

- **WHEN** an operator enables the HTTPS control
- **THEN** a warning callout appears beside it covering the ingress change, the loss of direct port access, and the ACME/DNS requirement

#### Scenario: Callout is absent when the flag is off

- **WHEN** the HTTPS control is disabled
- **THEN** no warning callout is rendered

### Requirement: The HTTPS flag round-trips to the tfvars declaration

A game's `https` value SHALL survive the full write path from form submission to the emitted HCL in the remote tfvars object, and SHALL be read back into the form on a subsequent edit.

#### Scenario: Enabling HTTPS rewrites the declaration

- **WHEN** a game previously declared without `https` is updated with `https: true`
- **THEN** the rewritten tfvars entry emits `https = true`

#### Scenario: Disabling HTTPS rewrites the declaration

- **WHEN** a game declared with `https = true` is updated with `https: false`
- **THEN** the rewritten tfvars entry emits `https = false` rather than omitting the attribute

#### Scenario: Unrelated edits preserve the declared value

- **WHEN** a game declared with `https = true` has only its memory value updated
- **THEN** the rewritten tfvars entry still emits `https = true` and no other attribute is disturbed
