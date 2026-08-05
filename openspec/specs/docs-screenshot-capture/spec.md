# docs-screenshot-capture

## Purpose

Defines how the screenshots embedded in the documentation site are produced: an on-demand Playwright harness that launches the real Electron shell, seeds every screen with deterministic demo data through the IPC contracts, freezes the sources of visual non-determinism, and writes committed PNGs into the Docusaurus static tree. The harness is isolated from the e2e test run, and its refresh procedure is documented for maintainers.

## Requirements

### Requirement: Screenshots are captured from the real Electron shell

The screenshot harness SHALL capture images from the real Electron application, launched via
`_electron.launch()` against the built main entry point at `out/main/index.js` (produced by
`desktop:build`) with `HYVEON_TEST_MODE=1`, so the images show the real desktop window and the real
preload bridge. The harness MUST NOT capture from a browser tab
rendering of the renderer.

#### Scenario: Harness launches Electron

- **WHEN** the screenshot harness runs
- **THEN** it launches the Electron main entry point and captures from its first window

#### Scenario: Window geometry is fixed

- **WHEN** the harness captures any screen
- **THEN** the window content size is set explicitly before capture so every image shares the same
  dimensions regardless of the host window manager

### Requirement: The harness is isolated from the e2e test run

The screenshot harness SHALL live under its own Playwright config and its own test directory, so
that `npm run app:test:e2e` and the CI e2e job do not execute it.

#### Scenario: e2e run excludes the harness

- **WHEN** `npm run app:test:e2e` is run
- **THEN** no screenshot capture test executes and no file under `docs/static/img/app/` is written

#### Scenario: Harness runs on demand

- **WHEN** a maintainer runs the documented screenshot command
- **THEN** the harness executes and writes PNGs to `docs/static/img/app/`

### Requirement: Captured screens are seeded with deterministic demo data

The harness SHALL seed every IPC channel each captured screen depends on, using a dedicated demo
fixture set, so that no screen renders an empty state, a loading spinner, or an error banner
unless that state is the subject of the screenshot. Seeded data MUST use the real contract shapes,
including `games.list` returning `GameListEntry[]` rather than a string array.

#### Scenario: No unintended empty states

- **WHEN** a screen is captured for its populated view
- **THEN** the image shows populated content, not a loading, empty, or error placeholder

#### Scenario: Channels beyond the shared stub helper are seeded

- **WHEN** the harness captures the games, audit, logs, iac, dashboard, and settings screens
- **THEN** it seeds `games.list`, `drift.get`, `audit.list`, `logs.get`, `logs.stream`, the
  `iac.*` channels, and the `diagnostics.*` channels in addition to the channels the shared
  Electron stub helper already covers

#### Scenario: Contract shapes are honoured

- **WHEN** the demo fixtures are type-checked against the shared contract types
- **THEN** they compile without casts that bypass the declared shapes

### Requirement: Re-running the harness produces stable images

The harness SHALL eliminate sources of non-determinism so that re-running it without a UI change
produces byte-identical or visually identical images. Time-dependent rendering MUST be pinned to a
fixed clock, and animations and transitions MUST be disabled at capture time.

#### Scenario: Clock is frozen

- **WHEN** a screen that renders relative timestamps or a polling countdown is captured
- **THEN** the rendered time values are identical across runs

#### Scenario: Animations are disabled

- **WHEN** any screen is captured
- **THEN** transitions and animations are disabled so no image catches a mid-animation frame

#### Scenario: Repeat run is stable

- **WHEN** the harness is run twice in a row with no code change in between
- **THEN** the second run produces no visual difference from the first

### Requirement: Output location is the Docusaurus static tree

Captured images SHALL be written to `docs/static/img/app/` and committed, so the docs site serves
them without a build step and so the images are reviewable in a pull request.

#### Scenario: Images land in static

- **WHEN** the harness completes
- **THEN** every produced PNG is under `docs/static/img/app/` and none is under a gitignored
  Playwright output directory

### Requirement: The capture procedure is documented for maintainers

The maintainer guide SHALL document how to refresh screenshots: the prerequisite build step, the
command to run, the display requirement on Linux, and when a refresh is expected.

#### Scenario: Maintainer guide covers refresh

- **WHEN** `docs/docs/guides/maintainer.md` is read
- **THEN** it states the build-then-capture command sequence, notes that Linux requires a display
  or `xvfb-run`, and states that screenshots should be refreshed when a documented screen changes
