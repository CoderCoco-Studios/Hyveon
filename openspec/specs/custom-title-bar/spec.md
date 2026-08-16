# custom-title-bar Specification

## Purpose
TBD - created by archiving change add-custom-title-bar. Update Purpose after archive.
## Requirements
### Requirement: Window chrome uses the app's own header, not the OS default
The Electron `BrowserWindow` SHALL be created with its native OS title bar
hidden, and the app's existing top header SHALL act as the draggable title
bar in its place.

#### Scenario: App window opens with no OS title bar
- **WHEN** the desktop app launches and its main `BrowserWindow` is created
- **THEN** the window SHALL be created with `titleBarStyle: 'hidden'`, so
  no separate OS-drawn title bar row appears above the app's own header

#### Scenario: The app header is draggable
- **WHEN** the app is running inside Electron and the operator presses and
  drags on an empty area of the top header
- **THEN** the operating system SHALL move the window, as if dragging a
  native title bar

#### Scenario: Interactive header controls remain clickable
- **WHEN** the app is running inside Electron and the operator clicks the
  mobile nav toggle, the Refresh button, the LIVE indicator, or the avatar
  placeholder in the top header
- **THEN** the click SHALL be handled by that control and SHALL NOT be
  captured as a window-drag gesture

### Requirement: Platform-appropriate window controls
Window minimize/maximize/close controls SHALL follow each desktop
platform's native convention rather than a single cross-platform design.

#### Scenario: macOS keeps native traffic-light buttons
- **WHEN** the app runs on macOS
- **THEN** the `BrowserWindow` SHALL be created with a `trafficLightPosition`
  aligned to the custom header, and the app SHALL NOT render its own
  minimize/maximize/close buttons — the OS-drawn traffic lights are used

#### Scenario: Windows and Linux use the native title bar overlay
- **WHEN** the app runs on Windows or Linux
- **THEN** the `BrowserWindow` SHALL be created with a `titleBarOverlay`
  configuration whose colors match the app header, and the app SHALL NOT
  render its own minimize/maximize/close buttons — the OS-drawn overlay
  buttons are used, including the native snap-layout flyout on
  maximize-hover on Windows

### Requirement: Renderer degrades safely outside Electron
Window-chrome behavior (drag region, platform-specific controls) SHALL
only activate when a real Electron window-control bridge is present, so
the same renderer bundle continues to work unmodified in a plain browser
context.

#### Scenario: Plain browser tab renders the unmodified header
- **WHEN** the renderer runs outside Electron (no `window.hyveon.window`
  bridge available, e.g. the Playwright `chromium` e2e project against a
  plain `vite preview` server)
- **THEN** the top header SHALL render exactly as it does today, with no
  drag-region styling and no window-control buttons

### Requirement: Preload exposes window platform
The preload bridge SHALL expose a `window.hyveon.window` namespace giving
the renderer the current OS platform, with no IPC round-trip. Every
platform's window-control buttons (macOS traffic lights, and the Windows/
Linux native `titleBarOverlay`) are drawn by the OS/Electron directly, so
there is no app-drawn control surface for the renderer to invoke or
observe changes on.

#### Scenario: Platform is available without an IPC round-trip
- **WHEN** the renderer reads `window.hyveon.window.platform`
- **THEN** it SHALL receive the current OS platform identifier without
  triggering an IPC call to the main process

