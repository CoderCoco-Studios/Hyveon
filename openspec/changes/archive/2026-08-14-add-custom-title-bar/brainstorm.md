<!--
Raw capture of superpowers:brainstorming output.

This file captures the brainstorming skill's output as-is, without enforcing
structure. The skill's natural output is usually a decision-log format
(context → decision chain Q1-Qn → design trade-offs), but the actual
organization may vary depending on the conversation.

design.md extracts from this file and reorganizes it into a structured
design document.

Do not copy this file's content into design.md — design.md is an
independently reorganized artifact; the two are complementary, not
overlapping.
-->

## Background

Follow-up to a bounded fix (PR #525) that removed Electron's default
File/Edit/View/Window application menu via `Menu.setApplicationMenu(null)`
— that menu exposed no actions the app uses. The user then asked whether
Hyveon could draw its own title bar instead of relying on the OS default,
similar to Discord's title bar (app icon + title + window controls merged
into the app's own chrome, screenshot referenced during the conversation).

## Classification

Classified as **bounded** during brainstorming (a well-scoped change to an
existing flow — `BrowserWindow` creation in `electron-entry.ts`, the
existing preload/IPC bridge pattern) rather than architectural. Routed
through `/opsx:propose` afterward per this repo's
`spec-driven-development.md` routing rule: new capability + new IPC
surface + cross-platform window-chrome change → opsx, not a direct PR,
regardless of the brainstorming-path classification.

## Context explored before questions

- `app/packages/desktop-main/src/electron-entry.ts` creates the single
  `BrowserWindow` with `webPreferences: { preload, contextIsolation: true,
  sandbox: true }`. No existing menu or window-chrome customization.
- `app/packages/desktop-preload/src/hyveon-api.ts` / `preload.ts` expose a
  typed `window.hyveon` bridge via `contextBridge.exposeInMainWorld`,
  channel convention `<namespace>.<action>`, backed by NestJS
  `@MessagePattern` controllers under
  `app/packages/desktop-main/src/controllers/` and a
  `registerIpcMainBridges` step in `main.ts`/`ipc-main-bridge.ts`.
- `app/packages/web/src/components/app-layout.component.tsx` already
  renders a top `<header>` (brand, env pill, Refresh button, LIVE
  indicator, avatar placeholder) that wraps every routed page. This
  component is **not Electron-only** — the Playwright `chromium` e2e
  project runs it against a plain `vite preview` server with no Electron
  and no `window.hyveon`, so any drag-region/window-control chrome must be
  conditional on `window.hyveon` actually being present.
  - Confirmed via `grep -rn "platform"` across `@hyveon/shared`,
    `desktop-preload`, `api.service.ts` — no platform info currently
    reaches the renderer; this needs to be added.
- `initUpdater` in `electron-entry.ts` already demonstrates the pattern of
  fetching a Nest-managed service post-bootstrap via
  `nestApp.get(ElectronStoreService)` — reused for wiring the new window
  service to the live `BrowserWindow` instance, which is created *after*
  `bootstrap()` currently runs.

## Decision chain

**Q1. Where does the custom title bar live relative to the existing top
header?**
- Option A — Merge into existing header: the current header (brand, env
  pill, Refresh, LIVE, avatar) becomes the draggable title bar itself,
  with min/max/close added to its right edge. One row, no extra vertical
  space.
- Option B — Separate thin strip above the current header, Discord-style:
  a new ~32px draggable strip with just app icon + title + window
  buttons; existing header stays untouched below it.
- **Decision: A — merge into the existing header.**

**Q2. macOS window-control treatment?**
- Option A (recommended) — Keep native traffic-light buttons on macOS via
  `titleBarStyle: 'hidden'` + `trafficLightPosition`, repositioned into
  the custom header; only Windows/Linux get custom-drawn buttons. Matches
  how most Electron apps (including Discord) do it — less
  platform-specific bug surface.
- Option B — Fully custom buttons on every platform including macOS, for
  visual consistency, at the cost of diverging from macOS convention and
  more testing surface.
- **Decision: A — native traffic lights on macOS.**

**Q3. Windows/Linux window-control treatment?**
- Option A (recommended) — Native `titleBarOverlay` on Windows (built-in
  overlay controls: native look, Windows 11 snap-layout flyout on
  maximize-hover, least custom code); Linux (no overlay equivalent) gets
  simple custom-drawn min/max/close buttons matching the app's own theme.
- Option B — Fully custom buttons on both Windows and Linux, one code
  path, no snap-layout flyout.
- **Decision: A — native `titleBarOverlay` on Windows, custom buttons only
  on Linux.**

## Design presented and approved

**Main process (`electron-entry.ts`)**
- `createWindow()` gets platform-conditional options:
  - macOS: `titleBarStyle: 'hidden'`, `trafficLightPosition: { x: 12, y:
    12 }` (aligned to the merged header's height) — native traffic lights
    stay.
  - Windows: `titleBarStyle: 'hidden'`, `titleBarOverlay: { color,
    symbolColor, height }` matching the header's background/text colors —
    native overlay buttons, snap-layout included.
  - Linux: `titleBarStyle: 'hidden'`, no overlay — fully custom buttons.
- `resolveWindowIcon()` unchanged.

**New `WindowController`/`WindowService`** (matches the existing
`@MessagePattern` controller pattern, gets entry logging for free per
`logging.md`)
- `WindowService` holds the `BrowserWindow` reference — wired the same way
  `ElectronStoreService`/`initUpdater` already get it post-bootstrap
  (`nestApp.get(WindowService).attach(win)` in `electron-entry.ts`, right
  after `createWindow()`).
- Channels: `window.minimize`, `window.toggleMaximize`, `window.close`,
  `window.isMaximized` (query), plus a `window.maximizedChange` push event
  (main → renderer) so the button swaps icon on double-click-to-maximize
  or drag-to-screen-edge.

**Preload (`hyveon-api.ts` / `index.ts`)**
- New `window.hyveon.window` namespace: `{ platform: NodeJS.Platform,
  minimize(), toggleMaximize(), close(), isMaximized(),
  onMaximizedChange(cb) }`.
- `platform` read once from `process.platform` at preload time — no IPC
  round-trip needed for it.

**Renderer (`app-layout.component.tsx`)**
- Header becomes the drag region (`-webkit-app-region: drag` on the
  `<header>`, `no-drag` on every interactive child — nav toggle, Refresh,
  LIVE pill, avatar).
- Feature-detect: `window.hyveon?.window` present → render controls;
  absent (plain browser, e2e chromium project) → render nothing extra,
  current header behavior unchanged.
- macOS: reserve left padding for traffic lights (window controls not
  drawn — OS draws them).
- Windows: reserve right-side width for the overlay region; no custom
  buttons drawn there either (OS draws them).
- Linux only: render actual custom minimize/maximize/restore/close
  buttons, wired to the new preload calls.

**Testing**
- `electron-entry.test.ts`: extend for the platform-conditional
  `BrowserWindow` options.
- New `WindowController`/`WindowService` unit tests (Vitest, mock
  `BrowserWindow`).
- `app-layout.component.test.tsx`: assert drag-region classes are present
  and that Linux-only buttons render conditionally on
  `window.hyveon.window.platform`.
- No e2e changes needed — chromium project has no `window.hyveon`, keeps
  rendering as today.

## Approval

User approved this design in chat and confirmed it should go through
`/opsx:propose` rather than a direct PR, per the repo's
`spec-driven-development.md` routing table (new capability → opsx).
