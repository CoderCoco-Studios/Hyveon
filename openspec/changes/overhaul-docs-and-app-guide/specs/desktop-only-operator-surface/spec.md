## ADDED Requirements

### Requirement: Every routed screen is reachable from the sidebar

The application sidebar SHALL provide a navigation entry for every route the renderer serves as a
top-level screen. No screen may be reachable only by typing a URL.

#### Scenario: Costs is navigable

- **WHEN** the operator opens the app and inspects the sidebar
- **THEN** a Costs entry is present and activating it navigates to `/costs`

#### Scenario: Sidebar covers the route table

- **WHEN** the top-level routes declared in `app/packages/web/src/app.component.tsx` are compared
  with the sidebar entries
- **THEN** every top-level route has a corresponding entry, ignoring detail routes reached from a
  parent screen

### Requirement: The chrome exposes no non-functional controls

The application chrome SHALL NOT render controls that cannot be actioned. Disabled navigation
placeholders for unimplemented screens and search affordances that are not wired to a handler MUST
be removed rather than shown in a dead state.

#### Scenario: Disabled nav placeholders removed

- **WHEN** the sidebar is rendered
- **THEN** no entry is present for a screen that does not exist, and no entry renders as a
  permanently disabled item

#### Scenario: Dead search box removed

- **WHEN** the top bar is rendered
- **THEN** no search input is present unless it accepts focus and performs a search

#### Scenario: Placeholder statistics removed

- **WHEN** a game card is rendered
- **THEN** it displays no statistic whose value is hardcoded and cannot reflect real data

### Requirement: Streamed IPC channels work across the context bridge

Every streaming IPC channel the renderer consumes SHALL deliver its chunks to the renderer through
the preload bridge. The preload MUST NOT return a value across `contextBridge` that cannot survive
the bridge boundary, and MUST NOT require the renderer to pass an object across the bridge whose
prototype methods the bridge drops.

#### Scenario: Streaming call does not fail at the bridge

- **WHEN** the renderer invokes a streaming channel on the exposed bridge in a production build
  with no test mode and no registered mock
- **THEN** the call returns an async-iterable value rather than throwing a serialization error,
  and iterating it yields the chunks the main process emits

#### Scenario: Live log tail renders streamed lines

- **WHEN** the operator selects a game on the logs screen and the main process emits log chunks
- **THEN** the streamed lines appear in the viewer after the initial snapshot, with no stream
  error banner

#### Scenario: Wizard terraform init completes

- **WHEN** the operator reaches the final wizard step and starts `terraform init`
- **THEN** the command actually executes, its output streams into the viewer, and the step can
  reach its success state

#### Scenario: Terraform run output renders live

- **WHEN** a plan, apply, or destroy run is started from the terraform screen
- **THEN** the run's output streams into the log viewer while the run is in progress

#### Scenario: Cancellation stops the stream

- **WHEN** the renderer abandons a stream, by navigating away or by explicitly cancelling
- **THEN** the main process tears the underlying stream down, and no error is raised in the
  renderer

#### Scenario: A test guards the real bridge boundary

- **WHEN** the test suite runs
- **THEN** at least one test drives a streaming channel end to end through the real preload bridge
  with no mock registered, so a regression at the serialization boundary fails the build

### Requirement: Navigating to logs from a game preselects that game

Activating the logs action on a game card SHALL open the logs screen with that game already
selected, without requiring the operator to reselect it.

#### Scenario: Game card logs action preselects

- **WHEN** the operator activates the logs action on the card for a given game
- **THEN** the logs screen opens with that game selected and begins tailing its log stream

#### Scenario: Direct navigation falls back

- **WHEN** the operator opens the logs screen from the sidebar with no game specified
- **THEN** the screen selects the first available game, as before
