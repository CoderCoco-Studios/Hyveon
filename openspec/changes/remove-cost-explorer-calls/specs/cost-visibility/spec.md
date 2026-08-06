## ADDED Requirements

### Requirement: No AWS Cost Explorer API calls
The app SHALL NOT make any AWS Cost Explorer API request (including but not
limited to `GetCostAndUsage`) from any code path, automatic or
user-triggered. No `CloudProvider` implementation, service, controller, or
IPC channel SHALL expose a method that calls the Cost Explorer API.

#### Scenario: Navigating to the Dashboard
- **WHEN** an operator navigates to the Dashboard route (`/`)
- **THEN** no AWS Cost Explorer API request is made, on this or any
  subsequent mount

#### Scenario: Navigating to or interacting with the Costs page
- **WHEN** an operator navigates to the Costs page (`/costs`) or toggles
  the 7d/30d range selector
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

#### Scenario: Per-game estimates table renders without any actual-cost data
- **WHEN** the Costs page loads and Cost Explorer has never been called
- **THEN** the per-game estimates table still renders `$/hour`, `$/day`,
  and `$/month` figures for every configured game

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
