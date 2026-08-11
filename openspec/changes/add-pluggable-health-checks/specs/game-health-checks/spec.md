## Purpose

Defines how the system decides whether a running game server is active or idle, so that a
game able to answer that question authoritatively over its own management API is judged by
that answer rather than by a network-traffic proxy, without weakening the security boundary
around a running game task or risking the shutdown of a server that still has players on it.

## ADDED Requirements

### Requirement: A game may declare an authoritative health check

A game server configuration SHALL support an optional health-check declaration. When a game
declares one, the idle decision for that game's running tasks SHALL be made from that check's
verdict. When a game omits it, the idle decision SHALL continue to be made from the
network-traffic measurement that governs every game today.

A declared check SHALL replace the network-traffic measurement rather than being combined
with it, so that exactly one verdict source applies to any game and an operator reading a
log can attribute a shutdown to a single cause.

The declaration SHALL carry a kind discriminator, so that additional kinds of check can be
introduced later without restructuring existing configuration.

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

### Requirement: The HTTP check kind evaluates a declared request against a declared condition

The system SHALL support a health-check kind that issues an HTTP request to the running game
task and derives the verdict from a single condition evaluated against the response body.

The declaration SHALL specify the scheme, the port, the request path, the HTTP method, any
additional request headers, an optional credential reference for authenticating the request,
and a request timeout. The condition SHALL specify a path into the JSON response body, a
comparison operator, and — for every operator except an existence test — a value to compare
against.

The condition SHALL be a single comparison rather than a composite expression. A game whose
liveness cannot be expressed as one comparison is out of scope for this kind.

The verdict SHALL be active when the condition holds and idle when it does not.

#### Scenario: The condition holds

- **WHEN** the game task returns a successful JSON response whose value at the declared path
  satisfies the declared comparison
- **THEN** the verdict is active

#### Scenario: The condition does not hold

- **WHEN** the game task returns a successful JSON response whose value at the declared path
  does not satisfy the declared comparison
- **THEN** the verdict is idle

#### Scenario: An existence condition is declared

- **WHEN** the condition declares an existence test and no comparison value
- **THEN** the verdict is active if the declared path resolves to a value in the response,
  and idle if it does not

### Requirement: A failed check reports the server as active

Any failure to obtain a conclusive verdict SHALL be reported as active, never as idle. This
SHALL include, at minimum: a request that times out, a connection that is refused or
otherwise cannot be established, a response whose status is not successful, a response body
that cannot be parsed as JSON, a declared path that resolves to no value or to a value that
cannot be compared by the declared operator, an unavailable credential, and a failure to
execute the check at all.

The verdict SHALL carry a human-readable reason distinguishing a failure-derived active
verdict from a genuine one.

#### Scenario: The check times out

- **WHEN** the game task does not respond within the declared timeout
- **THEN** the verdict is active
- **AND** the reason identifies the failure rather than reporting genuine activity

#### Scenario: The check cannot be executed

- **WHEN** the health check cannot be executed at all — for example the executing component
  is unavailable, throttled, or absent
- **THEN** the verdict is active
- **AND** the idle decision proceeds as though the server were in use

#### Scenario: The response cannot be interpreted

- **WHEN** the game task returns a response that is not successful, is not parseable as
  JSON, or contains no value at the declared path
- **THEN** the verdict is active

### Requirement: Health checking is provisioned only for games that use it

The infrastructure required to perform health checks — the executing component, its
permissions, and its network placement — SHALL exist only when at least one game declares a
health check. A deployment in which no game declares one SHALL provision no additional
resources, grant no additional permissions, and incur no additional cost, and SHALL behave
exactly as it did before this capability existed.

#### Scenario: No game opts in

- **WHEN** the infrastructure is applied for a deployment in which no game declares a health
  check
- **THEN** no health-checking resources are declared
- **AND** idle decisions for every game are made from the network-traffic measurement

#### Scenario: At least one game opts in

- **WHEN** the infrastructure is applied for a deployment in which one or more games declare
  a health check
- **THEN** health-checking resources are declared once, serving every opted-in game

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

The destination host of a health-check request SHALL be derived from the running task's own
network address as reported by the container platform, and SHALL NOT be derived from any
operator-supplied configuration value. No configuration value shall be capable of directing
a health-check request at a host other than the game task being checked.

The component that owns the idle decision SHALL NOT itself acquire network placement inside
the game network or access to any health-check credential.

#### Scenario: A configuration cannot redirect a check

- **WHEN** a health-check declaration is evaluated
- **THEN** the request is addressed to the network address reported for the task being
  checked
- **AND** no declared value can substitute a different host

#### Scenario: A port no game declared for health checking

- **WHEN** the health-checking component's network placement is inspected
- **THEN** it can reach game-server tasks only on ports declared by opted-in games
- **AND** it can reach no destination outside the game-server tasks

### Requirement: Health-check configuration is validated before it is saved

A health-check declaration SHALL be validated when the operator saves the configuration, and
an invalid declaration SHALL be rejected at that point rather than failing later during an
idle decision.

Validation SHALL reject, at minimum: a port that is not among the ports the game declares, a
request path that is not rooted, a timeout outside the supported range, a comparison operator
given without a value where one is required, and a malformed credential reference.

#### Scenario: A port that the game does not expose

- **WHEN** an operator saves a game whose health check declares a port absent from that
  game's declared ports
- **THEN** the configuration is rejected with an explanation, and is not persisted

#### Scenario: A comparison without a value

- **WHEN** an operator saves a health check declaring a comparison operator but no value to
  compare against
- **THEN** the configuration is rejected with an explanation

### Requirement: The basis for a shutdown decision is recoverable from the logs

Every health-check verdict SHALL be recorded with the game, the kind of check, the verdict,
and the reason. A failure-derived active verdict SHALL be recorded at a severity that
distinguishes a persistently broken check — which silently keeps a server running and
accruing cost — from normal operation.

The reason SHALL be carried back into the record of the idle decision, so that a single log
stream explains the chain from check outcome, through the consecutive-idle count, to a
shutdown.

Records SHALL NOT contain credential values or game-response bodies, which may carry player
identities and network addresses.

#### Scenario: A server is stopped

- **WHEN** a server is stopped after consecutive idle verdicts
- **THEN** the log records, for each of those verdicts, the check outcome and its reason
  alongside the resulting idle count

#### Scenario: A check is persistently failing

- **WHEN** a health check fails on consecutive evaluations
- **THEN** each failure is recorded at a severity that surfaces it as a fault rather than as
  routine activity
- **AND** no credential value or response body appears in the record

### Requirement: Health-check credentials never reach the operator interface

Where the operator interface presents a health-check declaration, it SHALL indicate whether
a credential is configured without exposing the credential itself, consistent with how the
system treats every other secret it holds.

#### Scenario: An operator edits a game with an authenticated check

- **WHEN** the operator opens a game whose health check references a credential
- **THEN** the interface shows that a credential is set
- **AND** the credential value is not present in anything sent to the interface
