# cost-visibility Specification

## Purpose
Defines what the app shows operators about game-server cost, and the hard
constraint that it never calls the AWS Cost Explorer API to do so. Estimates
are computed for free from each game's Fargate task-definition spec; real
billed spend is reached via a link out to the AWS Cost Explorer console,
never fetched in-app.
## Requirements
### Requirement: No AWS Cost Explorer API calls
The app SHALL NOT make any AWS Cost Explorer API request (including but not
limited to `GetCostAndUsage`) from any code path, automatic or
user-triggered. No `CloudProvider` implementation, service, controller, or
IPC channel SHALL expose a method that calls the Cost Explorer API.

#### Scenario: Navigating to the Dashboard
- **WHEN** an operator navigates to the Dashboard route (`/`)
- **THEN** no AWS Cost Explorer API request is made, on this or any
  subsequent mount

#### Scenario: Navigating to the Costs page
- **WHEN** an operator navigates to the Costs page (`/costs`)
- **THEN** no AWS Cost Explorer API request is made

#### Scenario: Repeated navigation over a session
- **WHEN** an operator navigates between the Dashboard and Costs page any
  number of times within a session
- **THEN** the cumulative count of AWS Cost Explorer API requests made by
  the app remains zero

### Requirement: Free per-game Fargate cost estimates
The app SHALL compute and display per-game cost estimates derived only from
each game's ECS task-definition CPU/memory specification (via
`DescribeTaskDefinition`, not a billed API) and static Fargate on-demand
pricing constants. These estimates SHALL be available with no dependency on
Cost Explorer data.

The same static pricing constants SHALL also drive a live hourly cost
estimate rendered inline in the add-game wizard and edit-game form's
Resources step, recomputed as the operator changes the vCPU or memory
selection, before the game server configuration is saved.

#### Scenario: Per-game estimates table renders without any actual-cost data
- **WHEN** the Costs page loads and Cost Explorer has never been called
- **THEN** the per-game estimates table still renders `$/hour`, `$/day`,
  and `$/month` figures for every configured game

#### Scenario: Live estimate updates as resources are selected
- **WHEN** an operator changes the vCPU or memory selection in the
  add-game wizard's or edit-game form's Resources step
- **THEN** the displayed hourly cost estimate updates to reflect the
  newly selected vCPU/memory pair, computed from the same static Fargate
  pricing constants used on the Costs page, with no Cost Explorer or
  other network call involved

#### Scenario: Live estimate available before the game server is saved
- **WHEN** an operator has not yet saved a new or edited game server
  configuration
- **THEN** the Resources step still shows an hourly cost estimate for the
  currently selected vCPU/memory pair

### Requirement: Dashboard KPI cost tiles use only free data
The Dashboard KPI strip SHALL show a "Current run rate" tile (the sum of
`costPerHour` across games whose current status is `running`) and an "Est.
month cap" tile (`totalPerHourIfAllOn × 24 × days in the current calendar
month`). Both values SHALL be derived entirely from the free per-game
Fargate estimate and current game run-state, with no Cost Explorer call
involved.

#### Scenario: No games running
- **WHEN** no configured game is in the `running` state
- **THEN** the "Current run rate" tile shows `$0.00`

#### Scenario: One or more games running
- **WHEN** one or more configured games are in the `running` state
- **THEN** the "Current run rate" tile shows the sum of their `costPerHour`
  estimates

### Requirement: Costs page links out to AWS Cost Explorer for real billed spend
The Costs page SHALL display a callout linking to the AWS Cost Explorer
console (a static URL to the console home, not a deep link with
query-string filters) so operators can view authoritative billed spend. The
app itself SHALL NOT render any chart, card, or figure claiming to show
actual historical billed spend.

#### Scenario: Operator wants real billed spend
- **WHEN** an operator views the Costs page and wants to know actual
  dollars billed to their AWS account
- **THEN** they see a link to the AWS Cost Explorer console and no
  in-app chart or total claiming to be actual billed spend

### Requirement: Per-game AWS resources carry a Game cost allocation tag
Every AWS resource whose cost is independently metered per game SHALL carry
a `Game` tag whose value is the game's id, in addition to the existing
`Project=hyveon` tag. Resources whose cost is shared across all games SHALL
NOT carry a `Game` tag.

#### Scenario: ECS task definition tagged per game
- **WHEN** the infra program provisions the ECS task definition for a
  configured game
- **THEN** the task definition carries a `Game` tag equal to that game's id

#### Scenario: Per-game CloudWatch log group tagged per game
- **WHEN** the infra program provisions the CloudWatch log group for a
  configured game's server
- **THEN** the log group carries a `Game` tag equal to that game's id

#### Scenario: EFS-seeder Lambda tagged per game
- **WHEN** the infra program provisions the per-game EFS-seeder Lambda
  function and its log group
- **THEN** both resources carry a `Game` tag equal to that game's id

#### Scenario: Shared resources are not tagged per game
- **WHEN** the infra program provisions a resource shared across all games
  (the ECS cluster, security groups, DynamoDB tables, the project-wide
  followup/interactions/watchdog/dns-updater Lambdas, or the EFS filesystem
  and its access points)
- **THEN** that resource does not carry a `Game` tag

### Requirement: Running ECS tasks propagate the Game tag from their task definition
Every `RunTask` call the app makes to launch a game server SHALL request tag
propagation from the task definition, so the running task — the resource
AWS meters Fargate compute cost against — carries the same `Game` tag as its
task definition. This applies to every independent code path that calls
`RunTask` to start a game server, not just one of them.

#### Scenario: Launching a game server from the desktop app
- **WHEN** the app starts a game server via `RunTask` from
  `AwsCloudProvider.startWorkload`
- **THEN** the resulting running ECS task carries a `Game` tag equal to that
  game's id, inherited from its task definition

#### Scenario: Launching a game server from the Discord `/start` command
- **WHEN** the followup Lambda starts a game server via `RunTask` in
  response to a Discord `/start` interaction
- **THEN** the resulting running ECS task carries a `Game` tag equal to that
  game's id, inherited from its task definition

