# game-environment-variables Specification

## Purpose
Lets operators declare and edit a game server's environment variables (e.g. `EULA=TRUE`) from the web UI, in both the add-game wizard and the edit-game form, without hand-editing `deployment-config.json`.
## Requirements
### Requirement: Operators can set a game's environment variables from the game form

The web UI SHALL expose `environment` (a list of `name`/`value` rows) as an
editable control in both the add-game wizard and the edit-game form. In the
add-game wizard, the control SHALL live in a dedicated "Environment" step
positioned between the Storage and Review steps. In the edit-game form, the
control SHALL live in an "Environment" section rendered alongside the
Identity/Resources/Networking/Storage sections. The list SHALL default to
empty for a new game and SHALL reflect the game's currently declared rows
when editing an existing game. The operator SHALL be able to add a new
blank row, edit a row's `name` or `value`, and remove any row, with no
minimum row count enforced.

#### Scenario: Creating a game with environment variables

- **WHEN** an operator starts the add-game wizard, reaches the Environment
  step, and adds a row with name `EULA` and value `TRUE`
- **THEN** the submitted create payload's config carries
  `environment: [{ name: "EULA", value: "TRUE" }]`

#### Scenario: Creating a game without adding any environment variables

- **WHEN** an operator completes the add-game wizard without adding any row
  to the Environment step
- **THEN** the submitted create payload's config carries no `environment`
  entries (an empty list or the field omitted)

#### Scenario: Editing a game that already has environment variables declared

- **WHEN** an operator opens the edit form for a game whose declaration
  includes `environment: [{ name: "EULA", value: "TRUE" }]`
- **THEN** the Environment section renders one row pre-filled with name
  `EULA` and value `TRUE`

#### Scenario: Adding an environment variable to an existing game

- **WHEN** an operator opens the edit form for a game with no declared
  environment variables, adds a row with name `DIFFICULTY` and value
  `hard`, and saves
- **THEN** the submitted update payload's config carries
  `environment: [{ name: "DIFFICULTY", value: "hard" }]`

#### Scenario: Removing an environment variable from an existing game

- **WHEN** an operator opens the edit form for a game with one declared
  environment variable, removes that row, and saves
- **THEN** the submitted update payload's config carries no `environment`
  entries

#### Scenario: Saving an unrelated field does not disturb declared environment variables

- **WHEN** an operator edits only the container image on a game with
  `environment: [{ name: "EULA", value: "TRUE" }]` and saves without
  touching the Environment section
- **THEN** the submitted update payload's config still carries
  `environment: [{ name: "EULA", value: "TRUE" }]`

### Requirement: Environment variable entries must have a non-empty, unique name

The shared game-server validator (`gameServerValidator.ts`) SHALL reject any
`environment[N]` row whose `name` is empty, and SHALL reject any
`environment[N]` row whose `name` duplicates another row's `name` within the
same entry. Because the validator runs on every write path (the IPC/HTTP
game-write surface as well as behind the web UI), these constraints SHALL
apply regardless of which client submitted the entry. The `value` field SHALL
be validated only for `${hyveon.*}` token correctness as defined by the
`env-token-interpolation` capability (unknown `${hyveon.*}` tokens rejected
with an issue at that row's `value` path; the ipv4 token additionally
requires the entry's `command`, and a row using that token must have a
`name` that is a valid shell identifier); all other value content SHALL
remain unconstrained, and no constraint SHALL be placed on the character
set/casing of `name` beyond non-emptiness for rows that do not use
`${hyveon.network.public-ipv4}`.

#### Scenario: Rejecting a blank environment variable name

- **WHEN** a proposed game-server entry includes an `environment` row with
  an empty `name` and any `value`
- **THEN** validation fails with an issue positioned at that row's `name`
  path, and the submitting UI (wizard or edit form) blocks submission and
  displays the issue next to the offending row

#### Scenario: Rejecting duplicate environment variable names within one entry

- **WHEN** a proposed game-server entry includes two `environment` rows
  that share the same `name`
- **THEN** validation fails with an issue identifying the duplicate, and the
  submitting UI blocks submission and displays the issue next to the
  duplicate row

#### Scenario: Accepting distinct, non-empty environment variable names

- **WHEN** a proposed game-server entry includes `environment` rows with
  distinct, non-empty names (e.g. `EULA` and `DIFFICULTY`)
- **THEN** validation for the `environment` field succeeds

#### Scenario: Rejecting an invalid token in an environment variable value

- **WHEN** a proposed game-server entry includes an `environment` row whose
  `value` contains an unknown `${hyveon.*}` token
- **THEN** validation fails with an issue positioned at that row's `value`
  path, and the submitting UI (wizard or edit form) blocks submission and
  displays the issue next to the offending row's value input

#### Scenario: Ordinary values remain unconstrained

- **WHEN** a proposed game-server entry includes an `environment` row whose
  `value` contains no `${hyveon.` sequence (including values with `${VAR}`
  shell syntax or JSON braces)
- **THEN** validation for that row's `value` succeeds

### Requirement: The environment editor surfaces the available interpolation tokens

The environment variable editor (add-game wizard Environment step and the
edit-game form's Environment section) SHALL display a hint listing the
available `${hyveon.*}` tokens and what each resolves to, so operators can
discover the interpolation feature without leaving the form. Each row's
`value` input SHALL be able to display a validation issue positioned at its
`environment[N].value` path, in the same manner `name` issues are displayed
today.

#### Scenario: Token hint visible in the environment editor

- **WHEN** an operator opens the add-game wizard's Environment step or the
  edit-game form's Environment section
- **THEN** the UI shows a hint listing `${hyveon.network.public-address}`
  and `${hyveon.network.public-ipv4}` with a short description of each

#### Scenario: Value-level issue rendered next to the offending row

- **WHEN** validation produces an issue at path `environment[1].value`
- **THEN** the second row's value input displays that issue's message

