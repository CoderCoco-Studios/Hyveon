## Purpose

Gives operators network-layer visibility into accepted and rejected traffic through the Hyveon VPC, surfaced from inside the app, so a server that is reachable on one path but not another can be diagnosed without leaving the app or touching the AWS console directly.

## ADDED Requirements

### Requirement: VPC Flow Log resource provisioning
The infrastructure program SHALL provision an `aws.ec2.FlowLog` scoped to the Hyveon VPC, capturing `ALL` traffic (both `ACCEPT` and `REJECT`), publishing to a dedicated CloudWatch Logs log group, when the operator's `DeploymentConfig` has flow logs enabled.

#### Scenario: Flow log enabled by default
- **WHEN** a fresh `DeploymentConfig` has no explicit flow-log setting
- **THEN** a preview reports a Flow Log resource for the VPC

#### Scenario: Flow log disabled by operator
- **WHEN** the operator sets the flow-log toggle to disabled and runs a preview
- **THEN** the preview reports no Flow Log resource, or reports deletion of an existing one, and no other VPC/game resources change

#### Scenario: Flow log captures both directions
- **WHEN** the Flow Log resource is provisioned
- **THEN** its traffic type is `ALL`, not `ACCEPT`-only or `REJECT`-only

### Requirement: Scoped IAM role for flow log delivery
The infrastructure program SHALL provision an IAM role permitting the VPC Flow Logs service to publish to the flow-log log group, with permissions scoped to that single log group's ARN and no broader CloudWatch Logs access.

#### Scenario: Role is scoped to one log group
- **WHEN** the flow-log IAM role's policy is inspected
- **THEN** its resource scope is exactly the flow-log log group's ARN, not a wildcard across log groups

### Requirement: Flow-log enable/disable configuration
`DeploymentConfig` SHALL expose a boolean setting controlling whether the VPC Flow Log resource is provisioned, defaulting to enabled.

#### Scenario: Default value
- **WHEN** `DeploymentConfig`'s flow-log setting is unset
- **THEN** the resolved value is `true` (enabled)

### Requirement: Recent flow log record fetch
The system SHALL provide a way to fetch up to a caller-specified number of the most recent flow log records from the flow-log log group, reading from the group's most recently written log stream, mirroring the existing recent-log-fetch contract for game and Lambda logs.

#### Scenario: Flow log group has recent activity
- **WHEN** the caller requests recent flow log records with a limit of 50
- **THEN** the system returns up to 50 records from the most recently written log stream in the flow-log log group, ordered oldest-first

#### Scenario: Flow log group has no streams yet
- **WHEN** the caller requests recent flow log records and the log group has never received a record
- **THEN** the system returns a single informational message rather than throwing or returning an empty array

#### Scenario: CloudWatch request fails
- **WHEN** the underlying CloudWatch Logs API call fails
- **THEN** the system returns a single message describing the failure rather than propagating a raw SDK error, and logs the failure with the log group as a non-secret identifier

### Requirement: Older and newer flow log record paging
The system SHALL provide a way to page backward (older) and forward (newer) through flow log records across every log stream in the flow-log log group, from a caller-supplied timestamp boundary, mirroring the existing multi-stream paging contract for game and Lambda logs.

#### Scenario: Paging backward past a restart boundary
- **WHEN** the caller requests flow log records older than a given timestamp
- **THEN** the system scans every log stream in the flow-log log group (not only the newest) for records older than that timestamp

#### Scenario: Paging forward without duplicates
- **WHEN** the caller requests flow log records newer than a given timestamp, excluding a set of already-delivered record identities
- **THEN** the system returns only records strictly newer than that timestamp, with previously-delivered records excluded from the result

### Requirement: Live flow log record tail
The system SHALL provide a way to stream newly-arriving flow log records for the flow-log log group as they are written, mirroring the existing live-tail contract for game and Lambda logs.

#### Scenario: New records arrive during an active tail
- **WHEN** a caller is tailing the flow-log log group and a new record is written
- **THEN** the new record is yielded to the caller without requiring a new fetch call

#### Scenario: Tail stops cleanly on cancellation
- **WHEN** the caller's abort signal is triggered during an active tail
- **THEN** the tail stream ends without yielding further records

### Requirement: Reject-only filtering in the operator UI
The Infrastructure/Logs UI surface SHALL let the operator filter fetched flow log records to only those with a `REJECT` action, in addition to viewing the unfiltered record stream.

#### Scenario: Operator filters to rejected traffic
- **WHEN** the operator enables the "rejected only" filter on the flow-log view
- **THEN** only records whose action field is `REJECT` are displayed
