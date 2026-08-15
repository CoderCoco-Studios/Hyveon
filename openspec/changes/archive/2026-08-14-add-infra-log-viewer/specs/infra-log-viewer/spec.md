## ADDED Requirements

### Requirement: Lambda log group resolution
The system SHALL resolve the CloudWatch log group for any of the app's 5 Lambda
functions as `/aws/lambda/${projectName}-${functionKey}`, where `projectName` comes
from the active `DeploymentConfig` (defaulting to `'hyveon'` when unset) and
`functionKey` is one of `watchdog`, `health-check`, `dns-updater`, `interactions`, or
`followup`.

#### Scenario: Default project name
- **WHEN** `DeploymentConfig.projectName` is unset
- **THEN** the resolved log group for `functionKey: 'watchdog'` MUST be
  `/aws/lambda/hyveon-watchdog`

#### Scenario: Custom project name
- **WHEN** `DeploymentConfig.projectName` is `'acme'`
- **THEN** the resolved log group for `functionKey: 'health-check'` MUST be
  `/aws/lambda/acme-health-check`

### Requirement: Recent Lambda logs fetch
The system SHALL provide a way to fetch up to a caller-specified number of the most
recent log lines for a given Lambda `functionKey`, reading from that function's most
recently written CloudWatch log stream.

#### Scenario: Log group has recent activity
- **WHEN** the caller requests recent logs for `functionKey: 'watchdog'` with `limit: 50`
- **THEN** the system SHALL return up to 50 messages from the most recently written log
  stream in `/aws/lambda/${projectName}-watchdog`, ordered oldest-first

#### Scenario: Log group has no streams yet
- **WHEN** the caller requests recent logs for a `functionKey` whose log group has never
  received a log event
- **THEN** the system SHALL return a single informational message rather than throwing
  or returning an empty array

#### Scenario: CloudWatch request fails
- **WHEN** the underlying CloudWatch Logs API call fails (e.g. permissions, network)
- **THEN** the system SHALL return a single message describing the failure rather than
  propagating a raw SDK error, and SHALL log the failure via `logger.error` with the
  `functionKey` and log group as non-secret identifiers

### Requirement: Live Lambda log tail
The system SHALL provide a way to stream newly-arriving log lines for a given Lambda
`functionKey`, polling at a caller-specified interval (default 2000ms), until the
caller's `AbortSignal` is aborted.

#### Scenario: New log events arrive during polling
- **WHEN** a consumer starts streaming logs for `functionKey: 'dns-updater'` and a new
  log event is written to that function's log group during polling
- **THEN** the stream SHALL yield the new event's message without duplicating messages
  already yielded

#### Scenario: Consumer aborts the stream
- **WHEN** the caller's `AbortSignal` is aborted while a stream is active
- **THEN** the stream SHALL exit cleanly (no unhandled rejection, no further polling)

### Requirement: Infrastructure logs page
The system SHALL provide a routed page at `/logs/infrastructure` that lets an operator
select one of the 5 Lambda `functionKey` values from a picker and view that function's
live-tailed logs, reusing the same live-tail UI component used by the existing
game-server logs page.

#### Scenario: Operator selects a function
- **WHEN** an operator navigating `/logs/infrastructure` selects `health-check` from the
  function picker
- **THEN** the page SHALL display that function's recent logs and begin live-tailing new
  ones

#### Scenario: Operator switches functions
- **WHEN** an operator changes the picker selection from one function to another
- **THEN** the page SHALL stop tailing the previous function's logs and start tailing
  the newly selected function's logs

### Requirement: Nested Logs sidebar navigation
The system SHALL present the sidebar's `Logs` entry as a group with two always-visible
child links: `Game Logs` (routing to `/logs`) and `Infra Logs` (routing to
`/logs/infrastructure`), nested under the existing `Monitoring` section. Child labels
MUST NOT collide with the accessible name of any other sidebar link (the Configuration
section already has top-level `Games` and `Infrastructure` links routing elsewhere).

#### Scenario: Operator views the sidebar
- **WHEN** an operator views the Monitoring section of the sidebar
- **THEN** they SHALL see a `Logs` group containing two child links, `Game Logs` and
  `Infra Logs`, both visible without any expand/collapse interaction

#### Scenario: Active-route highlighting on a child route
- **WHEN** an operator is on `/logs/infrastructure`
- **THEN** the `Infra Logs` child link SHALL be visually marked as active, and the
  `Game Logs` child link SHALL NOT be marked as active
