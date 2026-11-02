## ADDED Requirements

### Requirement: An HTTPS-enabled game declares an explicit web port

`GameServerConfig` SHALL carry an optional `webPort` field naming the container port the game's web server listens on — the port the Caddy sidecar proxies to. `webPort` MUST be present, an integer between 1 and 65535, and neither 80 nor 443 when `https` is true, and MUST be absent when `https` is false or omitted. Violations SHALL be reported with an issue pathed at `webPort`. The value SHALL NOT be implied by the order of `ports`.

#### Scenario: Foundry-style config validates

- **WHEN** a game config sets `https: true`, `webPort: 30000`, and no `ports`
- **THEN** validation reports no HTTPS-related issues

#### Scenario: HTTPS game without a web port

- **WHEN** a game config sets `https: true` and omits `webPort`
- **THEN** validation fails with an issue pathed at `webPort` explaining that an HTTPS game must declare the port its web server listens on

#### Scenario: Web port uses a Caddy-reserved port

- **WHEN** a game config sets `https: true` and `webPort: 443` (or `80`)
- **THEN** validation fails with an issue pathed at `webPort` explaining that Caddy serves 80 and 443 publicly and the web port is the game's own internal listener

#### Scenario: Web port on a non-HTTPS game

- **WHEN** a game config sets `https: false` (or omits it) and declares `webPort`
- **THEN** validation fails with an issue pathed at `webPort` stating it is only valid when HTTPS is enabled

### Requirement: Legacy HTTPS configs are normalised on read

When `DeploymentConfigService` reads a game with `https: true` and no `webPort`, it SHALL treat the first `ports` entry as the upstream: the returned config SHALL have `webPort` equal to that entry's `container` and `ports` equal to the remaining entries. The transformation SHALL be idempotent, SHALL NOT require operator action, and SHALL be persisted only by the next ordinary save. Wizard drafts SHALL receive the same normalisation. Configs that already declare `webPort` SHALL pass through unchanged.

#### Scenario: Legacy https game read

- **WHEN** a persisted game has `https: true` and `ports: [{ container: 8080, protocol: "tcp" }, { container: 27015, protocol: "udp" }]` with no `webPort`
- **THEN** the service returns `webPort: 8080` and `ports: [{ container: 27015, protocol: "udp" }]`

#### Scenario: Normalisation is idempotent

- **WHEN** an already-normalised game is read
- **THEN** it is returned unchanged

#### Scenario: Legacy shape is marked deprecated in code

- **WHEN** the shared normaliser and the `GameServerConfig` `ports`/`webPort` fields are inspected
- **THEN** the normaliser carries a TSDoc `@deprecated` tag and a comment describing the legacy `ports[0]`-as-upstream shape and its removal condition, and the field docs state that the implicit-upstream interpretation is deprecated

#### Scenario: Legacy game with a single port

- **WHEN** a persisted https game declares exactly one port
- **THEN** the returned config has that port as `webPort` and an empty `ports` array

## MODIFIED Requirements

### Requirement: An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints

The shared game-server validator (`gameServerValidator.ts`'s `checkHttpsPortRules`) SHALL enforce, for any game whose `https` flag is true, the following constraints. Because the validator runs on the IPC and HTTP write surfaces as well as behind the form, these constraints SHALL apply to every write path, not only the UI.

The constraints are:

1. every entry in `ports` (which MAY be empty) MUST use a protocol of either `tcp` or `udp`;
2. no `ports` entry may use container port 80 or 443;
3. no `ports` entry may reuse `webPort`'s container port with protocol `tcp`;
4. the `webPort` rules of "An HTTPS-enabled game declares an explicit web port" apply;
5. across games, no game's `tcp` `ports` entry may equal another game's `webPort`, and no `webPort` may equal another game's `tcp` `ports` entry, because the shared security group would then expose that upstream directly and bypass Caddy.

Each violation SHALL be reported with an issue path anchored to the offending field (`ports[N]` or `webPort`) so the Networking step can highlight it. There is no requirement that `ports` be non-empty or that its first entry use `tcp`.

#### Scenario: HTTPS game with no additional ports

- **WHEN** a game config sets `https: true`, a valid `webPort`, and an empty `ports` array
- **THEN** validation reports no issues

#### Scenario: First additional port may be UDP

- **WHEN** a game config sets `https: true`, a valid `webPort`, and `ports` whose first entry uses protocol `udp`
- **THEN** validation reports no issues

#### Scenario: Additional port uses a port reserved for the sidecar

- **WHEN** a game config sets `https: true` and any `ports` entry declares container port 443
- **THEN** validation fails with an issue pathed at that entry explaining that 80 and 443 are reserved for the Caddy sidecar

#### Scenario: Additional port duplicates the web port

- **WHEN** a game config sets `https: true`, `webPort: 8080`, and a `ports` entry `{ container: 8080, protocol: "tcp" }`
- **THEN** validation fails with an issue pathed at that entry stating the port is already the web port

#### Scenario: Extra port collides with another game's web port

- **WHEN** game A has `webPort: 30000` and game B declares a `ports` entry `{ container: 30000, protocol: "tcp" }` (or the edits are made in the opposite order)
- **THEN** validation fails with an issue pathed at B's `ports` entry (or at A's `webPort`) naming the other game

#### Scenario: Port with an unsupported protocol

- **WHEN** a game config sets `https: true` and any `ports` entry uses a protocol other than `tcp` or `udp`
- **THEN** validation fails with an issue pathed at that entry

#### Scenario: Constraints are inert when HTTPS is off

- **WHEN** a game config sets `https: false` or omits the flag entirely, and declares a single `udp` port on container port 443
- **THEN** validation does not report any of the HTTPS constraints

### Requirement: The form blocks a save the shared validator would reject

The game form SHALL surface HTTPS constraint violations as blocking validation issues, disabling the save action while any remain. Issues pathed at `webPort` or a port entry SHALL be attributed to the Networking step so the operator is directed to the control that caused them. When HTTPS is enabled the Networking step SHALL render a dedicated web-port field, separate from the additional-ports list, labeled as the port the game's web server listens on and stating that Caddy serves it publicly on 443; the additional-ports list SHALL be labeled as optional extra ports.

#### Scenario: Save is blocked while the web port is missing

- **WHEN** an operator enables HTTPS and leaves the web-port field empty
- **THEN** the save action is disabled and the Networking step shows the violation against the web-port field

#### Scenario: Save unblocks once the configuration is corrected

- **WHEN** the operator enters 30000 in the web-port field
- **THEN** the violation clears and the save action becomes available

#### Scenario: Web-port field hidden when HTTPS is off

- **WHEN** the HTTPS control is disabled
- **THEN** no web-port field is rendered and the submitted payload carries no `webPort`

### Requirement: Operators are warned about the consequences of enabling HTTPS

When the HTTPS control is enabled, the form SHALL display an inline warning callout adjacent to the control. The callout SHALL state all three infrastructure consequences, because none of them are undone by simply disabling the flag after an apply run has provisioned it:

1. ports 443 and 80 become open to the internet for the whole stack, not only for this game;
2. the game's web port is no longer publicly reachable directly, and reaching it goes through the sidecar (additional ports follow their own visibility);
3. the task's first boot performs a Let's Encrypt (ACME) issuance, which requires `{game}.{hosted_zone_name}` to resolve to the running task.

#### Scenario: Callout appears when the flag is enabled

- **WHEN** an operator enables the HTTPS control
- **THEN** a warning callout appears beside it covering the ingress change, the loss of direct web-port access, and the ACME/DNS requirement

#### Scenario: Callout is absent when the flag is off

- **WHEN** the HTTPS control is disabled
- **THEN** no warning callout is rendered
