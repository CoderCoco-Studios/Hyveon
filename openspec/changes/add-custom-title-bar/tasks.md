## 1. Window-control IPC surface (desktop-main)

- [x] 1.1 Add `WindowService` (`app/packages/desktop-main/src/services/WindowService.ts`) — holds an optional `BrowserWindow` reference, an `attach(win)` method, and methods `minimize()`, `toggleMaximize()`, `close()`, `isMaximized()`; forwards the window's native `maximize`/`unmaximize` events to a subscribable emitter for the controller to push. Errors are caught/normalized and logged per `logging.md`.
- [x] 1.2 Add `WindowController` (`app/packages/desktop-main/src/controllers/window.controller.ts`) with `@MessagePattern` handlers for `window.minimize`, `window.toggleMaximize`, `window.close`, `window.isMaximized`, each logging on entry per `logging.md`; wire the `window.maximizedChange` push event.
- [x] 1.3 Register `WindowService`/`WindowController` in the relevant Nest module (check `app.module.ts` / existing module structure for where sibling controllers live).
- [x] 1.4 Unit tests: `WindowService.test.ts` (mock `BrowserWindow`, cover minimize/toggleMaximize both directions/close/isMaximized/event forwarding) and `window.controller.test.ts` (mirrors existing controller test conventions, e.g. `files.controller.test.ts`).

## 2. Preload bridge

- [x] 2.1 Add `window.hyveon.window` namespace to `app/packages/desktop-preload/src/hyveon-api.ts` (typed interface: `platform`, `minimize()`, `toggleMaximize()`, `close()`, `isMaximized()`, `onMaximizedChange(cb)`).
- [x] 2.2 Implement the namespace in `app/packages/desktop-preload/src/preload.ts` / `index.ts` — `platform` read from `process.platform` directly (no IPC), the four methods as `ipcRenderer.invoke` wrappers, `onMaximizedChange` as an `ipcRenderer.on` subscription following the existing event-subscription pattern used elsewhere in this file.
- [x] 2.3 Update preload tests for the new namespace.

## 3. BrowserWindow chrome (electron-entry.ts)

- [x] 3.1 Add platform-conditional `BrowserWindow` construction options in `createWindow()`: `titleBarStyle: 'hidden'` everywhere; macOS gets `trafficLightPosition`; Windows gets `titleBarOverlay` (color/symbolColor matched to the header theme, height matched to the header's rendered height — resolve the "Open Questions" height value from `design.md` here).
- [x] 3.2 After `createWindow()` returns the window (or by having `createWindow()` return it), call `nestApp.get(WindowService).attach(win)` in the `app.whenReady()` chain, following the same post-bootstrap resolution pattern already used for `initUpdater`/`ElectronStoreService`.
- [x] 3.3 Update `electron-entry.test.ts` for the new platform-conditional options and the `WindowService.attach` call.

## 4. Renderer — draggable header and platform-conditional controls

- [ ] 4.1 In `app-layout.component.tsx`, add `-webkit-app-region: drag` to the header (conditional on `window.hyveon?.window` being present) and `-webkit-app-region: no-drag` on every interactive child (mobile nav toggle, Refresh button, LIVE indicator, avatar placeholder).
- [ ] 4.2 Add a small `WindowControls` component, rendered only when `window.hyveon?.window` is present: on macOS/Windows render nothing (reserve layout space only, per design D2/D3); on Linux render minimize/maximize-or-restore/close buttons using `lucide-react` icons (`Minus`, `Square`/`Copy`, `X`) wired to the preload methods, subscribing to `onMaximizedChange` to swap the maximize/restore icon.
- [ ] 4.3 Extend `app-layout.component.test.tsx`: drag-region classes present/absent based on `window.hyveon` presence; Linux-only button rendering gated correctly per platform; button clicks call the expected preload methods; icon swaps on a simulated `onMaximizedChange` event.

## 5. Docs

- [ ] 5.1 Update `docs/docs/components/management-app.md` IPC channel table with the five new `window.*` channels.
- [ ] 5.2 Check `docs/docs/app/*` for any screenshot or written description of the top bar / title bar that now needs updating to reflect the merged header and platform-specific controls.

## 6. Verification

- [ ] 6.1 `npm run app:lint` clean.
- [ ] 6.2 `npm run app:typecheck` clean.
- [ ] 6.3 `npm run app:test` full unit suite green.
- [ ] 6.4 `npm run app:test:e2e` — confirm the `chromium` project (no Electron) still passes unmodified, and the `electron` project reflects the new chrome where applicable.
- [ ] 6.5 Manual check per platform actually available in dev: launch `npm run desktop:dev`, drag the header to move the window, verify interactive header controls (nav toggle/Refresh/LIVE/avatar) still work, verify minimize/maximize/restore/close behave correctly, verify no OS-default title bar row remains.
