## ADDED Requirements

### Requirement: Per-port visibility field
`GameServerPort` SHALL support an optional `visibility` field whose value,
when present, MUST be exactly `'public'` or `'internal'`. A port whose
`visibility` is omitted MUST be treated identically to `visibility:
'public'` in every downstream consumer (security-group ingress, wizard
display, validation).

#### Scenario: Existing configuration with no visibility field
- **WHEN** a `deployment-config.json` written before this change (every
  port lacking a `visibility` field) is read and applied
- **THEN** every port is treated as `'public'` and the resulting
  infrastructure is unchanged from before this change

#### Scenario: Invalid visibility value rejected
- **WHEN** a game's configuration declares a port with
  `visibility: "vpc-only"` (or any value other than `'public'` or
  `'internal'`)
- **THEN** validation SHALL reject the configuration with an error
  identifying the offending port

---

### Requirement: Internal ports are ingressed from the VPC CIDR block only
For a non-HTTPS game, a port declared with `visibility: 'internal'` SHALL
be ingressed on the `game_servers` security group from the VPC's CIDR
block only, and MUST NOT be included in that security group's
`0.0.0.0/0`-sourced ingress rules. A port declared `'public'` (or with
`visibility` omitted) SHALL continue to be ingressed from `0.0.0.0/0`,
unchanged from current behavior.

#### Scenario: Public and internal ports on the same game
- **WHEN** a non-HTTPS game declares one port with `visibility: 'public'`
  (or omitted) and a second port with `visibility: 'internal'`
- **THEN** the `game_servers` security group ingresses the first port from
  `0.0.0.0/0` and the second port from the VPC's CIDR block only

#### Scenario: Internal port unreachable from the internet
- **WHEN** a port is declared `visibility: 'internal'`
- **THEN** no ingress rule on `game_servers` sources that port from
  `0.0.0.0/0`, so a request to that port from outside the VPC is dropped
  at the security group

#### Scenario: A port cannot be declared with conflicting visibility
- **WHEN** two non-HTTPS games attempt to declare the same `(port,
  protocol)` pair
- **THEN** validation SHALL reject the configuration via the existing
  cross-game port-collision rule (`checkPortCollisions`), unchanged by
  this capability — a `(port, protocol)` pair can never reach
  security-group ingress with two different visibility values, because it
  can never be declared twice

---

### Requirement: HTTPS games are unaffected by port visibility
A `GameServerPort.visibility` value on an HTTPS game (`https: true`)
SHALL have no effect on that game's security-group ingress. HTTPS games'
container ports continue to be reached only via the in-task Caddy
sidecar's own public 443/80 ingress, exactly as before this change.

#### Scenario: Visibility declared on an HTTPS game's port
- **WHEN** an HTTPS game declares a port with `visibility: 'internal'`
- **THEN** the `game_servers` security group's ingress for that game is
  unchanged from today (the sidecar's 443/80 public ingress only; the
  declared port itself is not individually ingressed either way)

---

### Requirement: Container ports 443 and 80 (tcp) are reserved deployment-wide when any game is HTTPS
Whenever any game in the deployment has `https: true`, no game — including a
non-HTTPS game, and regardless of that port's declared `visibility` — MAY
declare container port 443 or 80 with protocol `tcp`. This closes an
interaction gap between per-port `visibility` and the pre-existing,
unconditional public ingress the in-task Caddy sidecar requires on 443/80
whenever any HTTPS game exists: without this reservation, a non-HTTPS game
could mark 443 or 80 `'internal'` and still have it reachable from the
internet, because security-group ingress rules union rather than override.

#### Scenario: A non-HTTPS game cannot declare 443/tcp when another game is HTTPS
- **WHEN** a non-HTTPS game attempts to declare container port 443 or 80
  with protocol `tcp`, and any game in the deployment (itself or another)
  has `https: true`
- **THEN** validation SHALL reject the configuration, identifying which
  HTTPS-enabled game reserves that port

#### Scenario: 443/80 remain available when no game is HTTPS
- **WHEN** a game declares container port 443 or 80 with protocol `tcp`,
  and no game in the deployment has `https: true`
- **THEN** validation SHALL accept the configuration — this reservation
  only applies once an HTTPS game exists

#### Scenario: UDP on 443/80 is never reserved
- **WHEN** a game declares container port 443 or 80 with protocol `udp`,
  regardless of whether any game has `https: true`
- **THEN** validation SHALL accept the configuration — the reservation is
  scoped to `tcp` only, matching the Caddy sidecar's own protocol

---

### Requirement: Wizard exposes per-port visibility
The add/edit-game wizard in `@hyveon/web` SHALL let an operator set each
declared port's visibility to Public or VPC-only, defaulting new ports to
Public, without requiring direct edits to `deployment-config.json`.

#### Scenario: Operator marks a port VPC-only in the wizard
- **WHEN** an operator, while adding or editing a game's port, selects
  "VPC-only" for that port and saves
- **THEN** the persisted configuration's `GameServerPort.visibility` for
  that port is `'internal'`

#### Scenario: New port defaults to Public
- **WHEN** an operator adds a new port entry in the wizard without
  changing the visibility control
- **THEN** the persisted configuration either omits `visibility` for that
  port or sets it to `'public'`
