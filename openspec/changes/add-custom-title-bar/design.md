## Context

Hyveon's desktop app (`app/packages/desktop-main` + `app/packages/web` as
the renderer, `app/packages/desktop-preload` as the IPC bridge) currently
launches a single `BrowserWindow` with Electron's default OS title bar —
including, until PR #525, a default File/Edit/View/Window application
menu that exposed no real actions. The renderer's `AppLayout` component
(`app/packages/web/src/components/app-layout.component.tsx`) already
renders a top `<header>` (brand, environment pill, Refresh button, LIVE
indicator, avatar placeholder) above every routed page.

`@hyveon/web` is not Electron-exclusive: the Playwright `chromium` e2e
project runs the same renderer bundle against a plain `vite preview`
server with no Electron process and no `window.hyveon` bridge. Any new
window-chrome behavior must degrade to today's plain header when
`window.hyveon` is absent.

The existing IPC bridge pattern (documented in
`docs/docs/components/management-app.md` and
`openspec/specs/preload-bridge-naming`) is: NestJS `@MessagePattern`
controllers under `app/packages/desktop-main/src/controllers/`, bridged
onto real `ipcMain.handle` registrations via `registerIpcMainBridges`
(`ipc-main-bridge.ts`), exposed to the renderer through a typed
`window.hyveon` object via `contextBridge` in
`app/packages/desktop-preload`. `electron-entry.ts` already demonstrates
fetching a Nest-managed service after `bootstrap()` resolves
(`nestApp.get(ElectronStoreService)` for `initUpdater`) — the same
mechanism wires the new window service to the live `BrowserWindow`.

## Goals / Non-Goals

**Goals:**
- Replace the OS-default title bar with the app's own top header acting
  as the draggable title bar, on all three desktop platforms.
- Preserve platform window-management conventions where they matter:
  native macOS traffic lights, native Windows 11 snap-layout flyout.
- Keep the renderer safe to run outside Electron (plain browser / e2e)
  with zero behavior change there.
- Follow the existing IPC bridge pattern and naming convention exactly —
  no new bridging mechanism.

**Non-Goals:**
- No app-specific menu bar content (context menus, keyboard-accelerator
  menu items) — out of scope; #525 already removed the default menu with
  nothing replacing it.
- No theming/config option to opt back into the OS-default title bar —
  this is a one-way visual change, not a user preference.
- No changes to window resizing, always-on-top, or multi-window support —
  the app has exactly one `BrowserWindow` today and this change doesn't
  alter that.

## Decisions

### D1: Merge the title bar into the existing top header, not a separate strip
- **Choice**: `AppLayout`'s existing `<header>` becomes the draggable
  title-bar region itself; window controls are appended at its trailing
  edge.
- **Rationale**: avoids a second UI row and the vertical space it costs;
  the existing header already carries branding, which is most of what a
  title bar needs.
- **Alternatives considered**: a separate ~32px strip above the header
  (Discord's approach) — cleaner separation of concerns but wastes
  vertical space in an app whose main content (dashboards, logs) already
  competes for it. Rejected.

### D2: Keep native traffic-light buttons on macOS
- **Choice**: `titleBarStyle: 'hidden'` + `trafficLightPosition: { x: 252, y: 20 }`
  on macOS; the app draws no window-control buttons there — the OS still
  draws the traffic lights, just repositioned into the custom header.
- **Rationale**: matches macOS user expectations and how most polished
  Electron apps (including Discord) handle it; avoids re-implementing
  double-click-to-zoom, hover states, and accessibility behavior the OS
  already provides for free. `trafficLightPosition` is relative to the
  whole `BrowserWindow`, whose top-left corner is the `<aside>` sidebar
  (240px wide), not the header — so the x-offset must account for the
  sidebar's width (240 + 12px inset = 252) or the traffic lights land on
  the sidebar's brand block instead of inside the header.
- **Alternatives considered**: fully custom buttons on macOS too, for
  cross-platform visual consistency — rejected as unnecessary
  platform-convention divergence and extra testing surface for no
  functional gain.

### D3: Native `titleBarOverlay` on Windows, app-drawn buttons only on Linux
- **Choice**: Windows uses Electron's `titleBarOverlay` option (native
  overlay minimize/maximize/close, including the Windows 11
  hover-to-snap flyout); Linux gets a small custom React button group
  wired to the new IPC channels.
- **Rationale**: `titleBarOverlay` is the least code for the most native
  fidelity on Windows. Linux gets app-drawn buttons here for implementation
  simplicity within this change's scope, even though Electron's
  `titleBarOverlay` has since gained Linux support — a future change could
  migrate Linux to the native overlay path, but that's out of scope here.
- **Alternatives considered**: fully custom buttons on both Windows and
  Linux for one shared code path — rejected because it forfeits the
  native Windows 11 snap-layout flyout for no benefit, and Windows is a
  primary target platform for this app.

### D4: New `WindowController`/`WindowService`, following the existing controller pattern
- **Choice**: a new NestJS `@MessagePattern` controller
  (`WindowController`) and service (`WindowService`) under
  `desktop-main`, registered in `AppModule` like every other
  controller/service pair. `WindowService` holds the live `BrowserWindow`
  reference, attached post-bootstrap via `nestApp.get(WindowService)`
  in `electron-entry.ts` — mirroring how `initUpdater` already resolves
  `ElectronStoreService` from the same Nest context after `bootstrap()`
  returns (window creation currently happens after bootstrap, so the
  window doesn't exist yet when the Nest app is built).
- **Rationale**: every other main-process → renderer capability in this
  app goes through this controller/bridge pattern, which gets IPC entry
  logging for free per `logging.md`'s invariant ("every `@MessagePattern`
  handler logs on entry"). A bespoke `ipcMain.handle` registration
  outside that pattern would be the only one in the codebase and would
  silently skip that logging invariant.
- **Alternatives considered**: raw `ipcMain.handle('window.minimize', ...)`
  calls registered directly in `electron-entry.ts`, bypassing Nest
  entirely — simpler for three one-line handlers, but breaks the
  single-pattern convention and the logging invariant. Rejected.

### D5: Channel shape — request/response methods plus one push event
- **Choice**: `window.minimize`, `window.toggleMaximize`, `window.close`,
  `window.isMaximized` (request/response), plus `window.maximizedChange`
  (main → renderer push, fired on the `BrowserWindow`'s native `maximize`
  /`unmaximize` events) so the Linux button's icon (maximize vs. restore)
  stays correct even when the state changes by a means other than
  clicking that button (double-click the header, OS-level snap/restore).
- **Rationale**: `toggleMaximize` (rather than separate `maximize`/
  `restore` calls) matches the single-button UI the Linux control group
  needs and avoids the renderer having to track state to decide which to
  call — `WindowService` asks the `BrowserWindow` itself
  (`win.isMaximized()`) and toggles accordingly.
- **Alternatives considered**: separate `maximize`/`unmaximize` channels
  mirroring the raw `BrowserWindow` API 1:1 — rejected as needless
  renderer-side state tracking for a single click target.

### D6: Preload exposes `platform` directly, no IPC round-trip
- **Choice**: `window.hyveon.window.platform` is read from
  `process.platform` inside the preload script at load time (preload runs
  in a Node context) and returned as a plain string — not fetched via
  `invoke`.
- **Rationale**: platform never changes during a session; round-tripping
  through IPC for a static value the preload process already has for free
  would be pure overhead.
- **Alternatives considered**: none seriously — this is the obvious
  choice once noted that preload already runs in Node.

### D7: Renderer feature-detects `window.hyveon?.window`
- **Choice**: `AppLayout` checks for `window.hyveon?.window` before
  rendering drag-region styling or any window-control buttons. When
  absent (plain browser tab, Playwright `chromium` e2e project), the
  header renders exactly as it does today.
- **Rationale**: keeps the renderer bundle identical between Electron and
  plain-browser contexts with a single runtime branch, rather than a
  build-time flag — matches how the rest of the codebase already
  feature-detects `window.hyveon` (e.g. existing Settings/IAC pages).
- **Alternatives considered**: a build-time `IS_ELECTRON` constant —
  rejected; the codebase has no existing precedent for build-time
  Electron/browser branching and it would need a second Vite config path
  the e2e chromium project doesn't already have.

## Risks / Trade-offs

- [Risk] `titleBarOverlay` color/height must be kept in sync with the
  app's header CSS (theme colors, height) or the native Windows buttons
  will visually clash with the custom header on either side of them. →
  Mitigation: derive the overlay color from the same CSS custom
  properties the header already uses (read via `getComputedStyle` once
  at window-creation time, or hard-code the header's fixed height/colors
  since the app doesn't support runtime theme switching yet); add a
  visual check to the manual test plan in `tasks.md`.
- [Risk] `-webkit-app-region: drag` on the header, if not scoped
  correctly, can swallow clicks intended for interactive children (nav
  toggle, Refresh, LIVE pill, avatar). → Mitigation: explicit
  `-webkit-app-region: no-drag` on every interactive child, verified by
  the existing `app-layout.component.test.tsx` suite plus a manual
  click-through pass listed in `tasks.md`.
- [Trade-off] Linux gets a visually distinct (app-drawn) button group
  while Windows/macOS get OS-native ones → accepted: this mirrors
  Electron's actual platform capabilities (no Linux
  desktop-environment-agnostic overlay API exists) rather than fighting
  them, and matches D3's rationale.
- [Trade-off] The new IPC surface is Electron-only functionality with no
  equivalent in a plain browser tab, unlike most other `window.hyveon`
  channels which back real business logic → accepted: this is
  inherent to the feature (window management only exists inside a real
  OS window) and is exactly what D7's feature-detection isolates.

## Migration Plan

N/A — this change involves no deployment changes (no AWS resources, no
Lambda, no infra program changes, no persisted data format changes). It
ships as a normal desktop-app release; a user simply sees the new title
bar the next time they launch an updated build. No rollback mechanism
beyond a normal revert PR is needed since there is no data migration to
undo.

## Open Questions

- Exact `titleBarOverlay` pixel `height` value to request on Windows —
  needs to match the rendered header height once implemented (currently
  `h-14` / 56px in the existing header's Tailwind class); confirm during
  implementation rather than guessing here.
- Whether the Linux custom button icons should reuse `lucide-react`
  (already a dependency, used throughout `AppLayout`) or need
  platform-specific glyphs — default assumption is `lucide-react`
  (`Minus`, `Square`/`Copy`, `X`) for consistency with the rest of the
  app's icon set; confirm no strong platform-convention objection during
  implementation.
