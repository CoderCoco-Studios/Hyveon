## ADDED Requirements

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

#### Scenario: Windows uses the native title bar overlay
- **WHEN** the app runs on Windows
- **THEN** the `BrowserWindow` SHALL be created with a `titleBarOverlay`
  configuration whose colors match the app header, and the app SHALL NOT
  render its own minimize/maximize/close buttons — the OS-drawn overlay
  buttons are used, including the native snap-layout flyout on
  maximize-hover

#### Scenario: Linux renders app-drawn window controls
- **WHEN** the app runs on Linux
- **THEN** the app SHALL render its own minimize, maximize/restore, and
  close buttons in the header, styled to match the app's theme, since no
  native overlay mechanism exists on Linux

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

### Requirement: Window-control IPC channels
The desktop app SHALL expose IPC channels for minimizing, toggling
maximize/restore, closing the main window, querying its maximized state,
and observing maximized-state changes, following the existing
`<namespace>.<action>` channel-naming convention.

#### Scenario: Minimize channel minimizes the window
- **WHEN** the renderer invokes the `window.minimize` channel
- **THEN** the main `BrowserWindow` SHALL be minimized

#### Scenario: Toggle-maximize channel maximizes an unmaximized window
- **WHEN** the renderer invokes the `window.toggleMaximize` channel and
  the main `BrowserWindow` is not currently maximized
- **THEN** the window SHALL become maximized

#### Scenario: Toggle-maximize channel restores a maximized window
- **WHEN** the renderer invokes the `window.toggleMaximize` channel and
  the main `BrowserWindow` is currently maximized
- **THEN** the window SHALL be restored to its previous (unmaximized) size
  and position

#### Scenario: Close channel closes the window
- **WHEN** the renderer invokes the `window.close` channel
- **THEN** the main `BrowserWindow` SHALL be closed

#### Scenario: Maximized-state query reflects current state
- **WHEN** the renderer invokes the `window.isMaximized` channel
- **THEN** the response SHALL reflect the main `BrowserWindow`'s actual
  current maximized state

#### Scenario: Maximized-state change is pushed to the renderer
- **WHEN** the main `BrowserWindow`'s maximized state changes for any
  reason (a `window.toggleMaximize` call, a double-click on the draggable
  header, or an OS-level action such as snapping to a screen edge)
- **THEN** the main process SHALL push a `window.maximizedChange` event to
  the renderer carrying the new maximized state

### Requirement: Preload exposes window platform and controls
The preload bridge SHALL expose a `window.hyveon.window` namespace giving
the renderer the current OS platform and typed access to the
window-control IPC channels.

#### Scenario: Platform is available without an IPC round-trip
- **WHEN** the renderer reads `window.hyveon.window.platform`
- **THEN** it SHALL receive the current OS platform identifier without
  triggering an IPC call to the main process

#### Scenario: Window-control methods are available to the renderer
- **WHEN** the renderer calls `window.hyveon.window.minimize()`,
  `window.hyveon.window.toggleMaximize()`,
  `window.hyveon.window.close()`, or `window.hyveon.window.isMaximized()`
- **THEN** each call SHALL invoke the corresponding IPC channel and
  resolve with its result

#### Scenario: Maximized-state changes can be observed by the renderer
- **WHEN** the renderer subscribes via
  `window.hyveon.window.onMaximizedChange(callback)`
- **THEN** the callback SHALL be invoked whenever the main process pushes
  a `window.maximizedChange` event
