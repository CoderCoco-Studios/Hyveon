---
parent: operator-app
prefix: APP-IPC
---

# IPC Bridge

## Context and Design Philosophy

Hyveon's desktop app has exactly one way for the operator UI to reach the back end: the renderer calls a method on `window.hyveon`, the preload script turns that into `ipcRenderer.invoke(channel, payload)`, and the Electron main process answers it from a Nest `@MessagePattern` handler.
There is no HTTP server, no bearer token, no API base URL and no `fetch` anywhere in the path (`desktop-preload/src/preload.ts:1-15`, APP-IPC-XPORT-001, APP-IPC-XPORT-006).
This leaf owns that channel end to end: the shape of `window.hyveon`, how a call is dispatched on the main side, how an error crosses back, how a stream survives the `contextBridge` clone, and the test-mode seam that fakes the whole thing.

The renderer runs with `contextIsolation: true` and `sandbox: true` and gets the preload from `../preload/preload.cjs` (`desktop-main/src/electron-entry.ts:181-183`), so the preload is the only code with `ipcRenderer`, and only values that survive structured clone reach the page.
The design follows from that constraint: a plain object literal of statically named methods (`preload.ts:419-652`), errors flattened to a message string, and streams wrapped as plain handle objects (`preload.ts:17-51`).

What this leaf owns:

- **Renderer surface**: the `HyveonApi` contract (`desktop-preload/src/hyveon-api.ts:2651`), the `Window.hyveon` augmentation (`desktop-preload/src/index.ts:58-62`, pulled into web by `web/src/globals.d.ts:10`), the `api.*` facade (`web/src/api.service.ts:276`) and the bridge-unavailable strings (`web/src/lib/bridge.utils.ts:2,8`).
- **Preload**: the mock-aware `invoke` (`preload.ts:196-206`), the push `subscribe` helper (`preload.ts:216-220`), the five buffered streams (`stream-bridge.ts:91`, `preload.ts:229-350`), the stream handle wrapper (`preload.ts:369-392`) and `exposeInMainWorld('hyveon', …)` (`preload.ts:686`).
- **Main-to-renderer push**: `forwardToWindows` (`desktop-main/src/ipc-broadcast.ts:16-29`).
- **Main side**: `BridgedElectronIPCTransport` and `registerIpcMainBridges` (`desktop-main/src/ipc-main-bridge.ts:49,124`), the `SELF_BRIDGED_PATTERNS` skip list (`ipc-main-bridge.ts:27-37`), `RpcErrorMessageFilter` (`desktop-main/src/rpc-error-message.filter.ts:25`) and the payload guards in `controllers/validation.ts`.
- **Test seams**: `window.hyveon.__test` (`preload.ts:659-684`), `expectChannels` (`desktop-main/src/testing/message-pattern.test-utils.ts:18`), the secret-shape check `findSecretFields` / `expectNoSecretFields` (`shared/src/testing/secretFields.ts:29`, `desktop-main/src/testing/no-secret-fields.ts:10`) and the per-channel `mockRegistry` in `preload.ts`.

What it deliberately does not own:

- Bootstrapping and the window: `main.ts:43-56` creates the transport, registers the filter and calls the bridge; `electron-entry.ts` creates the `BrowserWindow`; `app.module.ts` is the module tree the bridge dispatches into. All belong to `operator-app/desktop-shell`, as does the first-run gate that tolerates a missing `window.hyveon.wizard` (`web/src/app.component.tsx:34-43`).
- The handlers themselves. Every controller under `desktop-main/src/controllers/` belongs to the leaf whose behaviour it serves; this leaf only fixes how they are reached. The self-bridged streaming controllers are owned by `operator-app/infra-logs` (`logs.controller.ts`) and `iac/run` (`iac.controller.ts`, `iac-runs.controller.ts`). `iac-settings.controller.ts` is owned by `deployment-config`; its self-bridged `iac.settings.autoUpdate.download` registration and the other auto-update channels belong to `operator-app/app-update-and-release` and move to a controller that leaf owns.
- The chromium-tier `window.hyveon` HTTP shim (`web/e2e/fixtures/hyveon-http-bridge.ts`) and the electron/integration harness fixtures, which sit in the shared test harness; this leaf cites them.

CLAUDE.md invariants that live here:

- **The desktop app has no HTTP transport.** `createMicroservice` with the Electron IPC strategy is the only server (`main.ts:44-47`).
- **Secrets never reach the renderer.** Redacted shapes carry `botTokenSet` / `publicKeySet` booleans (`hyveon-api.ts:231-242`). The former one-time FileBrowser credential exception (`files.start`) was removed with the `files` namespace; see "Contract and Types".
- **Every IPC handler logs on entry; no error escapes uncaught** (`.claude/rules/logging.md`). The generic bridge is the backstop for rule 2 (`ipc-main-bridge.ts:142-153`), but self-bridged channels have no backstop (see "Error Path").

## Call Path

### Request/response channels

A renderer call such as `window.hyveon.games.start('valheim')` resolves through three hops.

1. The preload method calls `invoke('games.start', game)` (`preload.ts:424`). `invoke` checks the per-channel `mockRegistry` first and otherwise forwards to `ipcRenderer.invoke` (`preload.ts:196-206`).
2. In main, `registerIpcMainBridges` has put an `ipcMain.handle(pattern, …)` on every `@MessagePattern` the transport collected, except those in `SELF_BRIDGED_PATTERNS` (`ipc-main-bridge.ts:132-138`). The wrapper calls Nest's handler with `(payload, { evt })` (`ipc-main-bridge.ts:140`), so a controller can read `ctx.evt.sender`.
3. Nest returns either a value or an Observable; the bridge unwraps an Observable with `firstValueFrom` and returns the value as the invoke result (`ipc-main-bridge.ts:141`).

The bridge exists because `ElectronIPCTransport.listen()` never calls `ipcMain.handle` itself; without it every non-self-bridged channel hangs (`ipc-main-bridge.ts:91-94`).
`BridgedElectronIPCTransport` exposes Nest's protected `messageHandlers` map through a typed getter (`ipc-main-bridge.ts:49-53`) and supplies the `on()` / `unwrap()` members Nest 11 made abstract, both of which throw (`ipc-main-bridge.ts:55-82`).
Each registration calls `removeHandler` first so hot reload does not throw on a duplicate handler (`ipc-main-bridge.ts:95-96,137`).
Outside a real Electron main process (`process.versions.electron` unset) the bridge is a silent no-op, which keeps the plain-Node integration harness from importing `electron` (`ipc-main-bridge.ts:119-128`).

The transport delivers only the first argument to `@Payload`, so every write method passes a single payload object rather than positional arguments (`preload.ts:426-428`).
Channel names follow `<namespace>.<action>` (`preload.ts:10`); `expectChannels` reads the `microservices:pattern` reflect-metadata to assert each controller method is registered under the exact string the preload calls (`message-pattern.test-utils.ts:4-22`), since calling the method directly in a unit test succeeds whatever string is registered.

### Push channels

Three namespaces expose four event subscriptions instead of streams, all through one preload `subscribe(channel, cb)` helper that drops the Electron event argument (`preload.ts:216-220`): `folderUpload.onProgress` on `folderUpload.progress` (`preload.ts:485`), `volumeFiles.onSession` on `volumeFiles.session` and `volumeFiles.onTransfer` on `volumeFiles.transfer` (`preload.ts:524-525`), and `window.onMaximizedChange` on `window.maximizedChange` (`preload.ts:650`).
Each returns an unsubscribe function, which is clone-safe because it is a function returned by a bridged call.
The two `volumeFiles` channel names are string literals in preload, because the sandboxed preload cannot load `@hyveon/shared/volumeFiles` at runtime; `preload.test.ts:340-341` pins them to the shared constants (`preload.ts:143-148`, `shared/src/volumeFiles/types.ts:96-99`).
On the main side the `volumeFiles` pushes go through `forwardToWindows`, which subscribes to a service event source and `webContents.send`s each event to every non-destroyed window, and subscribes nothing outside Electron (`ipc-broadcast.ts:16-29`; caller `volume-files.controller.ts:105-106`, owned by `helper-task`).
`window.platform` is a static `process.platform` value read at preload time (`preload.ts:645`).

### Self-bridged channels

Nine patterns register their own `ipcMain.handle` in their controller's `onModuleInit` and are skipped by the generic bridge (`ipc-main-bridge.ts:27-37`).

| Pattern | Registered at | Why self-bridged |
|---|---|---|
| `logs.stream`, `logs.lambda.stream` | `logs.controller.ts:43-50` | Per-call stream; needs `evt.sender` to push chunks |
| `iac.plan`, `iac.apply`, `iac.destroy` | `iac.controller.ts:576-597` | Long run with side-channel output (`ipc-main-bridge.ts:11-15`) |
| `iac.rollback.confirm` | `iac.controller.ts:603-606` | Nest's `RpcContextCreator` drops the undecorated `ctx` argument, crashing on `ctx.evt` (`ipc-main-bridge.ts:18-22`) |
| `iac.stack.initialize` | `iac.controller.ts:611-614` | Shared side-channel stream |
| `iac.runs.logs` | `iac-runs.controller.ts:182-185` | Shared side-channel stream |
| `iac.settings.autoUpdate.download` | `iac-settings.controller.ts:116-119` | Shared side-channel stream; same `ctx` reason (`iac-settings.controller.ts:106-109`) |

Each registration is the same three lines: guard on `process.versions.electron`, `removeHandler`, then `handle(channel, (evt, p) => this.method(p, { evt }))`.
The list is hand-synced with those registrations; all nine currently match, and `ipc-main-bridge.test.ts` covers the skip for five of them.
`iac.plan`, `iac.apply` and `iac.destroy` are plain `invoke` calls from the renderer (`preload.ts:602-606`); their output is read through `iac.runs.logs`, so "self-bridged" does not imply "streamed to the caller".

## Error Path

Whatever a handler throws, the renderer receives a plain `Error` whose `.message` is the handler's real message.
All message extraction goes through one function, `ipcErrorMessage` (`desktop-main/src/ipc-handlers.ts`): an `HttpException` yields the text of its body (`message`, else `error`, so `BadRequestException({ success: false, error: '<field> must be an array of strings' })` reaches the operator as the field error rather than "Bad Request Exception"), anything else yields its `.message`, and a non-object throw yields `String(err)`.

**`RpcErrorMessageFilter`** is a global `@Catch()` filter (registered in `main.ts`).
Without it, Nest's `BaseRpcExceptionFilter` replaces any non-`RpcException` message with `'Internal server error'`.
The filter re-emits `new Error(ipcErrorMessage(exception))` as an erroring Observable.

**The generic bridge `catch`** handles the two ways an error reaches it: a rejected promise, and a resolved Observable built by Nest's `RpcProxy` from `throwError(...)`, which `firstValueFrom` turns back into a rejection.
It logs `ipc-main-bridge: handler for "<pattern>" failed` at `error` with the stack and rethrows a new plain `Error` carrying only the message (`toIpcError`).
The reason is structured clone: a raw AWS SDK error with `$metadata` or symbol-keyed fields fails to marshal and the renderer would see "object could not be cloned" instead of the message.

**Self-bridged channels** (the nine `SELF_BRIDGED_PATTERNS`) are registered by their controllers' `onModuleInit` through one helper, `registerSelfBridgedHandlers`, which does the `process.versions.electron` guard, `removeHandler` then `handle` for each channel, and wraps the handler in the same `toIpcError` normalisation, so a throw before the ack is logged and rejected as a plain `Error` exactly like a generic-bridge failure.

Stream failures use the same message function: the main side sends `{ error: <message> }` on the end channel and the preload throws `new Error(endError)` from the generator, so a stream error carries no `Error: ` prefix that an invoke error lacks.

## Streaming Across the Context Bridge

`contextBridge` structured-clones every value; a raw `AsyncGenerator` throws "An object could not be cloned" when returned, and an `AbortSignal` arrives as an inert object with no prototype methods (`preload.ts:17-26`).
Every streaming channel is therefore two layers (`preload.ts:26-44`):

- A preload-internal `async function*` built by `createBufferedStream` (`stream-bridge.ts:91`), which owns the IPC listeners and accepts a real `AbortSignal`.
- A bridge-facing `open*Stream` wrapper that mints an `AbortController` inside preload and returns a `HyveonStreamHandle`: a plain object with own `next`, `cancel` and `[Symbol.asyncIterator]` returning itself (`preload.ts:369-392`, `hyveon-api.ts:186`). The renderer can `for await` over it directly.

| Renderer method | Invoke channel | Style | Chunk / end channels | Cancel reaches main? |
|---|---|---|---|---|
| `logs.stream(game)` | `logs.stream` | per-call | `logs.stream.<id>.chunk` / `.end` | Yes, `logs.stream.<id>.cancel` (`preload.ts:229-239`) |
| `logs.lambda.stream(key)` | `logs.lambda.stream` | per-call | `logs.lambda.stream.<id>.chunk` / `.end` | Yes, `.cancel` (`preload.ts:248-258`) |
| `iac.stack.initialize()` | `iac.stack.initialize` | shared | fixed `iac.stack.initialize.chunk` / `.end` | No; runs to completion |
| `iac.settings.autoUpdateDownload()` | `iac.settings.autoUpdate.download` | shared | fixed `….download.chunk` / `.end` | No; runs to completion |
| `iac.runs.logs(runId)` | `iac.runs.logs` | shared | fixed `iac.runs.logs.chunk` / `.end` | No; tail ends with the run |

**Per-call style.** The invoke ack carries a `streamId` minted by the controller; the preload derives unique chunk/end/cancel channel names from it and attaches listeners after the ack resolves (`stream-bridge.ts`).
The controller starts its fire-and-forget loop on a later macrotask than the ack (`setImmediate` in `LogsController.openStream`), so the reply is sent before any chunk or immediate error `end`, and the ordered renderer channel delivers the ack, and so the listener attachment, first.
Abort sends the cancel message; leaving the loop early also sends it from `finally`.
On the main side, a one-shot `ipcMain.once(cancelChannel)` aborts the source, the loop pushes each line with `sender.send`, and the cancel listener is removed when the loop ends.

**Shared side-channel style.** Chunk and end channels are fixed constants shared by every concurrent call, so the preload attaches listeners before invoking, buffers raw events until the ack reveals its own `streamId`, then replays and filters out foreign ids (`stream-bridge.ts:126-201`).
The end listener uses `.on` rather than `.once` because another call's end can arrive first (`stream-bridge.ts:165-169`).
`iac.stack.initialize` acks `{ started: false, error }` when the shared workspace is busy, and `checkAck` throws immediately (`preload.ts:273-289`).
Abort only stops the local drain loop: the preload sends no message and removes its listeners.
The main-process work behind these channels deliberately runs to completion, because closing a viewer must not abort provisioning (`iac.stack.initialize`) or an update download half way.
The `iac.runs.logs` tail is a read of a run's output, ends when the output ends, and is also aborted when the `WebContents` is destroyed (`iac-runs.controller.ts`); `HyveonStreamHandle.cancel` is documented accordingly.
Only the per-call style tears the main-side source down on abandon.

## Contract and Types

`hyveon-api.ts` (2,698 lines) is the full hand-written contract: `HyveonApi` (`:2651`), `HyveonTestApi` (`:2608`), `HyveonStreamHandle` (`:186`) and the payload/result types of every namespace.
`index.ts` re-exports those types and `GUIDED_PROFILE_NAME`, and is the single declaration of `Window.hyveon?: HyveonApi` (`index.ts:1-62`), satisfying APP-IPC-NAME-005.
The global is optional because the bridge is absent in a plain browser (`web/src/globals.d.ts:1-9`).

Where `@hyveon/shared` defines a type that crosses the bridge, the contract uses it rather than a copy: `GameServerPort` and `GameServer` are re-exported from `@hyveon/shared`, and `RedactedDiscordConfig` is the shared redacted shape intersected with the bridge-only `interactionsEndpointUrl` that the Discord controller reads from stack outputs; the renderer's `DiscordConfigRedacted` is an alias of it.
Types with no shared counterpart (the add-game wizard draft mirrors `ElectronStoreService`'s, which the preload cannot import) remain hand-mirrored with a "keep in sync" note.
The preload's `LogChunk` (a streamed log line, `string`) is unrelated to the shared `LogChunk` (`{ message, timestamp }`, the cloud provider's stream element), which main flattens to a line before it crosses the bridge.
Nothing type-checks the preload contract against controller return types; the channel string is the only checked link (`message-pattern.test-utils.ts`).

**Renderer facades.** `api.service.ts` wraps nine namespaces (games, costs, folderUpload, volumeFiles, discord, diagnostics, drift, audit, cloudHealth) behind `hyveon()`, which throws when the bridge is missing; every method is `async` so that throw surfaces as a rejection.
The rest of the renderer, including all of `iac.*`, `logs.*`, `wizard.*` and `window.*`, calls `window.hyveon` directly.
Both report a missing bridge with the one `BRIDGE_UNAVAILABLE` string from `bridge.utils.ts`.

**Secrets.** Discord and health-check secrets cross only as set/unset booleans (`hyveon-api.ts:238-239`).
No channel returns a helper credential any more: the `files` namespace and its one-time FileBrowser credential (`FileMgrCredentials`) were removed from `hyveon-api.ts`, `preload.ts` and `api.service.ts`, and the `volumeFiles` namespace returns only session state, listings, text content, transfer ids and `VolumeResult` codes (`hyveon-api.ts:1570`, `preload.ts:488-526`).
The guarantee is proven by tests, not checked at runtime: `findSecretFields` matches keys and string values against one credential/token/cert/fingerprint/URL/IPv4 pattern (`shared/src/testing/secretFields.ts:2,29-33`) and is shared by the vitest wrapper `expectNoSecretFields` and the Playwright volume-files specs. It is deep-imported as `@hyveon/shared/testing/secretFields` and kept out of the barrel.

## Test Seams

**`window.hyveon.__test`.** When `HYVEON_TEST_MODE=1` the preload attaches `mock(channel, handler)`, `clearMocks()` and `reset()` over the same `mockRegistry` that `invoke` and `createBufferedStream` consult (`preload.ts:654-684`); a non-function handler is wrapped to return the value (`preload.ts:183-185`).
A registered stream mock is called with `(arg, signal)` or `(signal)` and its `AsyncIterable` is yielded instead of touching IPC (`stream-bridge.ts:103-109`).
The production build never exposes `__test`, as `preload-bridge-naming` requires.

Because a stream mock short-circuits before any IPC, `streaming-handle-roundtrip.spec.ts` proves the handle survives the clone but not that a real main-process stream reaches the renderer.
`desktop-main/src/ipc-stream-roundtrip.test.ts` covers that: it loads the real preload bridge and the real `LogsController` over an in-process IPC bus that structured-clones every payload, reply and push, with no mock registered, and checks delivery, error text and cancellation for `logs.stream`.
The unmocked electron roundtrip in Playwright remains `env.get` (`electron-ipc-roundtrip.spec.ts`).

**One mock registry.** `window.hyveon.__test` over the per-channel `mockRegistry` in `preload.ts` is the only test-mode registry the preload ships.

**Build.** `desktop-preload/tsconfig.json` excludes `src/**/*.test.ts`, so the preload build emits no test files into `dist`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Operator transport | Electron IPC microservice only; no HTTP server | HTTP shim controllers over Express (previously present) | Required by APP-IPC-XPORT-001; CLAUDE.md invariant "The desktop app has no HTTP transport". IPC is reachable only from the app's own renderer, so there is no request-level auth to configure, and the HTTP shims carried an Express stack and bearer-token plumbing the desktop app has no use for. |
| Renderer global name | `window.hyveon`, `Hyveon*` types | `window.gsd` / `Gsd*` (pre-rebrand) | Names follow the rebrand (APP-IPC-NAME-001, APP-IPC-NAME-002). |
| Main-side dispatch | One generic `registerIpcMainBridges` loop over Nest's handler map | Per-controller `ipcMain.handle`; patching `nestjs-electron-ipc-transport` | Transport never calls `ipcMain.handle`, so channels hung (`ipc-main-bridge.ts:91-94`); subclass avoids `as unknown as` casts (`ipc-main-bridge.ts:39-48`). |
| Long-running channels | Self-bridged in their controllers, listed in `SELF_BRIDGED_PATTERNS` | Route through the generic bridge | Need `evt.sender` for side-channel pushes, and Nest drops the undecorated `ctx` for some handlers (`ipc-main-bridge.ts:11-22`). |
| Error shape across IPC | Plain `Error` with `.message` only, via a global RPC filter plus bridge rethrow | Let Nest's base filter run; structured error objects | Base filter yields "Internal server error" (`rpc-error-message.filter.ts:10-20`); raw SDK errors fail structured clone (`ipc-main-bridge.ts:98-106`). |
| Payload validation errors | `BadRequestException` with an object body, read through `ipcErrorMessage` | Plain `Error` at each throw site; `RpcException` | One extraction function covers `requireStringArray` and every inline `BadRequestException({ success: false, error })` throw, including on self-bridged channels where the filter never runs, without touching each call site. |
| Bridge surface construction | Static object literal of named methods | Proxy or generated surface | Only own-enumerable, statically named properties cross `contextBridge` (`preload.ts:45-48`, `stream-bridge.ts:9-11`). |
| Stream shape | Preload-internal generator wrapped in a plain `HyveonStreamHandle` | Return an `AsyncGenerator`; accept a renderer `AbortSignal` | Neither survives structured clone; the handle shape was "empirically verified" (`preload.ts:17-43`). |
| Two stream styles | Per-call channels for log tails; fixed shared channels with `streamId` filtering for IaC and update streams | One style for all | Per-call has a cancellable main-side loop. Shared-style work (stack initialization, update download) must not be aborted by closing a viewer, and the run-output tail ends with the run, so no cancel message exists for them. |
| Shared side-channel cancel | No cancel message from the preload; main-side work runs to completion | A `.cancel` message for the shared channels, as per-call streams have | Intentional narrowing of required behaviour (`APP-IPC-STREAM-009`): closing a viewer must not abort stack initialization or an update download, so the main side keeps running the shared work and the preload only stops its local drain loop. |
| Self-bridged registration | One `registerSelfBridgedHandlers` helper used by the four owning controllers | Nine hand-written `removeHandler` + `handle` blocks | The blocks had no error normalisation or logging; one helper gives the generic bridge's behaviour to every channel and removes the repeated guard. |
| Per-call stream start | Loop begins on a later macrotask than the ack (`setImmediate`) | Client-minted `streamId`; ready handshake from the preload | Electron delivers the invoke reply and later pushes in order, so deferring the first send past the reply's microtasks is enough and changes no contract. |
| Stream end error text | `ipcErrorMessage(err)` | `String(err)` | `String(err)` of an `Error` adds `Error: `, which invoke errors do not carry. |
| End-to-end stream test | Vitest over an in-process structured-cloning IPC bus, real preload + real controller | Playwright electron spec | Runs in the unit tier with no packaged app; it covers the preload/main protocol and serialization, while `streaming-handle-roundtrip.spec.ts` covers the `contextBridge` handle clone. |
| Preload `LogChunk` vs shared `LogChunk` | Keep distinct | Re-point the preload at the shared interface | They are different types: a streamed line versus the cloud provider's `{ message, timestamp }`; the name collision is not drift. |
| Single payload argument | Every write method passes one payload object | Positional arguments | The transport delivers only the first argument to `@Payload` (`preload.ts:426-428`). |
| Contract source | Hand-written `hyveon-api.ts` mirroring shared and controller types | Import from `@hyveon/shared`; generate from controllers | `[inferred]` keeps the preload free of main-process imports; cost is the drift recorded under "Contract and Types". |
| Test seam | Per-channel `mockRegistry` in preload, gated on `HYVEON_TEST_MODE=1` | Namespace-level `test-mock-registry.ts` (deleted: no consumer); Playwright IPC interception | `preload-bridge-naming` requires the `__test` seam under the bridge name and absent in production; the namespace registry had no consumer outside its own test, so shipping two registries only invited drift. |
| Channel-name guard | Reflect-metadata `expectChannels` per controller test | Shared channel-name constants used by both sides | Calling a method directly passes whatever string is registered (`message-pattern.test-utils.ts:4-9`); constants not chosen, reason unknown `[inferred]`. |
| Renderer facade | `api.service.ts` for nine namespaces; direct `window.hyveon` elsewhere | One facade for all namespaces | Unknown; appears to be incremental growth `[inferred]`. |
| Non-Electron behaviour | Bridge registration silently skipped when `process.versions.electron` is unset | Throw; inject a fake `ipcMain` | Lets the plain-Node integration harness and CI load controllers without `electron` (`ipc-main-bridge.ts:119-122`). |

## Open Questions & Future Decisions

### Resolved

- No FileBrowser credential reaches the renderer, so "Secrets never reach the renderer" has no exception: the `volumeFiles` namespace carries session state only, and helper credentials and addresses stay in the main process (HELPER-FB-008, HELPER-FB-009).

### Deferred

1. Should the remaining hand-mirrored preload types (the add-game wizard draft, which drifts from the shared `GameServer` by lacking `webPort` and `command`, and the other "Mirrors X" declarations in `hyveon-api.ts`) be derived from shared types, and `GameWizardDraft`'s drift that `api.service.ts` casts around be fixed with them?
2. Should all renderer callers move behind `api.service.ts`, now that the bridge-unavailable wording is one string?
3. Should `findSecretFields` also run against every IPC result in one generic test (for example over the integration harness), rather than only the volume-files results it guards today (`volume-files.controller.test.ts`, `VolumeFilesService.test.ts`)? Its IPv4 and `cert` patterns would also flag legitimate values such as a game's public IP, so a generic use needs an allowlist.
4. Fix the remaining stale doc comments: `preload.ts` "three generators" and `openBufferedStream`'s `@param` list, the `@hyveon/desktop-preload/hyveon-api` import path in `hyveon-api.ts` that the `exports` map does not provide, a preload invoke timeout that `electron-ipc-roundtrip.spec.ts` cites but does not exist, and "tfstate" wording in `hyveon-api.ts`.
5. The chromium e2e tier installs an HTTP-forwarding `window.hyveon` over a fictional `/api/*` map (`web/e2e/fixtures/hyveon-http-bridge.ts`), and renderer code carries guards that exist only for it (`app.component.tsx`). The spec keeps those five chromium specs for now; when they move to the electron project, can the shim and its guards go?

## References

- Arrow doc: `docs/arrows/operator-app/ipc-bridge.md`
- EARS specs: `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md`, prefix `APP-IPC`
- Docs: `docs/docs/components/management-app.md` (desktop-main bootstrap, controllers and IPC channels, `@hyveon/desktop-preload`), `docs/docs/components/integration-tests.md` (mock seams and test tiers), `docs/docs/architecture.md`
- Rules: `.claude/rules/logging.md`
- Neighbouring leaves: `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/infra-logs/infra-logs-design.md`, `docs/intent/iac/run/run-design.md`, `docs/intent/operator-app/app-update-and-release/app-update-and-release-design.md`, `docs/intent/operator-app/diagnostics/diagnostics-design.md`
