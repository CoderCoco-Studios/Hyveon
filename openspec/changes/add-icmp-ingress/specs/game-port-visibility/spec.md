## ADDED Requirements

### Requirement: ICMP port declarations
`GameServerPort.protocol` SHALL additionally accept the exact lowercase string `'icmp'`. For an `icmp` entry, `container` SHALL be interpreted as the ICMP type (not a port number) and MUST be an integer between 0 and 255 inclusive; validation SHALL reject any other value, identifying the offending entry. An `icmp` entry SHALL produce a `game_servers` security-group ingress rule with protocol `icmp`, `fromPort` equal to the declared type, and `toPort` `-1` (all codes), and MUST NOT produce an ECS `portMappings` entry. The existing rule that every port of an `https: true` game must use protocol `tcp` or `udp` SHALL remain in force, so `icmp` entries on HTTPS games continue to be rejected.

#### Scenario: Palworld declares ping reachability
- **WHEN** a non-HTTPS game's `ports` includes `{ "container": 8, "protocol": "icmp" }`
- **THEN** the `game_servers` security group ingresses ICMP type 8 (all codes) from `0.0.0.0/0`, and the game's task-definition `portMappings` contains no entry for it

#### Scenario: ICMP type out of range rejected
- **WHEN** a game declares `{ "container": 8211, "protocol": "icmp" }`
- **THEN** validation SHALL reject the configuration with an error identifying the entry and stating the valid ICMP type range 0–255

#### Scenario: ICMP entry on an HTTPS game rejected
- **WHEN** a game with `https: true` declares a port with `protocol: "icmp"`
- **THEN** validation SHALL reject the configuration via the existing HTTPS protocol rule, unchanged by this capability

#### Scenario: Internal ICMP entry scoped to the VPC
- **WHEN** a non-HTTPS game declares `{ "container": 8, "protocol": "icmp", "visibility": "internal" }`
- **THEN** the ICMP type 8 ingress rule sources from the VPC's CIDR block only, and no `0.0.0.0/0`-sourced ICMP rule exists for it

---

### Requirement: Cross-game ICMP declarations
Duplicate `(container, protocol)` pairs whose protocol is `icmp` SHALL be permitted across different games when every declaration of that pair has the same effective visibility (`'public'`, whether explicit or omitted, versus `'internal'`); the shared security group SHALL carry one deduplicated rule for the pair. Cross-game declarations of the same `icmp` pair with conflicting effective visibility SHALL be rejected by validation, identifying both games. Duplicate `icmp` entries within a single game SHALL remain rejected by the existing same-game collision rule.

#### Scenario: Two games both declare ping
- **WHEN** two non-HTTPS games each declare `{ "container": 8, "protocol": "icmp" }` with the same effective visibility
- **THEN** validation SHALL accept the configuration and the `game_servers` security group carries exactly one ICMP type 8 ingress rule

#### Scenario: Conflicting visibility across games rejected
- **WHEN** one game declares `8/icmp` as `'public'` (or omitted) and another declares `8/icmp` as `'internal'`
- **THEN** validation SHALL reject the configuration, identifying both games and the visibility conflict

#### Scenario: Duplicate ICMP entries in one game rejected
- **WHEN** a single game declares two `ports` entries with `container: 8, protocol: "icmp"`
- **THEN** validation SHALL reject the configuration via the existing same-game collision rule

---

### Requirement: Wizard supports ICMP entries
The add/edit-game wizard in `@hyveon/web` SHALL offer `icmp` in each port row's protocol dropdown. When `icmp` is selected, the numeric field SHALL be presented as the ICMP type — defaulting to 8 for a new ICMP row — with a visible hint that 8 means echo request (ping), and its validation message SHALL state the 0–255 type range.

#### Scenario: Operator adds ping via the wizard
- **WHEN** an operator adds a port row, selects protocol `icmp`, and saves without editing the numeric field
- **THEN** the persisted configuration contains `{ "container": 8, "protocol": "icmp" }` for that game

#### Scenario: Wizard rejects an out-of-range ICMP type
- **WHEN** an operator selects protocol `icmp` and enters 300 in the numeric field
- **THEN** the wizard blocks the step with a message stating the ICMP type must be between 0 and 255

---

### Requirement: Connect-port surfaces exclude ICMP entries
Any surface that derives a game's connect port from its first declared port — the Discord `GAME_PORTS` mapping built by `firstPortByGame()` — SHALL use the first non-`icmp` port, so an `icmp` entry's ICMP type is never presented as a connectable port.

#### Scenario: ICMP entry listed first
- **WHEN** a game's `ports` lists `{ "container": 8, "protocol": "icmp" }` first and `{ "container": 8211, "protocol": "udp" }` second
- **THEN** the Discord connect message for that game presents port 8211

---

## MODIFIED Requirements

### Requirement: Internal ports are ingressed from the VPC CIDR block only
For a non-HTTPS game, a port declared with `visibility: 'internal'` SHALL be ingressed on the `game_servers` security group from the VPC's CIDR block only, and MUST NOT be included in that security group's `0.0.0.0/0`-sourced ingress rules. A port declared `'public'` (or with `visibility` omitted) SHALL continue to be ingressed from `0.0.0.0/0`, unchanged from current behavior.

#### Scenario: Public and internal ports on the same game
- **WHEN** a non-HTTPS game declares one port with `visibility: 'public'` (or omitted) and a second port with `visibility: 'internal'`
- **THEN** the `game_servers` security group ingresses the first port from `0.0.0.0/0` and the second port from the VPC's CIDR block only

#### Scenario: Internal port unreachable from the internet
- **WHEN** a port is declared `visibility: 'internal'`
- **THEN** no ingress rule on `game_servers` sources that port from `0.0.0.0/0`, so a request to that port from outside the VPC is dropped at the security group

#### Scenario: A tcp or udp port cannot be declared with conflicting visibility
- **WHEN** two non-HTTPS games attempt to declare the same `(port, protocol)` pair with protocol `tcp` or `udp`
- **THEN** validation SHALL reject the configuration via the existing cross-game port-collision rule (`checkPortCollisions`), unchanged by this capability — a tcp/udp `(port, protocol)` pair can never reach security-group ingress with two different visibility values, because it can never be declared twice. (`icmp` pairs are exempt from the cross-game collision rule and instead governed by the `Cross-game ICMP declarations` requirement, whose visibility-conflict rule preserves the same guarantee.)
