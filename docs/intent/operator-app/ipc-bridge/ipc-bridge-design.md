---
parent: operator-app
prefix: APP-IPC
---

# IPC Bridge

## Context and Design Philosophy

Hyveon's desktop app has exactly one way for the operator UI to reach the back end: the renderer calls a method on `window.hyveon`, the preload script turns that into `ipcRenderer.invoke(channel, payload)`, and the Electron main process answers it from a Nest `@MessagePattern` handler.
There is no HTTP server, no bearer token, no API base URL and no `fetch` anywhere in the path (`desktop-preload/src/preload.ts:1-15`, `openspec/specs/desktop-only-operator-surface/spec.md`, "Desktop-main exposes no HTTP transport").
This leaf owns that channel end to end: the shape of `window.hyveon`, how a call is dispatched on the main side, how an error crosses back, how a stream survives the `contextBridge` clone, and the test-mode seam that fakes the whole thing.

The renderer runs with `contextIsolation: true` and `sandbox: true` and gets the preload from `../preload/preload.cjs` (`desktop-main/src/electron-entry.ts:181-183`), so the preload is the only code with `ipcRenderer`, and only values that survive structured clone reach the page.
The design follows from that constraint: a plain object literal of statically named methods (`preload.ts:419-652`), errors flattened to a message string, and streams wrapped as plain handle objects (`preload.ts:17-51`).

What this leaf owns:

- **Renderer surface**: the `HyveonApi` contract (`desktop-preload/src/hyveon-api.ts:2651`), the `Window.hyveon` augmentation (`desktop-preload/src/index.ts:58-62`, pulled into web by `web/src/globals.d.ts:10`), the `api.*` facade (`web/src/api.service.ts:276`) and the bridge-unavailable strings (`web/src/lib/bridge.utils.ts:2,8`).
- **Preload**: the mock-aware `invoke` (`preload.ts:196-206`), the push `subscribe` helper (`preload.ts:216-220`), the five buffered streams (`stream-bridge.ts:91`, `preload.ts:229-350`), the stream handle wrapper (`preload.ts:369-392`) and `exposeInMainWorld('hyveon', …)` (`preload.ts:686`).
- **Main-to-renderer push**: `forwardToWindows` (`desktop-main/src/ipc-broadcast.ts:16-29`).
- **Main side**: `BridgedElectronIPCTransport` and `registerIpcMainBridges` (`desktop-main/src/ipc-main-bridge.ts:49,124`), the `SELF_BRIDGED_PATTERNS` skip list (`ipc-main-bridge.ts:27-37`), `RpcErrorMessageFilter` (`desktop-main/src/rpc-error-message.filter.ts:25`) and the payload guards in `controllers/validation.ts`.
- **Test seams**: `window.hyveon.__test` (`preload.ts:659-684`), `expectChannels` (`desktop-main/src/testing/message-pattern.test-utils.ts:18`), the secret-shape check `findSecretFields` / `expectNoSecretFields` (`shared/src/testing/secretFields.ts:29`, `desktop-main/src/testing/no-secret-fields.ts:10`) and the unused `test-mock-registry.ts`.

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

The intended rule is that whatever a handler throws, the renderer receives a plain `Error` whose `.message` is the handler's real message.
Two pieces make that true for generic-bridge channels, and neither runs for self-bridged ones.

**`RpcErrorMessageFilter`** is a global `@Catch()` filter (`rpc-error-message.filter.ts:25`, registered at `main.ts:49`).
Without it, Nest's `BaseRpcExceptionFilter` replaces any non-`RpcException` message with `'Internal server error'` (`rpc-error-message.filter.ts:10-20`).
The filter re-emits `new Error(errMessage(exception))` as an erroring Observable (`rpc-error-message.filter.ts:35-38`).

**The bridge `catch`** handles the two ways an error reaches it: a rejected promise, and a resolved Observable built by Nest's `RpcProxy` from `throwError(...)`, which `firstValueFrom` turns back into a rejection (`ipc-main-bridge.ts:108-117,141`).
It normalises the error to a message string, logs `ipc-main-bridge: handler for "<pattern>" failed` at `error` with the stack, and rethrows `new Error(message)` (`ipc-main-bridge.ts:142-153`).
The reason given is structured clone: a raw AWS SDK error with `$metadata` or symbol-keyed fields fails to marshal and the renderer sees "object could not be cloned" instead of the message (`ipc-main-bridge.ts:98-106`).

Where current behaviour differs from that intent:

- **`BadRequestException` bodies are lost.** `requireStringArray` throws `new BadRequestException({ success: false, error: '<field> must be an array of strings' })` (`validation.ts:21-24`). For an object-body `HttpException`, Nest sets `.message` to the class-derived `"Bad Request Exception"`, and the filter reads only `.message`, so the field error never reaches the renderer. Several controllers throw the same shape inline, for example `iac-runs.controller.ts:213-216,265-268`.
- **Self-bridged channels bypass both normalisers.** They call the controller method directly (`iac.controller.ts:577-579` and the rest of the table above), so neither the filter nor the bridge `catch` runs, and nothing logs the failure at the bridge. A throw before the ack, such as the `BadRequestException` at `iac-runs.controller.ts:265-268`, rejects straight into Electron's `ipcMain.handle`; what the renderer then sees depends on Electron's own error serialisation `[inferred]`.
- **Two comments describe a different system.** `ipc-main-bridge.ts:99-100` says the app has "no NestJS exception filter anywhere" while the same comment (`:117`) and `main.ts:49` rely on one. `validation.ts:14-16` says Nest maps the exception to "a 400 with the same shape the legacy Express handlers used"; there is no HTTP and no 400.

Stream failures use a different path: the main side sends `{ error: String(err) }` on the end channel (`logs.controller.ts:186`, `iac-runs.controller.ts:295`), and the preload throws `new Error(endError)` from the generator (`stream-bridge.ts:195,242`).
Because `String(err)` of an `Error` is `"Error: <message>"`, stream errors reach the renderer with an extra `Error: ` prefix that invoke errors do not carry.

## Streaming Across the Context Bridge

`contextBridge` structured-clones every value; a raw `AsyncGenerator` throws "An object could not be cloned" when returned, and an `AbortSignal` arrives as an inert object with no prototype methods (`preload.ts:17-26`).
Every streaming channel is therefore two layers (`preload.ts:26-44`):

- A preload-internal `async function*` built by `createBufferedStream` (`stream-bridge.ts:91`), which owns the IPC listeners and accepts a real `AbortSignal`.
- A bridge-facing `open*Stream` wrapper that mints an `AbortController` inside preload and returns a `HyveonStreamHandle`: a plain object with own `next`, `cancel` and `[Symbol.asyncIterator]` returning itself (`preload.ts:369-392`, `hyveon-api.ts:186`). The renderer can `for await` over it directly.

| Renderer method | Invoke channel | Style | Chunk / end channels | Cancel reaches main? |
|---|---|---|---|---|
| `logs.stream(game)` | `logs.stream` | per-call | `logs.stream.<id>.chunk` / `.end` | Yes, `logs.stream.<id>.cancel` (`preload.ts:229-239`) |
| `logs.lambda.stream(key)` | `logs.lambda.stream` | per-call | `logs.lambda.stream.<id>.chunk` / `.end` | Yes, `.cancel` (`preload.ts:248-258`) |
| `iac.stack.initialize()` | `iac.stack.initialize` | shared | fixed `iac.stack.initialize.chunk` / `.end` | No (`preload.ts:278-292`) |
| `iac.settings.autoUpdateDownload()` | `iac.settings.autoUpdate.download` | shared | fixed `….download.chunk` / `.end` | No (`preload.ts:307-322`) |
| `iac.runs.logs(runId)` | `iac.runs.logs` | shared | fixed `iac.runs.logs.chunk` / `.end` | No (`preload.ts:339-350`) |

**Per-call style.** The invoke ack carries a `streamId` minted by the controller (`logs.controller.ts:151`); the preload derives unique chunk/end/cancel channel names from it and attaches listeners after the ack resolves (`stream-bridge.ts:212-230`).
Abort sends the cancel message; leaving the loop early also sends it from `finally` (`stream-bridge.ts:216,227,253-255`).
On the main side, a one-shot `ipcMain.once(cancelChannel)` aborts the source, the fire-and-forget loop pushes each line with `sender.send`, and the cancel listener is removed when the loop ends (`logs.controller.ts:162-194`).
The main loop starts before the ack is returned (`logs.controller.ts:170-196`) while the preload attaches its listeners only after receiving the ack, so a chunk or immediate error `end` sent in between would be dropped and the iteration would hang `[inferred]`; this has not been reproduced.

**Shared side-channel style.** Chunk and end channels are fixed constants shared by every concurrent call, so the preload attaches listeners before invoking, buffers raw events until the ack reveals its own `streamId`, then replays and filters out foreign ids (`stream-bridge.ts:126-201`).
The end listener uses `.on` rather than `.once` because another call's end can arrive first (`stream-bridge.ts:165-169`).
`iac.stack.initialize` acks `{ started: false, error }` when the shared workspace is busy, and `checkAck` throws immediately (`preload.ts:273-289`).
Abort only stops the local drain loop (`stream-bridge.ts:24-26,160-163`); there is no cancel message, and the main side of `iac.runs.logs` aborts only when the `WebContents` is destroyed (`iac-runs.controller.ts:273-276`).
This diverges from the `desktop-only-operator-surface` scenario "Cancellation stops the stream", which says the main process tears the stream down when the renderer abandons it, and from `HyveonStreamHandle.cancel`'s own doc, which hedges with "where applicable" (`hyveon-api.ts:198-205`).

## Contract and Types

`hyveon-api.ts` (2,698 lines) is the full hand-written contract: `HyveonApi` (`:2651`), `HyveonTestApi` (`:2608`), `HyveonStreamHandle` (`:186`) and the payload/result types of every namespace.
`index.ts` re-exports those types and `GUIDED_PROFILE_NAME`, and is the single declaration of `Window.hyveon?: HyveonApi` (`index.ts:1-62`), satisfying `openspec/specs/preload-bridge-naming/spec.md`.
The global is optional because the bridge is absent in a plain browser (`web/src/globals.d.ts:1-9`).

The contract is mirrored rather than derived.
Some types come from `@hyveon/shared`, but many are re-declared and have drifted: `GameServerPort` lacks `visibility` (`hyveon-api.ts:289-292` vs `shared/src/gameServerConfig.ts:50`), `GameServer` lacks `webPort` and `command` (`hyveon-api.ts:418-432` vs `gameServerConfig.ts:243,254`), and `LogChunk` is `string` here (`hyveon-api.ts:157`) but an interface in `shared/src/cloud.ts:26`.
The redacted Discord config is declared in `shared/src/types.ts:47`, `hyveon-api.ts:231-242` and `api.service.ts:225`, and `GUIDED_PROFILE_NAME` is duplicated with `GuidedIamService.ts:94`.
Nothing type-checks the preload contract against controller return types; the channel string is the only checked link (`message-pattern.test-utils.ts`).

**Renderer facades.** `api.service.ts` wraps nine namespaces (games, costs, folderUpload, volumeFiles, discord, diagnostics, drift, audit, cloudHealth) behind `hyveon()`, which throws a descriptive error when the bridge is missing; every method is `async` so that throw surfaces as a rejection (`api.service.ts:252-276`).
The rest of the renderer, including all of `iac.*`, `logs.*`, `wizard.*` and `window.*`, calls `window.hyveon` directly and uses the `BRIDGE_UNAVAILABLE` / `SETTINGS_BRIDGE_UNAVAILABLE` strings (`bridge.utils.ts:1-8`), giving three wordings for one condition.

**Secrets.** Discord and health-check secrets cross only as set/unset booleans (`hyveon-api.ts:238-239`).
No channel returns a helper credential any more: the `files` namespace and its one-time FileBrowser credential (`FileMgrCredentials`) were removed from `hyveon-api.ts`, `preload.ts` and `api.service.ts`, and the `volumeFiles` namespace returns only session state, listings, text content, transfer ids and `VolumeResult` codes (`hyveon-api.ts:1570`, `preload.ts:488-526`).
The guarantee is proven by tests, not checked at runtime: `findSecretFields` matches keys and string values against one credential/token/cert/fingerprint/URL/IPv4 pattern (`shared/src/testing/secretFields.ts:2,29-33`) and is shared by the vitest wrapper `expectNoSecretFields` and the Playwright volume-files specs. It is deep-imported as `@hyveon/shared/testing/secretFields` and kept out of the barrel.

## Test Seams

**`window.hyveon.__test`.** When `HYVEON_TEST_MODE=1` the preload attaches `mock(channel, handler)`, `clearMocks()` and `reset()` over the same `mockRegistry` that `invoke` and `createBufferedStream` consult (`preload.ts:654-684`); a non-function handler is wrapped to return the value (`preload.ts:183-185`).
A registered stream mock is called with `(arg, signal)` or `(signal)` and its `AsyncIterable` is yielded instead of touching IPC (`stream-bridge.ts:103-109`).
The production build never exposes `__test`, as `preload-bridge-naming` requires.

Because a stream mock short-circuits before any IPC, `streaming-handle-roundtrip.spec.ts` proves the handle survives the clone but not that a real main-process stream reaches the renderer: every case registers a mock first (`streaming-handle-roundtrip.spec.ts:43,86,137,192`).
The only unmocked electron roundtrip is `env.get` (`electron-ipc-roundtrip.spec.ts:21`), so the spec scenario "A test guards the real bridge boundary ... with no mock registered" is not met.

**`test-mock-registry.ts`.** Exports namespace-level `register` / `lookup` / `clear` / `buildMockHyveon` at `@hyveon/desktop-preload/test-mock-registry` and says `@hyveon/web` tests use it (`test-mock-registry.ts:9-11`); the only references are its own test.

**Build.** `desktop-preload/tsconfig.json` includes `src/**/*` and excludes only `dist` and `node_modules`, so the two preload test files are emitted into `dist`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Operator transport | Electron IPC microservice only; no HTTP server | HTTP shim controllers over Express (previously present) | Spec'd in `openspec/specs/desktop-only-operator-surface/spec.md`; CLAUDE.md invariant "The desktop app has no HTTP transport". |
| Renderer global name | `window.hyveon`, `Hyveon*` types | `window.gsd` / `Gsd*` (pre-rebrand) | `openspec/specs/preload-bridge-naming/spec.md` Purpose: names follow the rebrand. |
| Main-side dispatch | One generic `registerIpcMainBridges` loop over Nest's handler map | Per-controller `ipcMain.handle`; patching `nestjs-electron-ipc-transport` | Transport never calls `ipcMain.handle`, so channels hung (`ipc-main-bridge.ts:91-94`); subclass avoids `as unknown as` casts (`ipc-main-bridge.ts:39-48`). |
| Long-running channels | Self-bridged in their controllers, listed in `SELF_BRIDGED_PATTERNS` | Route through the generic bridge | Need `evt.sender` for side-channel pushes, and Nest drops the undecorated `ctx` for some handlers (`ipc-main-bridge.ts:11-22`). |
| Error shape across IPC | Plain `Error` with `.message` only, via a global RPC filter plus bridge rethrow | Let Nest's base filter run; structured error objects | Base filter yields "Internal server error" (`rpc-error-message.filter.ts:10-20`); raw SDK errors fail structured clone (`ipc-main-bridge.ts:98-106`). |
| Payload validation errors | `BadRequestException` with an object body | Plain `Error`; `RpcException` | Carried over from the Express-era handlers per `validation.ts:14-16` `[inferred]`; it no longer produces the intended message (see Deferred). |
| Bridge surface construction | Static object literal of named methods | Proxy or generated surface | Only own-enumerable, statically named properties cross `contextBridge` (`preload.ts:45-48`, `stream-bridge.ts:9-11`). |
| Stream shape | Preload-internal generator wrapped in a plain `HyveonStreamHandle` | Return an `AsyncGenerator`; accept a renderer `AbortSignal` | Neither survives structured clone; the handle shape was "empirically verified" (`preload.ts:17-43`). |
| Two stream styles | Per-call channels for log tails; fixed shared channels with `streamId` filtering for IaC and update streams | One style for all | Per-call needs a main-side loop to cancel; shared style assumes "no per-call main-process run to tear down early" (`stream-bridge.ts:15-26`). The assumption does not hold for `iac.runs.logs` `[inferred]`. |
| Single payload argument | Every write method passes one payload object | Positional arguments | The transport delivers only the first argument to `@Payload` (`preload.ts:426-428`). |
| Contract source | Hand-written `hyveon-api.ts` mirroring shared and controller types | Import from `@hyveon/shared`; generate from controllers | `[inferred]` keeps the preload free of main-process imports; cost is the drift recorded under "Contract and Types". |
| Test seam | Per-channel `mockRegistry` in preload, gated on `HYVEON_TEST_MODE=1` | Namespace-level `test-mock-registry.ts`; Playwright IPC interception | `preload-bridge-naming` requires the `__test` seam under the bridge name and absent in production; why the namespace registry was abandoned is unknown. |
| Channel-name guard | Reflect-metadata `expectChannels` per controller test | Shared channel-name constants used by both sides | Calling a method directly passes whatever string is registered (`message-pattern.test-utils.ts:4-9`); constants not chosen, reason unknown `[inferred]`. |
| Renderer facade | `api.service.ts` for nine namespaces; direct `window.hyveon` elsewhere | One facade for all namespaces | Unknown; appears to be incremental growth `[inferred]`. |
| Non-Electron behaviour | Bridge registration silently skipped when `process.versions.electron` is unset | Throw; inject a fake `ipcMain` | Lets the plain-Node integration harness and CI load controllers without `electron` (`ipc-main-bridge.ts:119-122`). |

## Open Questions & Future Decisions

### Resolved

- The one-time FileBrowser credential exception to "Secrets never reach the renderer" is gone: `embed-file-browser` (archived `openspec/changes/archive/2026-10-30-embed-file-browser/`) replaced the `files` namespace with `volumeFiles`, and `game-volume-file-browser` requires helper credentials and addresses to stay in the main process.

### Deferred

1. Should `requireStringArray` and the inline `BadRequestException({ success: false, error })` throws reach the renderer with their field message, by throwing a plain `Error` or by teaching `RpcErrorMessageFilter` to read `getResponse()`? Today the operator sees "Bad Request Exception" (`validation.ts:21-24`, `rpc-error-message.filter.ts:36`, `iac-runs.controller.ts:213-216`).
2. Should self-bridged registrations go through one shared helper that applies the same normalisation and logging as the generic bridge, replacing nine hand-written blocks (`iac.controller.ts:576-614`, `logs.controller.ts:43-50`, `iac-runs.controller.ts:182-185`, `iac-settings.controller.ts:116-119`)?
3. Should shared side-channel streams get a main-side cancel, or should the "Cancellation stops the stream" scenario be narrowed to the per-call style (`stream-bridge.ts:24-26`, `iac-runs.controller.ts:273-276`)?
4. Does Electron's ordering guarantee that per-call chunks sent before the invoke reply are delivered after it, or is the listener-after-ack window real (`stream-bridge.ts:212-230`, `logs.controller.ts:170-196`)?
5. Which test should drive a streaming channel end to end with no mock, to satisfy "A test guards the real bridge boundary" (`streaming-handle-roundtrip.spec.ts:43`, `electron-ipc-roundtrip.spec.ts:21`)? `logs.lambda.stream` and `iac.settings.autoUpdate.download` are not driven at all.
6. Should preload types be imported from `@hyveon/shared` wherever a shared type exists, starting with `GameServerPort`, `GameServer`, `RedactedDiscordConfig` and `LogChunk` (`hyveon-api.ts:157,231-242,289-292,418-432`), and should `GameWizardDraft`'s drift that `api.service.ts:357` casts around be fixed with them (`hyveon-api.ts:650-679`)?
7. Should stream end errors drop the `Error: ` prefix that `String(err)` adds (`logs.controller.ts:186`, `iac-runs.controller.ts:295`)?
8. Should all renderer callers move behind `api.service.ts`, and should the three bridge-unavailable wordings collapse to one (`api.service.ts:260-261`, `bridge.utils.ts:2,8`)?
9. Delete or adopt `test-mock-registry.ts` (`test-mock-registry.ts:9-11`), and exclude `*.test.ts` from `desktop-preload/tsconfig.json`?
10. Add skip-case tests for `logs.lambda.stream`, `iac.apply`, `iac.destroy` and `iac.runs.logs` in `ipc-main-bridge.test.ts`, or derive `SELF_BRIDGED_PATTERNS` from the controllers so it cannot drift (`ipc-main-bridge.ts:27-37`)?
11. Should `findSecretFields` also run against every IPC result in one generic test (for example over the integration harness), rather than only the volume-files results it guards today (`volume-files.controller.test.ts:292`, `VolumeFilesService.test.ts:526,553,649`)? Its IPv4 and `cert` patterns would also flag legitimate values such as a game's public IP, so a generic use needs an allowlist.
12. Fix the stale comments: `ipc-main-bridge.ts:99-100` ("no NestJS exception filter anywhere"), `validation.ts:14-16` ("legacy Express 400"), `stream-bridge.ts:7-13,80` (four calls, actually five), `preload.ts:362` ("three generators"), `preload.ts:383` (omits `streamUpdateDownload`), `hyveon-api.ts:2645` (import path not in the `exports` map), `electron-ipc-roundtrip.spec.ts:10-12` (a preload invoke timeout that does not exist), and "tfstate" wording in `hyveon-api.ts:464-478,697-716,2143,2668`.
13. The chromium e2e tier installs an HTTP-forwarding `window.hyveon` over a fictional `/api/*` map (`web/e2e/fixtures/hyveon-http-bridge.ts:44`), and renderer code carries guards that exist only for it (`app.component.tsx:34-43`). The spec keeps those five chromium specs for now; when they move to the electron project, can the shim and its guards go?
14. `openspec/specs/preload-bridge-naming/spec.md:16` still lists a `files` namespace, which the bridge no longer has (`preload.ts:419-652`), and omits `folderUpload` and `volumeFiles`. Update the scenario through an OpenSpec change?

## References

- Arrow doc: `docs/arrows/operator-app/ipc-bridge.md`
- EARS specs: `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md`, prefix `APP-IPC`
- OpenSpec: `openspec/specs/preload-bridge-naming/spec.md`; `openspec/specs/desktop-only-operator-surface/spec.md` (requirements "Desktop-main exposes no HTTP transport", "Test harnesses do not depend on the removed HTTP surface", "Streamed IPC channels work across the context bridge")
- Docs: `docs/docs/components/management-app.md` (desktop-main bootstrap, controllers and IPC channels, `@hyveon/desktop-preload`), `docs/docs/components/integration-tests.md` (mock seams and test tiers), `docs/docs/architecture.md`
- Rules: `.claude/rules/logging.md`
- Neighbouring leaves: `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/infra-logs/infra-logs-design.md`, `docs/intent/iac/run/run-design.md`, `docs/intent/operator-app/app-update-and-release/app-update-and-release-design.md`, `docs/intent/operator-app/diagnostics/diagnostics-design.md`
