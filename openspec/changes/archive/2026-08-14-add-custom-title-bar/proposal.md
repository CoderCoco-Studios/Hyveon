## Why

Electron's default title bar shows a File/Edit/View/Window application menu
that exposes no actions this app uses — already removed in a separate PR
(#525). The OS-default title bar chrome itself (plain title text, generic
window buttons) still looks bolted-on rather than part of the app, unlike
comparable desktop tools (e.g. Discord) that draw their own. A custom title
bar, merged into the existing top header, makes the app read as a cohesive
single-purpose console rather than a generic windowed webpage.

## What Changes

**Window chrome**
- From: Electron's OS-default title bar (native buttons, no custom
  content) sits above the app's own top header.
- To: `BrowserWindow` is created with `titleBarStyle: 'hidden'` and the
  existing top header (`app-layout.component.tsx`) becomes the draggable
  title bar itself — brand, env pill, Refresh, LIVE indicator stay, with
  window controls added at the trailing edge.
- Reason: matches the brainstormed design; avoids a second UI row.
- Impact: non-breaking, visual/UX only. macOS keeps native traffic-light
  buttons (repositioned via `trafficLightPosition`); Windows uses native
  `titleBarOverlay` buttons; Linux gets app-drawn buttons since neither
  overlay mechanism exists there.

**New IPC surface**
- From: no window-control channels exist.
- To: a new `WindowController`/`WindowService` pair (desktop-main) exposes
  `window.minimize`, `window.toggleMaximize`, `window.close`,
  `window.isMaximized`, and a `window.maximizedChange` push event, bridged
  through the existing `@MessagePattern`/`registerIpcMainBridges` pattern
  and a new `window.hyveon.window` preload namespace.
- Reason: the renderer needs a way to drive the real `BrowserWindow` from
  the custom-drawn Linux buttons (and to reflect maximize/restore state
  everywhere).
- Impact: non-breaking addition. Only used where `window.hyveon.window` is
  present (real Electron renderer) — the Playwright `chromium` e2e project
  (plain `vite preview`, no Electron) is unaffected and keeps rendering the
  header as it does today.

## Capabilities

### New Capabilities
- `custom-title-bar`: Electron `BrowserWindow` chrome configuration
  (macOS/Windows/Linux) merged into the app's own top header, plus the
  window-control IPC surface (`WindowController`/`WindowService`, preload
  `window.hyveon.window` namespace) that drives it.

### Modified Capabilities

(none — `desktop-only-operator-surface` and `preload-bridge-naming` are
followed, not changed: the new channels use the existing IPC-only,
no-HTTP-transport pattern and the established `<namespace>.<action>`
naming convention.)

## Impact

- `app/packages/desktop-main/src/electron-entry.ts` — platform-conditional
  `BrowserWindow` options; wires the new `WindowService` to the created
  window post-bootstrap (same pattern as `initUpdater`/
  `ElectronStoreService` today).
- `app/packages/desktop-main/src/controllers/` — new `WindowController`.
- `app/packages/desktop-main/src/services/` — new `WindowService`.
- `app/packages/desktop-preload/src/hyveon-api.ts`,
  `app/packages/desktop-preload/src/preload.ts`,
  `app/packages/desktop-preload/src/index.ts` — new `window` namespace.
- `app/packages/web/src/components/app-layout.component.tsx` — drag
  region, platform-conditional control rendering.
- Docs: `docs/docs/components/management-app.md` (IPC channel table),
  `docs/docs/app/*` if a screenshot/description of the top bar needs
  updating.
- No changes to `@hyveon/shared`, infra, or Lambda packages.
