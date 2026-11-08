# IPC Bridge Specs

EARS requirements for prefix `APP-IPC`; design in `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`.

## Bridge naming (NAME)

- [x] **APP-IPC-NAME-001**: The desktop preload script shall expose the renderer-facing IPC bridge object as `window.hyveon` via `contextBridge.exposeInMainWorld('hyveon', …)`.
- [x] **APP-IPC-NAME-002**: The desktop preload script shall not expose the IPC bridge object as `window.gsd`.
- [x] **APP-IPC-NAME-003**: When the Electron renderer loads and the preload script has run, `window.hyveon` shall expose at least the `games`, `costs`, `logs`, `folderUpload`, `volumeFiles`, `discord`, `env`, `wizard`, `drift`, `diagnostics`, `audit`, `iac`, `cloudHealth` and `window` namespaces (`preload.ts:419-652`).
- [x] **APP-IPC-NAME-004**: `@hyveon/desktop-preload` shall name the top-level bridge type, the test-mode API type and the mock-namespace bag type `HyveonApi`, `HyveonTestApi` and `HyveonMockNamespaces`, and shall export no `Gsd`-prefixed type.
- [x] **APP-IPC-NAME-005**: The single declaration of `declare global { interface Window { hyveon?: HyveonApi } }` shall live in `@hyveon/desktop-preload`'s `src/index.ts`.
- [x] **APP-IPC-NAME-006**: `@hyveon/web`'s `globals.d.ts` shall obtain the `Window.hyveon` augmentation through a bare side-effect `import '@hyveon/desktop-preload'` and shall not hand-declare `interface Window { hyveon: … }`.
- [x] **APP-IPC-NAME-007**: The `Window.hyveon` property type shall be optional, because the bridge is absent when the renderer runs in a plain browser. (observed)

## No HTTP transport (XPORT)

- [x] **APP-IPC-XPORT-001**: `@hyveon/desktop-main` shall expose its operator API exclusively over the Electron IPC microservice transport.
- [x] **APP-IPC-XPORT-002**: No file matching `*-http.controller.ts` or `*-http.controller.test.ts` shall exist in `app/packages/desktop-main/src/controllers/`.
- [x] **APP-IPC-XPORT-003**: `AppModule` in `@hyveon/desktop-main` shall import and register only IPC controllers and no HTTP controller.
- [x] **APP-IPC-XPORT-004**: When desktop-main bootstraps via `main.ts`, it shall create the Nest application with `NestFactory.createMicroservice` using the Electron IPC transport strategy, and no HTTP server shall listen on any port.
- [x] **APP-IPC-XPORT-005**: `app/packages/desktop-main/package.json` shall not list `@nestjs/platform-express`, `express` or `@types/express` in any dependency list, and `npm run app:build` shall compile the workspace without them.
- [x] **APP-IPC-XPORT-006**: The preload IPC bridge shall carry no bearer token, no API base URL and no `fetch` call; every bridge method shall reach main through `ipcRenderer.invoke`, `ipcRenderer.send` or `ipcRenderer.on`. (observed)

## Request/response dispatch (CALL)

- [x] **APP-IPC-CALL-001**: When desktop-main runs inside a real Electron main process, `registerIpcMainBridges` shall register an `ipcMain.handle` for every `@MessagePattern` collected by `BridgedElectronIPCTransport`, except the patterns in `SELF_BRIDGED_PATTERNS`. (observed)
- [x] **APP-IPC-CALL-002**: When the generic IPC bridge registers a pattern, it shall first call `ipcMain.removeHandler` for that pattern so hot-reload re-registration does not throw on a duplicate handler. (observed)
- [x] **APP-IPC-CALL-003**: When a generic-bridge `ipcMain.handle` wrapper is invoked, it shall call the Nest handler with `(payload, { evt })`, so the controller can read `ctx.evt.sender`. (observed)
- [x] **APP-IPC-CALL-004**: When a generic-bridge Nest handler returns an Observable, the bridge shall unwrap it with `firstValueFrom` and return the emitted value as the invoke result. (observed)
- [x] **APP-IPC-CALL-005**: While `process.versions.electron` is unset (plain-Node integration harness, CI), `registerIpcMainBridges` shall return without importing `electron` or registering any handler. (observed)
- [x] **APP-IPC-CALL-006**: `BridgedElectronIPCTransport` shall implement Nest's abstract `on()` and `unwrap()` members by throwing a descriptive `Error`, not by silently doing nothing. (observed)
- [x] **APP-IPC-CALL-007**: Each preload bridge write method shall pass exactly one payload argument to `invoke`, because the Electron IPC transport delivers only the first argument to `@Payload`. (observed)
- [x] **APP-IPC-CALL-008**: Each preload bridge method shall call an IPC channel named `<namespace>.<action>` (dot-separated) that matches the `@MessagePattern` string on the answering controller method. (observed)
- [x] **APP-IPC-CALL-009**: Each `@MessagePattern` channel pattern listed in `SELF_BRIDGED_PATTERNS` (`logs.stream`, `logs.lambda.stream`, `iac.plan`, `iac.apply`, `iac.destroy`, `iac.rollback.confirm`, `iac.runs.logs`, `iac.stack.initialize`, `iac.settings.autoUpdate.download`) shall have exactly one `ipcMain.handle` registration made by its owning controller's `onModuleInit`, guarded on `process.versions.electron` and preceded by `removeHandler`. (observed)
- [x] **APP-IPC-CALL-010**: The `ipc-main-bridge` unit tests shall assert that the generic IPC bridge skips every pattern in `SELF_BRIDGED_PATTERNS`. (observed)
- [x] **APP-IPC-CALL-011**: The four IPC push subscriptions, `window.hyveon.folderUpload.onProgress` (channel `folderUpload.progress`), `window.hyveon.window.onMaximizedChange` (channel `window.maximizedChange`), `window.hyveon.volumeFiles.onSession` (channel `volumeFiles.session`) and `window.hyveon.volumeFiles.onTransfer` (channel `volumeFiles.transfer`), shall each go through the one preload `subscribe` helper and return an unsubscribe function that removes their `ipcRenderer` listener. (observed: `preload.ts:216-220,485,524-525,650`; `preload.test.ts:340-353`)
- [x] **APP-IPC-CALL-012**: When a main-process service event must reach the renderer as a push, the desktop main process shall forward it with `forwardToWindows`, sending each event on its channel to every open, non-destroyed `BrowserWindow`; outside Electron it shall subscribe nothing and return `null`. (observed: `ipc-broadcast.ts:16-29`; caller `volume-files.controller.ts:105-106`)
- [x] **APP-IPC-CALL-013**: When the renderer uploads dropped files through `volumeFiles.uploadDropped`, the preload bridge shall resolve each `File` to its local path with `webUtils.getPathForFile` and send the paths as `localPaths` on `volumeFiles.uploadFiles`, so the renderer never handles local path strings. (observed: `preload.ts:513-521`)

## Error path (ERR)

- [x] **APP-IPC-ERR-001**: `RpcErrorMessageFilter` shall be registered as a global `@Catch()` filter on the desktop-main microservice before `registerIpcMainBridges` runs. (observed)
- [x] **APP-IPC-ERR-002**: When a generic-bridge `@MessagePattern` handler throws a non-`RpcException`, `RpcErrorMessageFilter` shall re-emit it as an erroring Observable of a plain `Error` whose message is `ipcErrorMessage(exception)`, instead of Nest's "Internal server error". (observed)
- [x] **APP-IPC-ERR-003**: If a generic-bridge handler rejects or its Observable errors, then the generic IPC bridge shall log `ipc-main-bridge: handler for "<pattern>" failed: <message>` at `error` with the stack, and rethrow a new plain `Error` carrying only that message, so the rejection survives structured clone to the renderer. (observed)
- [x] **APP-IPC-ERR-004**: If a controller payload guard rejects a request (for example `requireStringArray` on a non-string-array field), then the renderer shall receive an `Error` whose message is the guard's field error (such as `<field> must be an array of strings`). (observed)
- [x] **APP-IPC-ERR-005**: If a handler on a self-bridged channel (one listed in `SELF_BRIDGED_PATTERNS`) throws before returning its ack, then desktop-main shall log the failure and reject the invoke with a plain `Error` carrying only the handler's message, as the generic bridge does. (observed)
- [x] **APP-IPC-ERR-006**: If a stream's main-side source fails with a non-abort error, then the main process shall log it and send `{ error }` on that stream's end channel, and the preload stream shall throw an `Error` with that text to the renderer consumer. (observed)
- [x] **APP-IPC-ERR-007**: When a stream fails, the error message the renderer receives from that stream's end channel shall match the handler's error message, with no added `Error: ` prefix, as invoke errors do. (observed)
- [x] **APP-IPC-ERR-008**: When `api.service.ts` is called while `window.hyveon` is absent, the `api.*` facade shall reject (not throw synchronously) with an `Error` stating that the IPC bridge (`window.hyveon`) is not available in this context. (observed)

## Streaming across the context bridge (STREAM)

- [x] **APP-IPC-STREAM-001**: Every streaming IPC channel the renderer consumes (`logs.stream`, `logs.lambda.stream`, `iac.stack.initialize`, `iac.runs.logs`, `iac.settings.autoUpdate.download`) shall deliver its chunks to the renderer through the preload bridge.
- [x] **APP-IPC-STREAM-002**: The preload shall not return an `AsyncGenerator` or any other value across `contextBridge` that cannot survive structured clone; each streaming bridge method shall return a plain `HyveonStreamHandle` object with own `next`, `cancel` and `[Symbol.asyncIterator]` members, the iterator returning the handle itself.
- [x] **APP-IPC-STREAM-003**: The preload shall not require the renderer to pass an `AbortSignal` or other prototype-bearing object across `contextBridge`; each streaming bridge method shall mint its `AbortController` inside the preload and expose cancellation only through `HyveonStreamHandle.cancel()`.
- [x] **APP-IPC-STREAM-004**: When the renderer invokes a streaming channel on the bridge in a production build with no test mode and no registered mock, the call shall return an async-iterable handle rather than throwing a serialization error, and iterating it shall yield the chunks the main process emits.
- [x] **APP-IPC-STREAM-005**: When the operator selects a game on the logs screen and the main process emits log chunks on `logs.stream`, the streamed lines shall appear in the log viewer after the initial snapshot with no stream error banner.
- [x] **APP-IPC-STREAM-006**: When the operator starts stack initialization (`iac.stack.initialize`) on the final wizard step, the run shall execute and its phase-progress events shall stream into the viewer through the preload bridge.
- [x] **APP-IPC-STREAM-007**: When a plan, apply or destroy run is started from the `/iac` screen, the run's output shall stream into the log viewer over `iac.runs.logs` (renderer method `iac.runs.streamLogs`) while the run is in progress.
- [x] **APP-IPC-STREAM-008**: When the renderer abandons a per-call stream (`logs.stream` or `logs.lambda.stream`) by calling `cancel()` or leaving the iteration early, the preload shall close the underlying generator, remove its listeners and send that stream's `<channel>.<streamId>.cancel` message, the main process shall abort the source and remove its cancel and ready listeners, and no error shall be raised in the renderer.
- [x] **APP-IPC-STREAM-009**: When the renderer abandons a shared side-channel stream (`iac.stack.initialize`, `iac.runs.logs` or `iac.settings.autoUpdate.download`) by calling `cancel()` or leaving the iteration early, the preload shall send no message to the main process, and the main process shall let the underlying work run to completion: stack initialization and the update download are not aborted by closing their viewer, and the `iac.runs.logs` tail ends with the run's output or when the window is destroyed.
- [x] **APP-IPC-STREAM-010**: When the renderer abandons a shared side-channel stream by calling `cancel()` or leaving the iteration early, the preload shall close the underlying generator, stop yielding, remove its chunk and end listeners, and raise no error to the renderer.
- [x] **APP-IPC-STREAM-011**: The test suite shall include at least one test that drives a streaming channel end to end through the real preload bridge and the real main-process controller, over an in-process IPC bus that structured-clones every payload, reply and push and delivers the invoke reply after the pushes (no ordering guarantee between the two paths), with no mock registered, so a regression at the serialization or ordering boundary fails the build.
- [x] **APP-IPC-STREAM-012**: For a per-call stream, the preload shall derive unique chunk, end and cancel channel names from the `streamId` returned in the invoke ack. (observed)
- [x] **APP-IPC-STREAM-013**: For a per-call stream, the preload shall receive every chunk and end event the main process sends for that `streamId`, regardless of the order in which the invoke reply and the pushes reach the renderer: the preload attaches its listeners and then sends `<channel>.<streamId>.ready`, and the main process starts the source only on receiving it; a cancel received before `ready` ends the stream without starting the source.
- [x] **APP-IPC-STREAM-014**: For a shared side-channel stream, the preload shall attach its chunk and end listeners before invoking, buffer events until the ack reveals its own `streamId`, then replay them and discard events tagged with any other `streamId`. (observed)
- [x] **APP-IPC-STREAM-015**: If the `iac.stack.initialize` invoke ack reports `started: false` (shared workspace busy), then the preload stream shall throw immediately with the ack's `error` text instead of waiting for chunks. (observed)

## Contract and types (CONTRACT)

- [x] **APP-IPC-CONTRACT-001**: `@hyveon/desktop-preload`'s `hyveon-api.ts` shall define the full renderer-facing bridge contract (`HyveonApi`, `HyveonTestApi`, `HyveonStreamHandle` and every namespace's payload and result types), re-exported type-only from `src/index.ts`. (observed)
- [x] **APP-IPC-CONTRACT-002**: Each IPC controller's unit tests shall assert, via `expectChannels` reading the `microservices:pattern` reflect-metadata, that each `@MessagePattern` method is registered under the exact channel string the preload calls. (observed)
- [x] **APP-IPC-CONTRACT-003**: Where `@hyveon/shared` defines a type that crosses the preload bridge (the game server, game write, drift, audit, run-history, Discord admin and status shapes, and the redacted Discord config), the preload contract shall re-export that shared type, or extend it with the bridge-only fields, rather than declare a hand-mirrored copy, and a type-level equality test shall fail typecheck if a re-exported preload type stops equalling its shared type. Types defined only in `@hyveon/desktop-main` (such as `GameWizardDraft`) are outside this requirement because the preload cannot import them. (observed)
- [x] **APP-IPC-CONTRACT-004**: The renderer shall report a missing `window.hyveon` bridge with one shared message string, whether the caller is `api.service.ts` or a direct `window.hyveon` caller, including the Settings page's manual update check and install. (observed)

## Secrets (SEC)

- [x] **APP-IPC-SEC-001**: The IPC bridge shall return Discord bot token, Discord public key and health-check secret state to the renderer only as `botTokenSet`, `publicKeySet` and `secretSet` booleans, never as the secret values. (observed)
- [x] **APP-IPC-SEC-002**: The IPC bridge shall expose no channel that returns file-browser helper credentials to the renderer; the `volumeFiles` namespace shall return only session state, listings, text content, transfer ids and `VolumeResult` error codes. (observed: the former `files.start` one-time credential channel is removed; `hyveon-api.ts:1570`, `preload.ts:488-526`; positive requirement owned by `helper-task`)
- [x] **APP-IPC-SEC-003**: The test suites shall check helper-facing IPC results and pushes for credential-, token-, certificate-, fingerprint-, URL- and IPv4-shaped keys or string values with one shared pattern, `findSecretFields`, used by the vitest helper `expectNoSecretFields` and the Playwright specs. (observed: `shared/src/testing/secretFields.ts:2,29-33`, `desktop-main/src/testing/no-secret-fields.ts:10-12`; tests only, no runtime check)

## Test-mode mock seam (SEAM)

- [x] **APP-IPC-SEAM-001**: While `HYVEON_TEST_MODE=1` is set for the Electron app, the preload shall attach `mock(channel, handler)`, `clearMocks()` and `reset()` under `window.hyveon.__test`, not under `window.gsd.__test`.
- [x] **APP-IPC-SEAM-002**: While `HYVEON_TEST_MODE` is not `1`, the preload shall not expose `window.hyveon.__test` at all.
- [x] **APP-IPC-SEAM-003**: When a Playwright Electron spec seeds a mock IPC response, the e2e helper shall call `window.hyveon.__test.mock(channel, handler)` inside the page, and seeding helpers shall be named for the bridge (for example `applyHyveonMocks`, not `applyGsdMocks`).
- [x] **APP-IPC-SEAM-004**: When a mock is registered for a request/response channel, the preload `invoke` shall resolve with the mock's return value (wrapping a non-function mock as a constant) and shall not call `ipcRenderer.invoke` for that channel. (observed)
- [x] **APP-IPC-SEAM-005**: When a mock is registered for a streaming channel, the preload stream shall call it with `(arg, signal)` or `(signal)` and yield its `AsyncIterable` without touching IPC. (observed)
- [x] **APP-IPC-SEAM-006**: `@hyveon/desktop-preload` shall ship only one test-mode mock registry, the one consulted by `window.hyveon.__test`. (observed)
- [x] **APP-IPC-SEAM-007**: The `@hyveon/desktop-preload` build shall not emit its `*.test.ts` files into `dist`. (observed)

## Test harnesses without HTTP (HARN)

- [x] **APP-IPC-HARN-001**: The unit, tier-2 integration and both Playwright e2e test suites shall pass without any desktop-main HTTP controller or HTTP server.
- [x] **APP-IPC-HARN-002**: Every `ipc.dispatch(...)` in `app/packages/web/e2e/integration-specs/` shall target an IPC controller class through the DI container, and no integration spec shall import a `*-http.controller` module (doc comments excepted).
- [x] **APP-IPC-HARN-003**: Each Playwright spec in the `chromium` project (every spec not listed in `ELECTRON_SPECS` in `playwright.config.ts`, currently `audit`, `games`, `pending-changes-banner`, `polling`, `settings` and `infrastructure-logs`) shall run self-contained against `vite preview`, with its `/api/*` traffic intercepted in the browser by `page.route()` stubs behind the `hyveon-http-bridge.ts` init-script `window.hyveon` shim, never reaching a real server.
- [x] **APP-IPC-HARN-004**: The `electron` Playwright project shall drive the built main bundle via `_electron.launch()` with `HYVEON_TEST_MODE=1`, and at least one of its specs shall resolve a request/response channel (`env.get`) against the real main process with no mock registered. (observed)
