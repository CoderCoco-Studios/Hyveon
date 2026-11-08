# Arrow: ipc-bridge

The typed, secret-free channel between the window and the back end: the `window.hyveon` surface the renderer calls, the main-process side that answers it, how errors cross it, and the test seam that fakes it.

## Status

**MAPPED** — mapped 2026-10-30 (SHA `5c55a380`), gap specs closed since.
Working transport with one generic bridge plus nine self-bridged streaming channels that share one error-normalisation helper; error text, stream ordering and the shared-type contract for game ports, games and the redacted Discord config are specified and tested. Remaining hand-mirrored preload types are tracked in the design doc's deferred questions.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`

### EARS
- `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md` (67 specs)

### Tests
- `app/packages/desktop-main/src/ipc-broadcast.test.ts`
- `app/packages/desktop-main/src/ipc-main-bridge.test.ts`
- `app/packages/desktop-main/src/rpc-error-message.filter.test.ts`
- `app/packages/desktop-preload/src/preload.test.ts`
- `app/packages/desktop-main/src/ipc-handlers.test.ts`
- `app/packages/desktop-main/src/ipc-stream-roundtrip.test.ts`
- `app/packages/shared/src/testing/secretFields.test.ts`
- `app/packages/web/e2e/specs/electron-ipc-roundtrip.spec.ts`
- `app/packages/web/e2e/specs/ipc-mock.spec.ts`
- `app/packages/web/e2e/specs/streaming-handle-roundtrip.spec.ts`
- `app/packages/web/src/api.service.test.ts`

### Code

**desktop-main**
- `app/packages/desktop-main/src/ipc-main-bridge.ts`
- `app/packages/desktop-main/src/ipc-broadcast.ts`
- `app/packages/desktop-main/src/ipc-handlers.ts`
- `app/packages/desktop-main/src/rpc-error-message.filter.ts`
- `app/packages/desktop-main/src/controllers/validation.ts`
- `app/packages/desktop-main/src/testing/message-pattern.test-utils.ts`
- `app/packages/desktop-main/src/testing/no-secret-fields.ts`

**shared**
- `app/packages/shared/src/testing/secretFields.ts` (deep import `@hyveon/shared/testing/secretFields`, absent from the barrel)

**desktop-preload**
- `app/packages/desktop-preload/package.json`
- `app/packages/desktop-preload/tsconfig.json`
- `app/packages/desktop-preload/src/preload.ts`
- `app/packages/desktop-preload/src/stream-bridge.ts`
- `app/packages/desktop-preload/src/hyveon-api.ts`
- `app/packages/desktop-preload/src/index.ts`

**web**
- `app/packages/web/src/api.service.ts`
- `app/packages/web/src/globals.d.ts`
- `app/packages/web/src/window.d.ts`
- `app/packages/web/src/lib/bridge.utils.ts`

### Cited from other leaves
- `app/packages/desktop-main/src/main.ts` (desktop-shell): creates the `BridgedElectronIPCTransport`, registers `RpcErrorMessageFilter`, then calls `registerIpcMainBridges` (`main.ts:43-56`).
- `app/packages/desktop-main/src/electron-entry.ts` (desktop-shell): logs the `HYVEON_TEST_MODE` seam (`electron-entry.ts:214`).
- `app/packages/desktop-main/src/app.module.ts` (desktop-shell): the Nest module tree the bridge dispatches into.
- `app/packages/web/src/app.component.tsx` (desktop-shell): first-run gate that tolerates a missing `window.hyveon.wizard` for the chromium tier (`app.component.tsx:34-43`).
- `app/packages/web/e2e/specs/electron-smoke.spec.ts` (desktop-shell): asserts `window.hyveon` is defined.
- Self-bridged streaming controllers: `logs.controller.ts:40-52` (infra-logs), `iac.controller.ts:568-615`, `iac-runs.controller.ts:183` (iac/run), `iac-settings.controller.ts:116-119` (file owned by deployment-config; the `iac.settings.autoUpdate.download` registration is app-update-and-release's and moves to a controller that leaf owns).
- `app/packages/web/e2e/integration-specs/error-propagation.spec.ts` (`game-runtime/task-and-dns`): asserts RunTask and not-deployed errors surface as `{success:false, message}` across the bridge.
- `requireStringArray` consumers: `discord.controller.ts:159-194` (discord-bot), `folder-upload.controller.ts:146` (helper-task).
- Test harness (unmapped shared harness): `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (chromium-tier `window.hyveon` shim backing the no-HTTP invariant's test half), `app/packages/web/e2e/fixtures/electron-mock.ts` and `electron-launch.ts` (mock seam), `app/packages/web/e2e/fixtures/ipc-harness.ts` (integration tier).
- `app/packages/shared/src/errors.ts:82` (`errMessage`), `app/packages/shared/src/types.ts:47` (`RedactedDiscordConfig`).
- `helper-task`: `app/packages/desktop-main/src/controllers/volume-files.controller.ts` (the only `forwardToWindows` caller, `:105-106`), `app/packages/shared/src/volumeFiles/types.ts` (`VOLUME_FILES_SESSION_CHANNEL` / `VOLUME_FILES_TRANSFER_CHANNEL`, `:96-99`, and the `Volume*` result types the `volumeFiles` namespace carries), and the volume-files tests that call `expectNoSecretFields` / `findSecretFields` (`volume-files.controller.test.ts:292`, `VolumeFilesService.test.ts:526,553,649`, `web/e2e/specs/volume-files*.spec.ts`).

## Architecture

**Purpose:** Give the renderer one typed `window.hyveon` object whose every method crosses Electron's `contextBridge` to an `ipcMain.handle` registration that dispatches into a Nest `@MessagePattern` handler, with errors normalised to a plain cloneable `Error`, streams wrapped so they survive structured clone, no HTTP transport anywhere, and a test-mode mock seam.

**Key Components:**
1. `preload.ts`: builds the `HyveonApi` object literal (`preload.ts:419-652`) over a mock-aware `invoke` (`preload.ts:192-202`) and exposes it with `contextBridge.exposeInMainWorld('hyveon', …)` (`preload.ts:686`); attaches `__test.mock/clearMocks/reset` only when `HYVEON_TEST_MODE=1` (`preload.ts:659-684`).
2. `stream-bridge.ts`: `createBufferedStream` (`stream-bridge.ts:91`), the shared generator factory for the two stream styles: per-call channels with a `.cancel` message (`logs.stream`, `logs.lambda.stream`) and fixed shared side channels filtered by `streamId` (`iac.stack.initialize`, `iac.runs.logs`, `iac.settings.autoUpdate.download`).
3. `bridgeStream` / `openBufferedStream` (`preload.ts:369-392`): wrap each internal generator in a plain `HyveonStreamHandle` (`next`, `cancel`, `[Symbol.asyncIterator]`) so it survives the clone boundary.
4. `hyveon-api.ts`: the full hand-written IPC contract (`HyveonApi`, `HyveonTestApi`, ~2,700 lines, 142 "Mirrors / keep in sync" markers) plus `GUIDED_PROFILE_NAME` (`hyveon-api.ts:2107`).
5. `index.ts`: type-only barrel and the single `declare global { interface Window { hyveon?: HyveonApi } }` (`index.ts:58-62`); `app/packages/web/src/globals.d.ts:10` pulls it in by side-effect import.
6. `ipc-main-bridge.ts`: `BridgedElectronIPCTransport` (`:49`) exposes Nest's protected handler map; `registerIpcMainBridges` (`:124`) puts every pattern not in `SELF_BRIDGED_PATTERNS` (`:27-37`) onto `ipcMain.handle`, unwraps Observable rejections, and rethrows `new Error(message)` (`:138-155`).
7. `rpc-error-message.filter.ts`: global `@Catch()` filter (`:25`) that replaces Nest's "Internal server error" with `errMessage(exception)`; registered at `main.ts:49`.
8. `validation.ts`: `isNonEmptyString` and `requireStringArray` (`:18`), the payload guards controllers throw `BadRequestException` from.
9. `api.service.ts`: renderer `api.*` facade (`:276`) over a throwing `hyveon()` accessor (`:257-265`) for games, costs, folderUpload, volumeFiles, discord, diagnostics, drift, audit, cloudHealth; declares web-only DTOs.
10. `bridge.utils.ts`: `BRIDGE_UNAVAILABLE` / `SETTINGS_BRIDGE_UNAVAILABLE` strings for direct `window.hyveon` callers.
11. `message-pattern.test-utils.ts`: `expectChannels` (`:18`), the reflect-metadata guard that a controller method's `@MessagePattern` string is the channel the preload calls; used in 17 test files.
12. `ipc-handlers.ts`: `ipcErrorMessage` (one message extractor that reads `HttpException` bodies), `toIpcError` (log and plain-`Error` normalisation) and `registerSelfBridgedHandlers` (the single registration path for the nine self-bridged channels).
13. `ipc-broadcast.ts`: `forwardToWindows` (`:16-29`), the main-to-renderer push helper that subscribes to an event source and `webContents.send`s each event to every non-destroyed window; returns `null` without subscribing outside Electron. The preload side is one `subscribe` helper (`preload.ts:216-220`) shared by all four push subscriptions.
14. `secretFields.ts` + `no-secret-fields.ts`: `findSecretFields` (`shared/src/testing/secretFields.ts:29-33`) walks a payload for keys or string values matching a credential/token/cert/fingerprint/URL/IPv4 pattern (`:2`); `expectNoSecretFields` (`desktop-main/src/testing/no-secret-fields.ts:10-12`) is its vitest wrapper. Test-only enforcement of the secret-free bridge for helper results.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Bridge naming (NAME) | `APP-IPC-NAME-001` to `APP-IPC-NAME-007` | 7 | 0 | 0 |
| No HTTP transport (XPORT) | `APP-IPC-XPORT-001` to `APP-IPC-XPORT-006` | 6 | 0 | 0 |
| Request/response dispatch (CALL) | `APP-IPC-CALL-001` to `APP-IPC-CALL-013` | 13 | 0 | 0 |
| Error path (ERR) | `APP-IPC-ERR-001` to `APP-IPC-ERR-008` | 8 | 0 | 0 |
| Streaming across the context bridge (STREAM) | `APP-IPC-STREAM-001` to `APP-IPC-STREAM-015` | 15 | 0 | 0 |
| Contract and types (CONTRACT) | `APP-IPC-CONTRACT-001` to `APP-IPC-CONTRACT-004` | 4 | 0 | 0 |
| Secrets (SEC) | `APP-IPC-SEC-001` to `APP-IPC-SEC-003` | 3 | 0 | 0 |
| Test-mode mock seam (SEAM) | `APP-IPC-SEAM-001` to `APP-IPC-SEAM-007` | 7 | 0 | 0 |
| Test harnesses without HTTP (HARN) | `APP-IPC-HARN-001` to `APP-IPC-HARN-004` | 4 | 0 | 0 |

**Summary:** 67 of 67 active specs implemented; 0 deferred; 0 gaps.

## Key Findings

1. **One message path for every failure**: `ipcErrorMessage` (`desktop-main/src/ipc-handlers.ts`) reads `HttpException` bodies, so `requireStringArray` and inline `BadRequestException({ success: false, error })` throws reach the renderer with their field text. `RpcErrorMessageFilter`, the generic bridge and every self-bridged channel use it.
2. **Self-bridged channels share one registration helper**: `registerSelfBridgedHandlers` registers all nine `SELF_BRIDGED_PATTERNS` from the four owning controllers' `onModuleInit` and applies the generic bridge's log-and-rethrow-plain-`Error` normalisation.
3. **Shared side-channel streams are not cancelled from the renderer, by design**: abandoning `iac.stack.initialize`, `iac.runs.logs` or `iac.settings.autoUpdate.download` stops only the local drain loop; provisioning and the download run to completion and the run-output tail ends with the run.
4. **Per-call streams cannot lose early events**: `LogsController.openStream` starts its loop on a later macrotask than the ack.
5. **Streaming is tested without a mock**: `ipc-stream-roundtrip.test.ts` drives the real preload bridge against the real `LogsController` over a structured-cloning in-process bus. The Playwright `streaming-handle-roundtrip.spec.ts` still registers a mock for every case and proves only that the handle survives `contextBridge`.
6. **Contract drift is partly closed**: `GameServerPort`, `GameServer` and `RedactedDiscordConfig` come from `@hyveon/shared` (the Discord config adds the bridge-only `interactionsEndpointUrl`). `GameWizardDraft` and the other "Mirrors X" declarations in `hyveon-api.ts` remain hand-mirrored. The preload `LogChunk` (a line) is a different type from the shared `LogChunk` and is not a mirror.
7. **Two IPC facades in the renderer**: `api.service.ts` wraps nine namespaces; about 26 non-test renderer files reach `window.hyveon` directly. Both report a missing bridge with the single `BRIDGE_UNAVAILABLE` string.
8. **One preload test-mock registry**: the per-channel `mockRegistry` behind `window.hyveon.__test`; the unused namespace registry is gone, and the preload build excludes `*.test.ts`.
9. **`SELF_BRIDGED_PATTERNS` is a hand-synced list**: it must match each controller's registration. `ipc-main-bridge.test.ts` skips-tests every entry by iterating the set.
10. **Remaining stale doc comments**: `preload.ts` "three generators" and `openBufferedStream`'s `@param` list, the `@hyveon/desktop-preload/hyveon-api` import path in `hyveon-api.ts`, a preload invoke timeout cited by `electron-ipc-roundtrip.spec.ts`, and "tfstate" wording in `hyveon-api.ts`.
11. **Secrets-to-renderer invariant now holds without exception**: Discord and health-check secrets cross only as `botTokenSet` / `publicKeySet` / `secretSet` booleans (`hyveon-api.ts:238-239`). The former `files` namespace, whose `files.start` returned plaintext FileBrowser credentials for one-time display, is gone from `preload.ts`, `hyveon-api.ts` and `api.service.ts`; its replacement `volumeFiles` (`hyveon-api.ts:1570`, `preload.ts:488-526`) returns only session state, listings, text content and transfer ids. The guarantee is enforced by tests only (`expectNoSecretFields` / `findSecretFields`, a regex over keys and string values, `secretFields.ts:2`), not by a runtime check at the bridge.
12. **Chromium tier fakes `window.hyveon` over a fictional `/api/*` map**: `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts:44` installs an HTTP-forwarding `window.hyveon`; renderer code carries guards that exist only for that stub (`app.component.tsx:34-43`). Consistent with the spec, which keeps the five chromium specs on this shim.
13. **Dropped files reach main as paths resolved in preload**: `volumeFiles.uploadDropped` maps each renderer `File` through `webUtils.getPathForFile` inside preload (`preload.ts:513-521`) so the renderer never handles local path strings, and the push channel names are string literals in preload because the sandboxed preload cannot load `@hyveon/shared/volumeFiles` at runtime (`preload.ts:143-148`); `preload.test.ts:340-341` pins them to the shared constants.

## Work Required

No open gap specs. Items without a spec:

1. Derive the remaining hand-mirrored preload types from shared types where a shared type exists (`GameWizardDraft` and the other "Mirrors X" declarations).
2. Decide whether direct `window.hyveon` callers should move behind `api.service.ts`.
3. Sweep the stale doc comments in finding 10.
4. Remove the chromium-tier `window.hyveon` shim and its guards once those specs move to the electron project.
