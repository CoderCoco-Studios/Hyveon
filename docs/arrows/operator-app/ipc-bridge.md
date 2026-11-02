# Arrow: ipc-bridge

The typed, secret-free channel between the window and the back end: the `window.hyveon` surface the renderer calls, the main-process side that answers it, how errors cross it, and the test seam that fakes it.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Working transport with one generic bridge plus nine self-bridged streaming channels; its contract is hand-mirrored in three places and has drifted, and two error paths (BadRequest bodies, self-bridged channels) do not behave the way the comments claim.

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
- `app/packages/desktop-preload/src/test-mock-registry.test.ts`
- `app/packages/shared/src/testing/secretFields.test.ts`
- `app/packages/web/e2e/specs/electron-ipc-roundtrip.spec.ts`
- `app/packages/web/e2e/specs/ipc-mock.spec.ts`
- `app/packages/web/e2e/specs/streaming-handle-roundtrip.spec.ts`
- `app/packages/web/src/api.service.test.ts`

### Code

**desktop-main**
- `app/packages/desktop-main/src/ipc-main-bridge.ts`
- `app/packages/desktop-main/src/ipc-broadcast.ts`
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
- `app/packages/desktop-preload/src/test-mock-registry.ts`

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
12. `test-mock-registry.ts`: namespace-level `register/lookup/clear/buildMockHyveon` (`:44-77`), exported at `@hyveon/desktop-preload/test-mock-registry`.
13. `ipc-broadcast.ts`: `forwardToWindows` (`:16-29`), the main-to-renderer push helper that subscribes to an event source and `webContents.send`s each event to every non-destroyed window; returns `null` without subscribing outside Electron. The preload side is one `subscribe` helper (`preload.ts:216-220`) shared by all four push subscriptions.
14. `secretFields.ts` + `no-secret-fields.ts`: `findSecretFields` (`shared/src/testing/secretFields.ts:29-33`) walks a payload for keys or string values matching a credential/token/cert/fingerprint/URL/IPv4 pattern (`:2`); `expectNoSecretFields` (`desktop-main/src/testing/no-secret-fields.ts:10-12`) is its vitest wrapper. Test-only enforcement of the secret-free bridge for helper results.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `preload-bridge-naming` | 3 | 3 | Implemented: `exposeInMainWorld('hyveon', …)` (`preload.ts:686`), `Hyveon*` type names (`index.ts:1-4`), `globals.d.ts` side-effect import, `__test` gated on `HYVEON_TEST_MODE`. The bridge exposes `folderUpload` and `volumeFiles` and no `files` namespace (APP-IPC-NAME-003). |
| `desktop-only-operator-surface` (transport half) | 3 of 11 | 13 of 31 | No HTTP: no `*-http.controller.ts`, no `express` in `app/packages/desktop-main/package.json`, `createMicroservice` at `main.ts:45`. Streaming: five channels wrapped in `HyveonStreamHandle`. Gaps: "A test guards the real bridge boundary ... with no mock registered" is not met (finding 7); "Cancellation stops the stream" is only true for the per-call style (finding 5). Remaining 8 requirements are carried by `desktop-shell`. |

**OpenSpec summary:** 6 OpenSpec requirements carried, 2 scenarios appear unmet.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Bridge naming (NAME) | `APP-IPC-NAME-001` to `APP-IPC-NAME-007` | 7 | 0 | 0 |
| No HTTP transport (XPORT) | `APP-IPC-XPORT-001` to `APP-IPC-XPORT-006` | 6 | 0 | 0 |
| Request/response dispatch (CALL) | `APP-IPC-CALL-001` to `APP-IPC-CALL-013` | 12 | 0 | 1 |
| Error path (ERR) | `APP-IPC-ERR-001` to `APP-IPC-ERR-008` | 5 | 0 | 3 |
| Streaming across the context bridge (STREAM) | `APP-IPC-STREAM-001` to `APP-IPC-STREAM-015` | 12 | 0 | 3 |
| Contract and types (CONTRACT) | `APP-IPC-CONTRACT-001` to `APP-IPC-CONTRACT-004` | 2 | 0 | 2 |
| Secrets (SEC) | `APP-IPC-SEC-001` to `APP-IPC-SEC-003` | 3 | 0 | 0 |
| Test-mode mock seam (SEAM) | `APP-IPC-SEAM-001` to `APP-IPC-SEAM-007` | 5 | 0 | 2 |
| Test harnesses without HTTP (HARN) | `APP-IPC-HARN-001` to `APP-IPC-HARN-004` | 4 | 0 | 0 |

**Summary:** 56 of 67 active specs implemented; 0 deferred; 11 gaps.

## Key Findings

1. **`RpcErrorMessageFilter` flattens `BadRequestException` bodies to "Bad Request Exception"**: `validation.ts:21-24` throws `new BadRequestException({ success: false, error: '<field> must be an array of strings' })`; the filter returns `errMessage(exception)` (`rpc-error-message.filter.ts:36`), and for an object-body `HttpException` Nest sets `.message` to the class-derived string. Verified with `@nestjs/common` in this tree: `new BadRequestException({success:false,error:'…'}).message === "Bad Request Exception"`. Discord admin/permission writes (`discord.controller.ts:159-194`) and folder-upload selection (`folder-upload.controller.ts:146`) therefore show the operator a generic string, not the field error. Sweep marked this unverified at runtime; the message value is confirmed, the end-to-end UI text is `[inferred]`.
2. **Self-bridged channels bypass both error normalisers**: the nine `SELF_BRIDGED_PATTERNS` (`ipc-main-bridge.ts:27-37`) are registered by their controllers with bare `ipcMain.handle(channel, (evt, p) => this.method(p, { evt }))` (`iac.controller.ts:577-614`, `logs.controller.ts:44-51`, `iac-settings.controller.ts:117`, `iac-runs.controller.ts:183`). They call the method directly, so neither `RpcErrorMessageFilter` nor the bridge's `catch` (`ipc-main-bridge.ts:142-153`) runs; a raw SDK error thrown before the ack would hit the structured-clone failure the bridge comment describes. The same three-line `removeHandler` + `handle` block is repeated five times in `iac.controller.ts` alone.
3. **Stale comment: "no NestJS exception filter anywhere"**: `ipc-main-bridge.ts:99-100` says so, while `:117` of the same comment and `main.ts:49` register `RpcErrorMessageFilter`.
4. **Stale comment: "legacy Express 400"**: `validation.ts:14-16` says Nest maps the exception to a 400 with the Express handlers' shape; there is no HTTP transport and no 400 (see finding 1).
5. **Shared-side-channel streams never tell main to stop**: `stream-bridge.ts:24-26,160-163`: aborting `iac.stack.initialize`, `iac.runs.logs` or `iac.settings.autoUpdate.download` only stops the renderer-side drain loop; no cancel message exists. The spec scenario "Cancellation stops the stream ... the main process tears the underlying stream down" holds only for the per-call style (`stream-bridge.ts:216,227,255`).
6. **Per-call streams attach listeners after the ack**: `stream-bridge.ts:212-230` awaits `invoke` before `ipcRenderer.on(chunk)` / `.once(end)`, while `LogsController` starts its fire-and-forget loop before returning the ack (`logs.controller.ts:169-196`). A chunk or an immediate error `end` sent before the invoke reply is processed would be dropped and the stream would hang. `[inferred]` race; not reproduced.
7. **No unmocked streaming test**: every case in `streaming-handle-roundtrip.spec.ts` registers `__test.mock` for its channel first (`:43,86,137,192`), and `createBufferedStream` short-circuits to the mock before any IPC (`stream-bridge.ts:103-109`). The handle's clone survival is proven, but the spec scenario "drives a streaming channel end to end through the real preload bridge with no mock registered" is not; `logs.lambda.stream` and `iac.settings.autoUpdate.download` are not driven at all. The only unmocked e2e is `env.get` (`electron-ipc-roundtrip.spec.ts:21`).
8. **Two IPC facades in the renderer**: `api.service.ts:276-414` wraps nine namespaces; about 26 non-test renderer files reach `window.hyveon` directly, including all of `iac.*`, `logs.*`, `wizard.*`, `iac.settings.*` and `window.*`. Three "bridge unavailable" wordings exist (`bridge.utils.ts:2,8`, `api.service.ts:260-261`).
9. **Hand-mirrored contract has drifted**: `hyveon-api.ts` imports some types from `@hyveon/shared` (`:35,44`) but re-declares many: `GameServerPort` lacks `visibility` (`hyveon-api.ts:289-292` vs `app/packages/shared/src/gameServerConfig.ts:50`); `GameServer` lacks `webPort` and `command` (`hyveon-api.ts:418-432` vs `gameServerConfig.ts:243,254`); `GameWizardDraft` lacks both and makes `visibility` optional (`hyveon-api.ts:650-679`), which `api.service.ts:357` papers over with a cast; `LogChunk = string` (`hyveon-api.ts:157`) vs shared `LogChunk` interface (`app/packages/shared/src/cloud.ts:26`). The redacted Discord config is declared three times (`app/packages/shared/src/types.ts:47`, `hyveon-api.ts:231-242`, `api.service.ts:225`). `GUIDED_PROFILE_NAME` duplicated with `GuidedIamService.ts:94` (`hyveon-api.ts:2100-2107`).
10. **`test-mock-registry.ts` has no consumer**: its doc says it is used by `@hyveon/web` tests (`test-mock-registry.ts:9-11`), but the only references are its own test and a comment in `hyveon-api.ts`. The live test seam is the per-channel `mockRegistry` in `preload.ts:174-202`.
11. **Preload build compiles tests into `dist`**: `app/packages/desktop-preload/tsconfig.json` includes `app/packages/web/src/**/*` and excludes only `dist`/`node_modules`, so `preload.test.ts` and `test-mock-registry.test.ts` are emitted.
12. **`SELF_BRIDGED_PATTERNS` is a hand-synced list**: `ipc-main-bridge.ts:27-37` must match each controller's `onModuleInit` registration; all nine currently do. `ipc-main-bridge.test.ts:123-198` covers skip cases for five of nine; `logs.lambda.stream`, `iac.apply`, `iac.destroy` and `iac.runs.logs` have none.
13. **Stale counts and references in doc comments**: `stream-bridge.ts:7-13,80` says `createBufferedStream` is called four times (it is five; `preload.ts:45` is right); `preload.ts:362` says "three generators"; `openBufferedStream`'s `@param` (`preload.ts:383`) omits `streamUpdateDownload`; `hyveon-api.ts:2645` shows an `@hyveon/desktop-preload/hyveon-api` import path the `package.json` exports map does not provide; `electron-ipc-roundtrip.spec.ts:10-12` cites a preload invoke timeout that does not exist; "tfstate" wording in `hyveon-api.ts:464-478,697-716,2143,2668`.
14. **Secrets-to-renderer invariant now holds without exception**: Discord and health-check secrets cross only as `botTokenSet` / `publicKeySet` / `secretSet` booleans (`hyveon-api.ts:238-239`). The former `files` namespace, whose `files.start` returned plaintext FileBrowser credentials for one-time display, is gone from `preload.ts`, `hyveon-api.ts` and `api.service.ts`; its replacement `volumeFiles` (`hyveon-api.ts:1570`, `preload.ts:488-526`) returns only session state, listings, text content and transfer ids. The guarantee is enforced by tests only (`expectNoSecretFields` / `findSecretFields`, a regex over keys and string values, `secretFields.ts:2`), not by a runtime check at the bridge.
15. **Chromium tier fakes `window.hyveon` over a fictional `/api/*` map**: `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts:44` installs an HTTP-forwarding `window.hyveon`; renderer code carries guards that exist only for that stub (`app.component.tsx:34-43`). Consistent with the spec, which keeps the five chromium specs on this shim.
16. **Dropped files reach main as paths resolved in preload**: `volumeFiles.uploadDropped` maps each renderer `File` through `webUtils.getPathForFile` inside preload (`preload.ts:513-521`) so the renderer never handles local path strings, and the push channel names are string literals in preload because the sandboxed preload cannot load `@hyveon/shared/volumeFiles` at runtime (`preload.ts:143-148`); `preload.test.ts:340-341` pins them to the shared constants.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/ipc-bridge/ipc-bridge-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Make `requireStringArray` failures reach the renderer with their field message (throw a plain `Error` or teach `RpcErrorMessageFilter` to read `getResponse()`), and add a filter test for an object-body `BadRequestException` (finding 1). (specs: `APP-IPC-ERR-004`)
2. Route self-bridged `ipcMain.handle` registrations through the same normalisation as the generic bridge, ideally one shared helper instead of nine hand-written registrations (finding 2). (specs: `APP-IPC-ERR-005`)

### Should Fix
3. Add one unmocked streaming e2e through the real main process (for example `logs.lambda.stream` or `iac.runs.logs` against a finished run) to satisfy the requirement (finding 7). (specs: `APP-IPC-STREAM-011`)
4. Decide whether shared-side-channel streams need a main-side cancel, or narrow the cancellation scenario to the per-call style (finding 5). (specs: `APP-IPC-STREAM-009`)
5. Close the per-call listener-after-ack window, or confirm Electron ordering makes it impossible (finding 6). (specs: `APP-IPC-STREAM-013`)
6. Replace hand-mirrored preload types with `@hyveon/shared` imports where a shared type exists, starting with `GameServerPort`, `GameServer`, `RedactedDiscordConfig`, `LogChunk` (finding 9). (specs: `APP-IPC-CONTRACT-003`)
7. Fix the stale comments in `ipc-main-bridge.ts:99-100` and `validation.ts:14-16` (findings 3, 4).

### Nice to Have
8. Delete `test-mock-registry.ts` or adopt it; exclude `*.test.ts` from the preload `tsconfig.json` (findings 10, 11). (specs: `APP-IPC-SEAM-006`, `APP-IPC-SEAM-007`)
9. Add skip-case tests for the four uncovered `SELF_BRIDGED_PATTERNS` entries (finding 12). (specs: `APP-IPC-CALL-010`)
10. Consolidate the bridge-unavailable strings and decide whether direct `window.hyveon` callers should move behind `api.service.ts` (finding 8). (specs: `APP-IPC-CONTRACT-004`)
11. Sweep the stale counts and references in finding 13.
