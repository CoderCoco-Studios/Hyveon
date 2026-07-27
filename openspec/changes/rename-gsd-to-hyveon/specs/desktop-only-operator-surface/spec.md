## MODIFIED Requirements

### Requirement: Test harnesses do not depend on the removed HTTP surface

The test suite SHALL pass without the HTTP shim controllers. The tier-2 integration harness MUST dispatch only to IPC controllers via the DI container, and the five chromium Playwright specs (`audit.spec.ts`, `games.spec.ts`, `pending-changes-banner.spec.ts`, `polling.spec.ts`, `settings.spec.ts`) SHALL remain in the `chromium` project running self-contained against `vite preview` with browser-side `page.route()` stubs and the `hyveon-http-bridge.ts` init-script shim — their migration to the `electron` project stays in Epic F (F.2–F.6) and is NOT part of this change.

#### Scenario: Integration harness targets IPC controllers only

- **WHEN** the specs under `app/packages/web/e2e/integration-specs/` are searched for `HttpController` imports or dispatches
- **THEN** every `ipc.dispatch(...)` targets an IPC controller class (e.g. `GamesController`, `DiscordController`, `EnvController`) and no spec imports a `*-http.controller` module (doc comments excepted)

#### Scenario: Chromium specs pass after shim deletion

- **WHEN** `npm run app:test:e2e` runs the `chromium` project after the HTTP shim controllers are deleted
- **THEN** all five retained chromium specs pass, because their `/api/*` traffic is intercepted in the browser by `page.route()` and never reaches a real server

#### Scenario: Electron and integration tiers pass after shim deletion

- **WHEN** the `electron` e2e project and `npm run app:test:integration` run after the HTTP shim controllers are deleted
- **THEN** all specs pass unchanged
