# preload-bridge-naming

## Purpose

Defines the public name of the desktop preload IPC bridge — the runtime global the renderer talks to, the TypeScript types that describe it, and the test-mode mock seam attached to it. The bridge is exposed as `window.hyveon` with `Hyveon*` type names; the pre-rebrand `gsd`/`Gsd*` names are gone. The underlying IPC behavior is unchanged; only the externally-observable naming contract is specified here.

## Requirements

### Requirement: Preload bridge is exposed as `window.hyveon`

The desktop preload script SHALL expose the renderer-facing IPC bridge object as `window.hyveon` via `contextBridge.exposeInMainWorld('hyveon', ...)`. It SHALL NOT expose the same object as `window.gsd`.

#### Scenario: Renderer reads the bridge after preload initializes

- **WHEN** the Electron renderer process loads and the preload script has run
- **THEN** `window.hyveon` is defined and exposes the `games`, `costs`, `logs`, `files`, `discord`, `env`, `wizard`, `drift`, `diagnostics`, `audit`, `iac`, `cloudHealth`, and `window` namespaces
- **AND** `window.gsd` is `undefined`

### Requirement: Bridge TypeScript types are named `Hyveon*`

The TypeScript types describing the preload bridge and its test-mock surface (the top-level bridge type, the test-mode API, and the mock-namespace bag type) SHALL be named `HyveonApi`, `HyveonTestApi`, and `HyveonMockNamespaces` respectively, matching the runtime global's name. No `Gsd`-prefixed type SHALL remain in `@hyveon/desktop-preload`'s public exports.

#### Scenario: Web package imports the bridge type

- **WHEN** `@hyveon/web` needs the `Window.hyveon` augmentation
- **THEN** its `globals.d.ts` is a bare side-effect import (`import '@hyveon/desktop-preload'`) that pulls in the augmentation, and does not hand-declare `interface Window { hyveon: ... }` itself
- **AND** the single source of truth for `declare global { interface Window { hyveon?: HyveonApi } }` lives in `@hyveon/desktop-preload`'s `src/index.ts`

### Requirement: Test-mode mock seam uses the same bridge name

The Playwright Electron test seam (gated on `HYVEON_TEST_MODE=1`) SHALL attach its `__test` mock registry under `window.hyveon.__test`, not `window.gsd.__test`, and e2e helper functions that seed it SHALL be named to match (e.g. `applyHyveonMocks`, not `applyGsdMocks`).

#### Scenario: Electron e2e spec seeds a mock IPC response

- **WHEN** a Playwright Electron spec calls the mock-seeding helper to stub an IPC channel
- **THEN** the helper calls `window.hyveon.__test.mock(channel, handler)` inside the page, and the production build (without the test-mode env var) never exposes `window.hyveon.__test` at all
