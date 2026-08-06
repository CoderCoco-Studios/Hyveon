# guided-region-selection Specification

## Purpose

Defines the guided-IAM first-run wizard step's AWS region selection: a
continent-grouped dropdown of AWS regions with human-readable location
labels, backed by a build-time-generated static data set (`@hyveon/shared`'s
`AWS_REGIONS`), with a manual-entry fallback so a region absent from that
data set never blocks setup.

## Requirements

### Requirement: Static AWS region data set

The repository SHALL provide a committed, generated data file
(`app/packages/shared/src/awsRegions.ts`, exported from
`@hyveon/shared`) listing commercial-partition AWS regions as
`{ code, name, continent }` entries, produced by a manually-triggered
generator script and npm command rather than fetched at application
runtime. The data set MUST exclude GovCloud and China regions by region-code
prefix (`us-gov-`, `cn-`), and MUST otherwise include every entry AWS's
published region-location feed itself classifies with `type: "AWS Region"`.

#### Scenario: Data set is available without network access

- **WHEN** the desktop app runs with no network connectivity
- **THEN** `AWS_REGIONS` is still populated from the committed file, with
  no attempt to fetch region data over the network

#### Scenario: Regenerating the data set

- **WHEN** a developer runs the region-data generator npm command
- **THEN** `app/packages/shared/src/awsRegions.ts` is rewritten from AWS's
  published region-location data, sorted by continent then region name

### Requirement: Guided-IAM region selection dropdown

The guided-IAM wizard step's region screen SHALL present the entries in
`AWS_REGIONS` as a dropdown grouped by continent, each item labeled
`"{name} — {code}"`, sorted alphabetically by name within each continent
group. Selecting an item SHALL set the step's local `region` state to that
entry's `code`. The step's existing local validation (`handleChooseGuided`
rejects an empty region with an inline error instead of advancing) and its
`region` state shape MUST remain unchanged, since the same value continues
to flow into this step's own IPC calls unmodified.

#### Scenario: Selecting a region from the dropdown

- **WHEN** the operator opens the guided-IAM region screen and selects
  "US East (N. Virginia) — us-east-1"
- **THEN** the step's region state becomes `"us-east-1"` and clicking
  "Continue with guided setup" advances to the template screen

#### Scenario: Regions are grouped by continent

- **WHEN** the guided-IAM region screen renders
- **THEN** dropdown items are organized into continent-labeled groups,
  alphabetical by region name within each group

### Requirement: Manual region entry fallback

The guided-IAM region dropdown SHALL include a final, ungrouped
`"Other (enter manually)"` item. Selecting it SHALL replace the dropdown
with a free-text input (pre-focused), matching the field's behavior prior
to this change — an operator MUST be able to enter any region code, not
only one present in the static data set, so a region missing from
`AWS_REGIONS` never blocks setup.

#### Scenario: Entering a region absent from the static list

- **WHEN** the operator selects "Other (enter manually)" and types a
  region code not present in `AWS_REGIONS`
- **THEN** the typed value becomes the step's region state and clicking
  "Continue with guided setup" advances normally once it is non-empty,
  identical to today's free-text behavior

#### Scenario: Static data set is stale

- **WHEN** AWS has launched a region newer than the last time the region
  data set was regenerated
- **THEN** the operator can still select that region via
  "Other (enter manually)" without being blocked
