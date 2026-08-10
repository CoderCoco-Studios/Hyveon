## MODIFIED Requirements

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
