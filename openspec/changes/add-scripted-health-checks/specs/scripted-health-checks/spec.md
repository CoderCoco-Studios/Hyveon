## Purpose

Defines the operator-authored health-check kind: what a script is given, what it must return,
the isolation boundary and resource limits it runs within, and the authoring and audit
surface around it — so that an operator can support a game this project has never heard of
without that ability becoming a way to run arbitrary code against the deployment's own AWS
credentials and network.

## ADDED Requirements

### Requirement: A script determines the verdict for the game that declares it

A health-check declaration SHALL support a kind whose verdict is computed by
operator-authored source rather than by a fixed request-and-compare rule.

The declaration SHALL carry the source, the port the script is permitted to reach, an
optional reference to a credential in the platform's secret store, and an execution timeout.

The script SHALL be given the game name, the address of the task being checked, the
credential value when one is referenced, and a capability for issuing requests. It SHALL
return the same verdict shape every other kind returns: whether the server is active, and a
human-readable reason.

The request capability's response exposes the response status code, a header map limited to
the headers the game task actually returned (no host-added headers), and the body — as a
UTF-8 string when the response's declared content type is textual or JSON, or as base64
otherwise. Both the outbound request body the script supplies and the inbound response body
the capability returns SHALL be subject to a fixed byte-size limit enforced by the host
before either crosses the sandbox boundary: an oversized outbound body SHALL be rejected
before it is sent, and an oversized inbound response SHALL be truncated before it reaches the
script. These limits apply independently of, and in addition to, the guest's own memory
ceiling.

#### Scenario: A script reports the server active

- **WHEN** a script executes to completion and returns a verdict indicating activity
- **THEN** the server is treated as active, exactly as an equivalent declarative verdict
  would be

#### Scenario: A script reports the server idle

- **WHEN** a script executes to completion and returns a verdict indicating no activity
- **THEN** the server is treated as idle and the consecutive-idle count advances

### Requirement: A script executes without access to the host's authority

Operator-authored source SHALL execute in an isolated interpreter that does not share
execution context with the component hosting it.

A script SHALL NOT be able to read the host's environment variables, obtain or use the
host's execution-role credentials, read or write any filesystem, load code or modules the
host has not explicitly provided, reach the platform's instance-metadata endpoint, or reach
any network destination other than the game task being checked on the port its declaration
names.

The only means by which a script may cause an outbound request SHALL be the capability the
host provides, and that capability SHALL be responsible for the destination. A destination
supplied by the script SHALL NOT be used.

Isolation SHALL be enforced by the host, not by inspecting or restricting the source before
it runs. Rejecting recognisably dangerous source is not a substitute for an execution
boundary.

#### Scenario: A script attempts to reach another host

- **WHEN** a script requests a destination other than the task being checked
- **THEN** no such request is issued
- **AND** the check fails, yielding an active verdict whose reason identifies the attempt

#### Scenario: A script attempts to read host state

- **WHEN** a script attempts to read the host's environment, credentials, or filesystem
- **THEN** the attempt does not succeed
- **AND** nothing about the host's environment, credentials, or filesystem is observable in
  the script's result or in the reason returned to the operator

#### Scenario: A credential is referenced

- **WHEN** a declaration references a credential
- **THEN** the script receives only that credential's value
- **AND** it receives no other secret the deployment holds

### Requirement: Script execution is bounded by limits the host enforces

The host SHALL bound each script execution by wall-clock duration, by memory, and by the
number of outbound requests it may cause. Each limit SHALL be enforced by the host and SHALL
NOT depend on the script's cooperation.

Exceeding any limit SHALL terminate the execution.

A script SHALL NOT be able to affect the execution of a check for any other game, whether by
exhausting a limit, by leaving state behind, or by failing to terminate.

When an execution is terminated for any reason — timeout, memory ceiling, or the
outbound-request cap — any in-flight HTTP request or other host-side operation the script
initiated SHALL be cancelled and its handle released immediately, rather than left running in
the background. A terminated script's own failure SHALL NOT leave work behind that continues
consuming the warm Lambda execution environment after that execution has ended.

#### Scenario: A script does not terminate

- **WHEN** a script runs past its declared timeout
- **THEN** its execution is terminated by the host
- **AND** the check yields an active verdict whose reason identifies the timeout

#### Scenario: A script exhausts memory

- **WHEN** a script allocates beyond the memory ceiling
- **THEN** its execution is terminated
- **AND** checks for other games in the same evaluation still produce verdicts

#### Scenario: A script issues excessive requests

- **WHEN** a script causes more outbound requests than the limit allows
- **THEN** further requests are refused and the execution is terminated

### Requirement: A script that fails reports the server as active

Every failure of a scripted check SHALL yield an active verdict, consistent with the failure
semantics of every other kind. This SHALL include, at minimum: source that cannot be
evaluated, a script that raises an error, a script that exceeds any limit, a script that
returns a value that is not a valid verdict, and a script that returns nothing.

The reason SHALL distinguish the failure from a genuine activity verdict, and SHALL be
specific enough for the operator to correct the script.

#### Scenario: A script raises an error

- **WHEN** a script raises during execution
- **THEN** the verdict is active
- **AND** the reason identifies the failure and its location in the script

#### Scenario: A script returns an unusable value

- **WHEN** a script returns a value that is not a valid verdict, or returns nothing
- **THEN** the verdict is active
- **AND** the reason states that the script did not produce a verdict

### Requirement: Authoring a script is an explicit, recorded act

The operator interface SHALL present script authoring together with a statement of what a
script can and cannot do, so that enabling it is an informed choice rather than an
incidental one.

Creating or modifying a script SHALL be recorded in the deployment's audit trail with the
game affected and the time, because a script is code that will execute against the
deployment's own network on a schedule.

The interface SHALL indicate whether a credential is configured without exposing its value,
consistent with every other secret the system holds.

#### Scenario: An operator writes a script

- **WHEN** an operator saves a game whose health check declares a script
- **THEN** the change appears in the audit trail identifying the game and the time

#### Scenario: An operator views a script with a credential

- **WHEN** an operator opens a game whose script references a credential
- **THEN** the interface shows that a credential is set
- **AND** the credential value is not present in anything sent to the interface

### Requirement: A script's output does not leak into the deployment's records

A script's return value, the responses it receives, and any diagnostic output it produces
SHALL NOT be recorded verbatim. Only the derived verdict and a bounded reason SHALL be
recorded.

Because a script can observe both its own credential and the game task's response — which may
carry player identities or addresses — the reason SHALL be sanitized before it is recorded,
not merely truncated: the host SHALL redact substrings that match secret-like patterns (for
example, the resolved credential value itself, or common token/key shapes) before the reason
is written to the log, so a script cannot use the reason field to exfiltrate a value it was
given.

The reason recorded SHALL also be truncated to a bounded length, so that a script cannot use
it to write unbounded operator-controlled content into the deployment's logs.

#### Scenario: A script returns a long reason

- **WHEN** a script returns a reason exceeding the bound
- **THEN** the recorded reason is truncated to the bound

#### Scenario: A script's reason echoes its own credential

- **WHEN** a script returns a reason containing the credential value it was given
- **THEN** the recorded reason has that value redacted before it is written to the log

#### Scenario: A script receives a game response containing player data

- **WHEN** a script issues a request whose response contains player identities or addresses
- **THEN** that response is not recorded
