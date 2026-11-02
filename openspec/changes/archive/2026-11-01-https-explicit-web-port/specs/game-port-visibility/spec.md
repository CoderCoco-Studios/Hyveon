## RENAMED Requirements

- FROM: `### Requirement: HTTPS games are unaffected by port visibility`
- TO: `### Requirement: Port visibility applies to an HTTPS game's additional ports`

## MODIFIED Requirements

### Requirement: Internal ports are ingressed from the VPC CIDR block only
A port declared with `visibility: 'internal'` SHALL be ingressed on the `game_servers` security group from the VPC's CIDR block only, and MUST NOT be included in that security group's `0.0.0.0/0`-sourced ingress rules. A port declared `'public'` (or with `visibility` omitted) SHALL be ingressed from `0.0.0.0/0`. This applies to every game, including an HTTPS game's additional `ports`; an HTTPS game's `webPort` is not a `ports` entry and receives no ingress.

#### Scenario: Public and internal ports on the same game
- **WHEN** a game declares one port with `visibility: 'public'` (or omitted) and a second port with `visibility: 'internal'`
- **THEN** the `game_servers` security group ingresses the first port from `0.0.0.0/0` and the second port from the VPC's CIDR block only

#### Scenario: Internal port unreachable from the internet
- **WHEN** a port is declared `visibility: 'internal'`
- **THEN** no ingress rule on `game_servers` sources that port from `0.0.0.0/0`, so a request to that port from outside the VPC is dropped at the security group

### Requirement: Port visibility applies to an HTTPS game's additional ports
A `GameServerPort.visibility` value on an HTTPS game (`https: true`) SHALL control the security-group ingress of that `ports` entry exactly as it does for a non-HTTPS game. The game's `webPort` SHALL be reached only via the in-task Caddy sidecar's public 443/80 ingress and has no visibility setting.

#### Scenario: Internal additional port on an HTTPS game
- **WHEN** an HTTPS game declares an additional port with `visibility: 'internal'`
- **THEN** that port is ingressed from the VPC's CIDR block only, and the sidecar's public 443/80 ingress is unchanged

#### Scenario: Public additional port on an HTTPS game
- **WHEN** an HTTPS game declares an additional UDP port with `visibility` omitted
- **THEN** that port is ingressed from `0.0.0.0/0`

### Requirement: Connect-port surfaces exclude ICMP entries
Any surface that derives a game's connect port from its first declared port — the Discord `GAME_PORTS` mapping built by `firstPortByGame()` — SHALL use the first non-`icmp` public port for non-HTTPS games, so an `icmp` entry's ICMP type is never presented as a connectable port. For an HTTPS game the surface SHALL present the public 443 URL form and SHALL NOT present `webPort` or any additional port as the connect port.

#### Scenario: ICMP entry listed first
- **WHEN** a non-HTTPS game's `ports` lists `{ "container": 8, "protocol": "icmp" }` first and `{ "container": 8211, "protocol": "udp" }` second
- **THEN** the Discord connect message for that game presents port 8211

#### Scenario: HTTPS game connect message
- **WHEN** an HTTPS game with `webPort: 30000` is reported running
- **THEN** the Discord connect message presents the `https://{game}.{hosted_zone_name}` URL, not 30000
