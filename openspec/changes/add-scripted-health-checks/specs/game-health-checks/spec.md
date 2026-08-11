## MODIFIED Requirements

### Requirement: A game may declare an authoritative health check

A game server configuration SHALL support an optional health-check declaration. When a game
declares one, the idle decision for that game's running tasks SHALL be made from that check's
verdict. When a game omits it, the idle decision SHALL continue to be made from the
network-traffic measurement that governs every game today.

A declared check SHALL replace the network-traffic measurement rather than being combined
with it, so that exactly one verdict source applies to any game and an operator reading a
log can attribute a shutdown to a single cause.

The declaration SHALL carry a kind discriminator selecting how the verdict is computed. Two
kinds SHALL be supported: one that issues a declared request and evaluates a declared
condition against the response, and one that computes the verdict from operator-authored
source. Every kind SHALL produce the same verdict shape and SHALL obey the same failure
semantics, so that the component owning the idle decision is unaffected by which kind a game
declares.

#### Scenario: A game with no health check declared

- **WHEN** the idle decision is made for a running task belonging to a game whose
  configuration declares no health check
- **THEN** the verdict comes from the network-traffic measurement
- **AND** no health-check request is made to the task

#### Scenario: A game with a health check declared

- **WHEN** the idle decision is made for a running task belonging to a game whose
  configuration declares a health check
- **THEN** the verdict comes from that check
- **AND** the network-traffic measurement is not consulted for that task

#### Scenario: The declared kind changes

- **WHEN** a game's health check is changed from one kind to another
- **THEN** the idle decision continues to consume the same verdict shape
- **AND** no change to the consecutive-idle counting or shutdown behavior results

### Requirement: Reaching into a game task is confined to what the configuration declares

Performing a health check requires network access from the system's own components into a
running game task, which no component previously had. That access SHALL be confined as
follows.

Network reachability SHALL be restricted to the set of ports declared by opted-in games,
toward game-server tasks only. No other port and no other destination SHALL be reachable
from the health-checking component. Game-server tasks share one security group, so this
confinement is port-level rather than game-level: a game that declares no health check is
unreachable on every port except one that some opted-in game also declares. Game-level
confinement would require per-game security groups and is out of scope here.

Credential access SHALL be restricted to exactly the credentials referenced by opted-in
games' declarations. Credentials SHALL NOT be stored in the configuration itself; the
declaration SHALL carry only a reference to a secret held in the platform's secret store.

The health-checking component SHALL NOT be reachable from outside the deployment, and SHALL
be invocable only by the component that owns the idle decision.

The destination of a health-check request SHALL be derived from the running task's own
network address as reported by the container platform. It SHALL NOT be derived from any
operator-supplied configuration value, and — where a kind computes the verdict from
operator-authored source — it SHALL NOT be derived from any value that source produces. No
operator input of any kind shall be capable of directing a health-check request at a host
other than the game task being checked.

The component that owns the idle decision SHALL NOT itself acquire network placement inside
the game network or access to any health-check credential.

#### Scenario: A configuration cannot redirect a check

- **WHEN** a health-check declaration is evaluated
- **THEN** the request is addressed to the network address reported for the task being
  checked
- **AND** no declared value can substitute a different host

#### Scenario: Operator-authored source cannot redirect a check

- **WHEN** a kind computing its verdict from operator-authored source causes an outbound
  request
- **THEN** the destination is the task being checked, chosen by the host
- **AND** no destination that source supplies is used

#### Scenario: A port no game declared for health checking

- **WHEN** the health-checking component's network placement is inspected
- **THEN** it can reach game-server tasks only on ports declared by opted-in games
- **AND** it can reach no destination outside the game-server tasks
