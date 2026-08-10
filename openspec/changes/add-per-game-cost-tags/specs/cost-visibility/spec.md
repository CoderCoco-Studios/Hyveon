## ADDED Requirements

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
task definition.

#### Scenario: Launching a game server
- **WHEN** the app starts a game server via `RunTask`
- **THEN** the resulting running ECS task carries a `Game` tag equal to that
  game's id, inherited from its task definition
