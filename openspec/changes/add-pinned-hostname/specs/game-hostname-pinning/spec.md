## ADDED Requirements

### Requirement: Optional pinned hostname field

`GameServerConfig` SHALL accept an optional `pinnedHostname` string. When present, it SHALL be the exact value that `os.hostname()` returns inside that game's Node process. When absent, the game's behavior and task definition SHALL be unchanged from before this capability existed. The field SHALL carry no secret material and SHALL round-trip unchanged through `deployment-config.json` and the redacted game shape.

#### Scenario: Field round-trips through the deployment config

- **WHEN** a game entry with `pinnedHostname: "foundry"` is saved and read back
- **THEN** the read entry carries `pinnedHostname: "foundry"` and the redacted game shape exposes the same value

#### Scenario: Absent field is not synthesized

- **WHEN** a game entry without `pinnedHostname` is saved and read back
- **THEN** the read entry has no `pinnedHostname` key

### Requirement: Pinned hostname validation

Validation SHALL reject a `pinnedHostname` that does not match `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`, reporting the issue at path `pinnedHostname`. When `pinnedHostname` is set, validation MUST also reject any volume whose `container_path` equals `/hyveon/hostname-shim` or begins with `/hyveon/hostname-shim/`, reporting the issue at that volume's `container_path` path. The wizard and the server-side validator SHALL use the same pattern and the same message text.

#### Scenario: Valid hostname accepted

- **WHEN** a game declares `pinnedHostname: "my_foundry_host"`
- **THEN** validation reports no `pinnedHostname` issue

#### Scenario: Invalid characters rejected

- **WHEN** a game declares `pinnedHostname: "foundry host"` or `pinnedHostname: "-foundry"`
- **THEN** validation reports an issue at path `pinnedHostname`

#### Scenario: Over-length value rejected

- **WHEN** a game declares a `pinnedHostname` of 64 characters
- **THEN** validation reports an issue at path `pinnedHostname`

#### Scenario: Reserved shim path collision rejected

- **WHEN** a game declares `pinnedHostname: "foundry"` and a volume with `container_path: "/hyveon/hostname-shim"`
- **THEN** validation reports an issue at that volume's `container_path` path

#### Scenario: Reserved path is free when the field is absent

- **WHEN** a game declares no `pinnedHostname` and a volume with `container_path: "/hyveon/hostname-shim"`
- **THEN** validation reports no reserved-path issue

### Requirement: Task definition wiring for a pinned hostname

When a game declares `pinnedHostname`, the infra program SHALL add to that game's task definition, and to no other game's: a volume named `<game>-hostname-shim` with no EFS configuration; a container named `hostname-shim` with `essential: false`, a pinned public busybox image, a read-write mount of that volume at `/hyveon/hostname-shim`, and a command that writes `/hyveon/hostname-shim/hostname-shim.js` containing a CommonJS module that replaces `require('node:os').hostname` with a function returning the configured value; and, on the game container, a `dependsOn` entry `{ containerName: "hostname-shim", condition: "SUCCESS" }` plus a read-only mount of the same volume at `/hyveon/hostname-shim`. The program MUST NOT declare any resource outside the task definition for this feature, MUST NOT declare an ECS Service, and MUST leave the Caddy sidecar definition unchanged.

#### Scenario: Opted-in game gets the init container and mounts

- **WHEN** the infra program builds the task definition for a game declaring `pinnedHostname: "foundry"`
- **THEN** the container definitions include a non-essential `hostname-shim` container, the game container depends on it with condition `SUCCESS` and mounts `<game>-hostname-shim` read-only at `/hyveon/hostname-shim`, and the task definition's volumes include `<game>-hostname-shim` without an EFS configuration

#### Scenario: Generated shim returns the configured hostname

- **WHEN** the shim bytes generated for `pinnedHostname: "foundry"` are loaded with `require` in a Node process
- **THEN** `require('node:os').hostname()` returns `"foundry"` in that process

#### Scenario: HTTPS game keeps its Caddy sidecar unchanged

- **WHEN** the infra program builds the task definition for a game declaring both `https: true` and `pinnedHostname`
- **THEN** the `caddy` container definition is identical to the one generated for the same game without `pinnedHostname`

#### Scenario: Other games are unaffected

- **WHEN** one game declares `pinnedHostname` and another does not
- **THEN** the second game's task definition contains no `hostname-shim` container, volume, mount, or `NODE_OPTIONS` entry

#### Scenario: Absent field yields an unchanged task definition

- **WHEN** the infra program builds the task definition for a game with no `pinnedHostname`
- **THEN** the generated container definitions and volumes are identical to those produced before this capability existed

### Requirement: NODE_OPTIONS preloads the shim

For a game declaring `pinnedHostname`, the game container's environment SHALL contain exactly one `NODE_OPTIONS` entry whose value begins with `--require=/hyveon/hostname-shim/hostname-shim.js`. If the game's configured environment already declares `NODE_OPTIONS`, the program SHALL set the single entry's value to `--require=/hyveon/hostname-shim/hostname-shim.js`, a space, then the operator's value after `${hyveon.*}` token resolution, preserving the operator's flags in order.

#### Scenario: Shim-only NODE_OPTIONS when the operator sets none

- **WHEN** a game declares `pinnedHostname` and no `NODE_OPTIONS` environment variable
- **THEN** the game container's environment contains `NODE_OPTIONS=--require=/hyveon/hostname-shim/hostname-shim.js`

#### Scenario: Operator NODE_OPTIONS is merged after the shim

- **WHEN** a game declares `pinnedHostname` and `NODE_OPTIONS=--max-old-space-size=2048`
- **THEN** the game container's environment contains exactly one `NODE_OPTIONS` entry with value `--require=/hyveon/hostname-shim/hostname-shim.js --max-old-space-size=2048`

#### Scenario: Merge coexists with the ipv4 boot wrapper

- **WHEN** a game declares `pinnedHostname`, a `command`, and an environment value using `${hyveon.network.public-ipv4}`
- **THEN** the game container keeps the generated `/bin/sh -c` wrapper entrypoint and its environment still contains the merged `NODE_OPTIONS` entry

### Requirement: Wizard control for pinning the hostname

The add-game wizard's environment step, and the edit-game form that reuses it, SHALL offer a "Pin hostname" switch. Turning it on SHALL set the draft's pinned hostname to the game's name and reveal an editable text field bound to it; turning it off SHALL clear the value so the saved entry omits `pinnedHostname`. The control SHALL show helper text that states plainly it only works when the game server process runs on Node.js (it has no effect on any other runtime, so the operator must know their image runs the game under Node), names its use case (Node-based games whose license is bound to the hostname, e.g. Foundry VTT), and states that enabling it on an existing game requires accepting the EULA once more. Invalid values SHALL block advancing with the shared validation message. The review step SHALL show the pinned value when set.

#### Scenario: Helper text states the Node.js requirement

- **WHEN** the operator views the environment step
- **THEN** the "Pin hostname" helper text states that it only works for game servers that run on Node.js

#### Scenario: Enabling pre-fills the game name

- **WHEN** the operator names a game `foundry` and turns on "Pin hostname" in the environment step
- **THEN** the hostname field shows `foundry` and the submitted entry carries `pinnedHostname: "foundry"`

#### Scenario: Disabling omits the field

- **WHEN** the operator turns "Pin hostname" off before submitting
- **THEN** the submitted entry has no `pinnedHostname` key

#### Scenario: Edit form loads an existing value

- **WHEN** the operator opens the edit form for a game whose config has `pinnedHostname: "my_foundry_host"`
- **THEN** the switch is on and the field shows `my_foundry_host`

#### Scenario: Invalid value blocks the step

- **WHEN** the operator enters `foundry host` in the hostname field
- **THEN** the field shows the shared validation message and the wizard does not advance past the environment step

#### Scenario: Review step shows the pinned value

- **WHEN** the draft has a pinned hostname of `foundry` and the operator reaches the review step
- **THEN** the review summary lists the pinned hostname `foundry`
