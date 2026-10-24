# game-environment-variables Delta Specification

## MODIFIED Requirements

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

## ADDED Requirements

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
