# Embed File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!--
Checkbox states: `- [ ]` pending, `- [x]` done, `- [~]` deferred (manual smoke / dogfood / live-environment check not run this cycle).
Every `- [~]` row MUST be enumerated in verify.md §7 with its equivalent automated test, or recorded as a coverage gap.
-->

**Goal:** Replace the external-browser FileBrowser link with an in-app `/games/:name/files` page whose every helper interaction happens in desktop-main over pinned TLS.

**Architecture:** The infra program exports every volume's EFS access point and the helper mounts each applied volume under its own directory (fixing #672's wrong-volume upload on the way). desktop-main gains a `VolumeFileBackend` interface (FileBrowser is the only implementation, extending the existing pinned-TLS `FileBrowserClient`), a `HelperSessionRegistry` that owns at most one helper per game and is shared by browsing and folder upload, and a `VolumeFilesService` + `VolumeFilesController` behind a new `volumeFiles.*` IPC namespace that carries only names, sizes, times, state and progress. The renderer gets a routed page built from existing `ui/` primitives; the legacy modal, `files.*` channels and renderer-visible credential/URL are deleted in the last PR.

**Tech Stack:** Electron 43, NestJS IPC microservice, undici (pinned TLS), AWS SDK v3 (ECS/EC2/Scheduler via existing services), React + react-router `HashRouter`, Vitest (node + jsdom projects), Playwright (chromium + electron projects, tier-2 integration).

**Spec:** `openspec/changes/embed-file-browser/design.md`, `specs/game-volume-file-browser/spec.md`, `specs/game-volume-folder-upload/spec.md`, `tasks.md` (this directory). Read `design.md` D1–D13 and its Open Questions 7–10 before any task.

## Global Constraints

- No persistent ECS Service: helpers start with `RunTask` and stop with `StopTask` only.
- The per-launch credential, helper IP/host/URL and JWT never cross IPC, are never rendered, persisted or logged. Shared `volumeFiles` types contain no credential, token, IP, host or URL field.
- Every helper session (browse and upload) is launched with `buildTlsContainerSettings`; the client pins `EphemeralCert.fingerprint256` on every request.
- Ingress stays the app-managed operator `/32` on port `8080`, revoked through `revokeOrphanedRules` reference counting.
- `@hyveon/shared` barrel (`shared/src/index.ts`) gets no new exports; new shared code is the deep-import subpath `@hyveon/shared/volumeFiles`.
- Every `@MessagePattern` handler starts with `logger.debug('<Controller>: <pattern> invoked', { game, ...safeIds })`; every AWS/helper failure is normalized with `errMessage(err)` and logged (`.claude/rules/logging.md`).
- Extract at the second copy (`.claude/rules/duplication.md`); name each extraction in the PR body.
- Text edit limit: UTF-8 only, at most `1 MiB` (`1_048_576` bytes); save refused when the volume file's modification time differs from the one loaded.
- Browse grace period after leaving the page: `5 min` (configurable). Auto-stop backstop stays `2 h`. Auto-stop warning at `10 min` remaining.
- Read-only while the game's server task is STARTING/RUNNING (`EcsService.findRunningTaskOrThrow` non-null): main refuses mkdir/rename/delete/upload/writeText with code `server-running`. **Fails closed:** if that check throws, the same operations (and folder upload preflight) are refused with code `server-check-failed` and message "Couldn't confirm the server is stopped." `findRunningTask` keeps its swallow-and-return-null behaviour for existing callers.
- Every applied volume is mounted: helper path = `/<dir><volumePath>` from the launch's `HelperVolumeLayout`; IPC file requests carry `{ game, volume, path }` with `path` relative to the volume root; the layout never crosses IPC. Without the `efsVolumeAccessPoints` output, only the first volume is mounted and the rest report `mounted: false`.
- Infra: one new stack output `efsVolumeAccessPoints`, no new resources, no IAM change.
- `FILEBROWSER_IMAGE` pinned to the final release `v2.63.23` by digest, looked up from the registry (never written from memory).
- Tests: names start with "should"; no `as unknown as T`; TSDoc per `.claude/rules/tsdoc-tags.md`; comments per `.claude/rules/comment-conciseness.md`; components under ~200 lines / ~8 hooks.
- Each PR passes `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` with exit code 0, plus `npm run app:test:integration` (PR 2, PR 3, PR 4) and `npm run app:test:e2e` (PR 4, PR 5). Docs ship in the PR whose behaviour they describe.
- Markdown prose: no hard line wrap.

## Review Focus

1. **Racing acquires for one game** (double-clicked Start, an upload starting while the page starts a session): exactly one `RunTask`, both holders recorded. Pinned by Task 11 `should share one launch between concurrent acquires`.
2. **Helper dies under a live session** (auto-stop fired, container crashed): status must flip to `failed` with the stop reason and operations must return `unreachable` with Restart, never hang or report `running`. Pinned by Task 11 `should report failed when the session task disappears from ECS` and Task 12 `should not retry when the IP is unchanged`.
3. **Names with spaces, `#`, `?`, `%`, unicode, and odd volume names**: every endpoint (including the rename `destination` query and `/api/raw`) must round-trip them, and a volume named `../x` or `saves` twice must still get a safe, unique mount directory. Pinned by Task 2/3 tests using the name `a #1 ?%é.txt` and Task 7 `should fall back to an index directory for an unsafe or duplicate volume name`.
4. **Grace timer vs. return/stop races**: attach during grace cancels the timer; a timer firing after an explicit stop is a no-op; release of an unknown holder is a no-op. Pinned by Task 11 grace tests.
5. **Quit while AWS is unreachable**: `stopAll` must not block quit past its timeout. Pinned by Task 13 `should quit after the timeout when stopAll never settles`.

---

## File Structure

| Path | Responsibility | PR |
|---|---|---|
| `app/packages/shared/src/volumeFiles/paths.ts` (+`.test.ts`) | Volume path normalization, entry-name validation, join/parent helpers; shared by main and renderer | 1 |
| `app/packages/shared/src/volumeFiles/types.ts`, `index.ts` | IPC request/result/event shapes and limits for `volumeFiles.*` | 1 (index + paths), 4 (types) |
| `app/packages/shared/src/folderUpload/paths.ts` | Reuses `isCleanVolumePath`; `toRemotePath` documented as volume-relative | 1, 2 |
| `app/packages/infra/src/program.ts` (+`program.test.ts`) | `efsVolumeAccessPoints` stack output | 2 |
| `app/packages/shared/src/stackOutputs.ts`, `desktop-main/src/services/PulumiService.ts`, stack-output fixtures | Mirror and project the new output | 2 |
| `app/packages/desktop-main/src/services/volumeFiles/helperVolumeLayout.ts` (+test) | Volume → mount directory layout, first-volume fallback, `toHelperPath` | 2 |
| `app/packages/desktop-main/src/services/EcsService.ts` | `findRunningTaskOrThrow` (2), `tagTask` (3) | 2, 3 |
| `app/packages/desktop-main/src/services/volumeFiles/VolumeFileBackend.ts` | Backend interface, `VolumeEntry`/`VolumeStat`, `VolumeFileError` | 1 |
| `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.ts` | The one FileBrowser HTTP client; implements `VolumeFileBackend` | 1 |
| `app/packages/desktop-main/src/services/folderUpload/uploadEngine.ts` | Upload engine on `VolumeFileBackend` | 1 |
| `app/packages/desktop-main/src/testing/fake-filebrowser-server.ts`, `fake-volume-backend.ts` (renamed from `fake-filebrowser-client.ts`) | HTTPS fake helper; in-memory backend fake | 1 |
| `app/packages/desktop-main/src/services/FileManagerService.ts` | Launch/teardown primitives, image pin, volume mounts, IP re-authorization | 1 (pin), 2 (mounts), 3, 5 (legacy removal) |
| `app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts` (+test) | One app-owned helper per game; holders, grace, readiness, orphan, failed, quit | 3 |
| `app/packages/desktop-main/src/helper-quit-hook.ts` (+test) | Bounded `before-quit` stop of registry-owned helpers | 3 |
| `app/packages/desktop-main/src/services/FolderUploadService.ts` | Right-volume writes and fail-closed preflight (2); registry sessions (3); `persistSelection` option (4) | 2, 3, 4 |
| `app/packages/desktop-main/src/services/NativeDialogService.ts` (+test) | Electron open/save dialog seam (extracted from `FolderScanService` and `DiagnosticsController`) | 4 |
| `app/packages/desktop-main/src/services/volumeFiles/VolumeFilesService.ts` (+test), `localNames.ts` (+test), `transfers.ts` (+test) | File operations, read-only and fail-closed guard, text limits, downloads/uploads | 4 |
| `app/packages/desktop-main/src/controllers/volume-files.controller.ts` (+test) | `volumeFiles.*` handlers and push channels | 4 |
| `app/packages/desktop-main/src/modules/volume-files.module.ts` | Wires registry, service, dialogs | 3 (registry), 4 |
| `app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts` | `window.hyveon.volumeFiles` | 4 |
| `app/packages/web/src/pages/volume-files.page.tsx` (+test) | Routed page | 5 |
| `app/packages/web/src/components/volume-files/*` | Session bar, volume picker, breadcrumb, file table, action bar, name dialog, text editor, drop zone, hooks | 5 |
| `app/packages/web/e2e/pages/VolumeFilesPage.ts`, `e2e/specs/volume-files.spec.ts`, `e2e/specs/volume-files-electron.spec.ts` | Playwright page object and specs | 5 |

Files to delete in PR 5: `web/src/components/file-manager-modal.component.tsx` (+test), `web/src/hooks/use-file-manager.hook.ts` (+test), `desktop-main/src/controllers/files.controller.ts` (+test).

---

## PR 1 — `refactor(desktop-main)`: volume file backend interface and path safety

Branch from `main`. Covers tasks.md 1.1–1.6.

### Task 1: Volume path validator in `@hyveon/shared/volumeFiles` (tasks.md 1.4)

**Files:**
- Create: `app/packages/shared/src/volumeFiles/paths.ts`, `app/packages/shared/src/volumeFiles/paths.test.ts`, `app/packages/shared/src/volumeFiles/index.ts`
- Modify: `app/packages/shared/src/folderUpload/paths.ts:13-17` (drop private `isCleanAbsolute`, import `isCleanVolumePath`)
- Modify (subpath wiring, all three are required): `app/packages/shared/package.json` exports (`"./volumeFiles"` mirroring `"./folderUpload"`), `app/vitest.config.ts:18` alias, `app/packages/web/vite.config.ts:21` alias, `app/packages/web/tsconfig.json:35` paths

**Interfaces:**
- Produces:
  - `isCleanVolumePath(path: string): boolean` — absolute, no NUL, no backslash, no `.`/`..`/empty segments; `/` itself is clean; one trailing `/` tolerated.
  - `normalizeVolumePath(path: string): string` — returns the canonical form (no trailing `/` except root); throws `VolumePathError` when not clean.
  - `isValidEntryName(name: string): boolean` — non-empty, not `.`/`..`, no `/`, `\`, NUL, at most 255 UTF-8 bytes.
  - `joinVolumePath(dir: string, name: string): string` — throws `VolumePathError` for an invalid name.
  - `parentOfVolumePath(path: string): string` — `/a/b` → `/a`, `/a` → `/`.
  - `class VolumePathError extends Error` (`name = 'VolumePathError'`).

- [x] **Step 1: Write the failing tests** in `paths.test.ts`:

```ts
it('should accept the root and nested absolute paths', () => {
  expect(normalizeVolumePath('/')).toBe('/');
  expect(normalizeVolumePath('/Data/worlds/')).toBe('/Data/worlds');
});
it.each(['', 'Data', '/a/../b', '/a/./b', '/a//b', '/a\\b', '/a\0b', '..'])('should reject %j', (p) => {
  expect(isCleanVolumePath(p)).toBe(false);
  expect(() => normalizeVolumePath(p)).toThrow(VolumePathError);
});
it.each(['a #1 ?%é.txt', 'options.json', '.hidden'])('should accept the entry name %j', (n) => expect(isValidEntryName(n)).toBe(true));
it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0', 'x'.repeat(256)])('should reject the entry name %j', (n) => expect(isValidEntryName(n)).toBe(false));
it('should join under the root without a double slash', () => expect(joinVolumePath('/', 'a')).toBe('/a'));
it('should return the parent of a nested path and root for a top-level one', () => {
  expect(parentOfVolumePath('/a/b')).toBe('/a');
  expect(parentOfVolumePath('/a')).toBe('/');
});
```

- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/shared/src/volumeFiles/paths.test.ts` → FAIL (module not found).
- [x] **Step 3: Implement** the functions above in `paths.ts`; `index.ts` re-exports `./paths.js` with a one-line module comment matching `folderUpload/index.ts`. Replace `isCleanAbsolute` in `folderUpload/paths.ts` with an import of `isCleanVolumePath` (behaviour identical except empty segments, which `segments()` already drops; keep `paths.test.ts` there green).
- [x] **Step 4: Run** `cd app && npx vitest run packages/shared/src` → PASS, including the existing `folderUpload/paths.test.ts`.
- [x] **Step 5: Commit** — `refactor(shared): add volume path validator subpath`.

### Task 2: `VolumeFileBackend` interface and FileBrowser read operations (tasks.md 1.1, 1.2, 1.6)

**Files:**
- Create: `app/packages/desktop-main/src/services/volumeFiles/VolumeFileBackend.ts`
- Modify: `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.ts`, `app/packages/desktop-main/src/testing/fake-filebrowser-server.ts`
- Test: `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.test.ts`

**Interfaces:**
- Produces (in `VolumeFileBackend.ts`):

```ts
export interface VolumeEntry { name: string; isDir: boolean; size: number; modifiedMs: number }
export interface VolumeStat extends VolumeEntry { path: string }
export type VolumeFileErrorCode = 'not-found' | 'conflict' | 'unreachable' | 'auth' | 'pin-mismatch' | 'failed';
export class VolumeFileError extends Error {
  constructor(readonly code: VolumeFileErrorCode, message: string, readonly status?: number, options?: ErrorOptions);
}
export interface WriteOptions { size: number; overwrite: boolean; signal?: AbortSignal; onBytes?: (n: number) => void }
export interface VolumeFileBackend {
  readonly supportsArchive: boolean;
  connect(signal?: AbortSignal): Promise<void>;
  list(dir: string, signal?: AbortSignal): Promise<VolumeEntry[]>;
  stat(path: string, signal?: AbortSignal): Promise<VolumeStat>;
  readStream(path: string, signal?: AbortSignal): Promise<Readable>;
  writeStream(path: string, source: Readable, options: WriteOptions): Promise<void>;
  mkdir(path: string, options?: { existOk?: boolean; signal?: AbortSignal }): Promise<void>;
  move(from: string, to: string, signal?: AbortSignal): Promise<void>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
  archiveStream?(dir: string, signal?: AbortSignal): Promise<Readable>;
  close(): Promise<void>;
}
```

- `PinMismatchError` stays exported from `FileBrowserClient.ts` but now `extends VolumeFileError` with `code: 'pin-mismatch'`; `FileBrowserHttpError` is removed in Task 4 (kept here until the engine migrates).
- HTTP → code mapping (one private `toVolumeError(status, op, path)`): 401/403 → `auth`, 404 → `not-found`, 409 → `conflict`, other non-2xx → `failed` with `status`; network errors that are not trust failures or aborts → `unreachable`.
- FileBrowser v2.63 endpoints (every path through the existing `encodePath`):

| Method | Endpoint |
|---|---|
| `connect` | `POST /api/login` (existing `login`; renamed, `login` kept as an alias until Task 4) |
| `list` | `GET /api/resources<dir>/` → `items[].{name,isDir,size,modified}`; `modified` is RFC 3339 → `Date.parse` |
| `stat` | `GET /api/resources<path>` → `{name,isDir,size,modified}` |
| `readStream` | `GET /api/raw<path>` |
| `archiveStream` | `GET /api/raw<dir>/?algo=zip`; `supportsArchive = true` |

- [x] **Step 1: Extend the fake server** with per-file `modified` (default `2026-01-01T00:00:00Z`, overridable via a new `seedModified?: Record<string, string>` option), `GET /api/resources<file>` stat, `GET /api/raw<path>` (bytes are `size` repetitions of `0x61`, or a `seedContent?: Record<string, Buffer>` value), and `GET /api/raw<dir>/?algo=zip` (returns `application/zip` with a fixed `PK\x03\x04` body; the fake does not need a real archive). Existing upload tests must stay green.
- [x] **Step 2: Write the failing tests** in `FileBrowserClient.test.ts`, each against `startFakeFileBrowser` with the launch cert:
  - `should list entries with modification times in milliseconds` — seed `/Data/a #1 ?%é.txt` size 3; `list('/Data')` deep-equals `[{ name: 'a #1 ?%é.txt', isDir: false, size: 3, modifiedMs: Date.parse('2026-01-01T00:00:00Z') }]`.
  - `should throw not-found when listing a missing directory` — rejects with `VolumeFileError` `code: 'not-found'`.
  - `should stat a file` — `stat('/Data/a #1 ?%é.txt')` → `{ path: '/Data/a #1 ?%é.txt', isDir: false, size: 3 }` (partial match).
  - `should stream raw bytes for a file` — collected `readStream` equals `seedContent` buffer.
  - `should stream a zip for a directory archive` — first four bytes `PK\x03\x04`; `supportsArchive === true`.
  - `should map 401 to auth` — client constructed with a wrong password: `connect()` rejects with `code: 'auth'`.
  - `should fail closed on a different certificate before sending the credential` — existing pin test re-pointed at `connect()`; fake `requests` has no `/api/login` entry.
- [x] **Step 3: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/folderUpload/FileBrowserClient.test.ts` → FAIL.
- [x] **Step 4: Implement** `VolumeFileBackend.ts` and the read operations on `FileBrowserClient` (`implements FileBrowserApi, VolumeFileBackend` for now). `send()` widens to `'GET' | 'POST' | 'PATCH' | 'DELETE'`. Streams return `res.body` (undici `BodyReadable`) after a status check; dump the body on error statuses.
- [x] **Step 5: Run** the same command → PASS; `cd app && npx vitest run packages/desktop-main/src/services` → PASS.
- [x] **Step 6: Commit** — `refactor(desktop-main): add VolumeFileBackend read operations to FileBrowserClient`.

### Task 3: FileBrowser write operations (tasks.md 1.2, 1.6)

**Files:**
- Modify: `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.ts`, `app/packages/desktop-main/src/testing/fake-filebrowser-server.ts`
- Test: `app/packages/desktop-main/src/services/folderUpload/FileBrowserClient.test.ts`

**Interfaces:**
- Produces on `FileBrowserClient`:

| Method | Endpoint |
|---|---|
| `writeStream(path, source, {size, overwrite})` | `POST /api/resources<path>?override=<overwrite>` with `content-length: size`; 409 when `overwrite: false` and the file exists → `conflict` |
| `mkdir(path, {existOk})` | `POST /api/resources<path>/`; 409 → resolves when `existOk`, else `conflict` |
| `move(from, to)` | `PATCH /api/resources<from>?action=rename&destination=<encodeURIComponent(to)>&override=false&rename=false`; 409 → `conflict` |
| `remove(path)` | `DELETE /api/resources<path>` (FileBrowser removes directories recursively) |

- `uploadFile(args)` becomes a thin wrapper over `writeStream(remotePath, createReadStream(localPath).pipe(counter), { size, overwrite: true, signal, onBytes })` until Task 4 deletes it.

- [x] **Step 1: Extend the fake server**: `POST` honours `override=false` (409 when the file exists), `PATCH ?action=rename` (409 when `destination` exists, 404 when source is missing; moves a directory with its descendants), `DELETE` (removes a file or a directory subtree; 404 when missing).
- [x] **Step 2: Write the failing tests**:
  - `should write a stream and report its bytes` — `writeStream('/n.txt', Readable.from([Buffer.from('hello')]), { size: 5, overwrite: true, onBytes })` → fake `files.get('/n.txt') === 5`, `onBytes` total 5.
  - `should refuse to overwrite when overwrite is false` — seed `/n.txt`; rejects `code: 'conflict'`; size unchanged.
  - `should create a directory and treat an existing one as success only when existOk` — second `mkdir('/d')` rejects `conflict`; `mkdir('/d', { existOk: true })` resolves.
  - `should rename a file whose name needs encoding` — `move('/a #1 ?%é.txt', '/b #2.txt')` → fake has `/b #2.txt`, not the source.
  - `should refuse a rename onto an existing name` — rejects `conflict`, both files still present.
  - `should delete a directory recursively` — seed `/d/x`, `/d/y/z`; `remove('/d')` → no entry under `/d`.
- [x] **Step 3: Run to verify failure**, **Step 4: implement**, **Step 5: run** — same command as Task 2 → PASS.
- [x] **Step 6: Commit** — `refactor(desktop-main): add VolumeFileBackend write operations to FileBrowserClient`.

### Task 4: Move the upload engine onto `VolumeFileBackend` (tasks.md 1.3)

**Files:**
- Modify: `app/packages/desktop-main/src/services/folderUpload/uploadEngine.ts`, `FileBrowserClient.ts` (delete `FileBrowserApi`, `FileBrowserHttpError`, `RemoteEntry`, `UploadFileArgs`, `login`, `uploadFile`; `FileBrowserClientFactory.create` returns `VolumeFileBackend`), `app/packages/desktop-main/src/services/FolderUploadService.ts` (types only: `FileBrowserApi` → `VolumeFileBackend`, `login` → `connect`)
- Rename: `app/packages/desktop-main/src/testing/fake-filebrowser-client.ts` → `fake-volume-backend.ts` exporting `fakeBackend(overrides?: Partial<VolumeFileBackend>): FakeBackend` (same recording behaviour; `list` throws `VolumeFileError('not-found')` instead of returning `null`)
- Test: `uploadEngine.test.ts`, `FolderUploadService.test.ts`, `FolderUpload.integration.test.ts` (import updates only)

**Interfaces:**
- Consumes: Task 2/3 `VolumeFileBackend`, `VolumeFileError`.
- Produces: unchanged exported engine function names (`ensureDirs`, `listPlannedDirs`, `remoteSizesOf`, `listRemoteSizes`, `classifyUpload`, `verifyUpload`, `uploadAll`) with `client: VolumeFileBackend`. `listPlannedDirs` treats `not-found` as an absent directory. `ensureDirs` calls `mkdir(dir, { existOk: true, signal })`. `uploadOne` builds the counting stream itself and calls `writeStream(..., { overwrite: true })`.
- `isPermanent(err)`: cancellation, `FileChangedError`, and `VolumeFileError` with code `pin-mismatch` | `auth` | `not-found` | `conflict`, or `failed` with `status` 4xx other than 408/429. `unreachable` and 5xx retry.

- [x] **Step 1: Update the failing expectations** in `uploadEngine.test.ts`: replace `FileBrowserHttpError(403)` cases with `new VolumeFileError('failed', 'x', 403)` and add `should retry an unreachable error up to maxAttempts` (three `writeStream` calls, then `UploadFileError`).
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/folderUpload packages/desktop-main/src/services/FolderUpload*` → FAIL.
- [x] **Step 3: Implement** the migration and deletions; `grep -rn "FileBrowserApi\|FileBrowserHttpError\|fake-filebrowser-client" app/packages` returns nothing.
- [x] **Step 4: Run** the same command and `npm run app:typecheck` → PASS / clean.
- [x] **Step 5: Commit** — `refactor(desktop-main): run the upload engine on VolumeFileBackend`. PR body names the extraction: "one FileBrowser HTTP client (`FileBrowserClient`) behind `VolumeFileBackend`; `FileBrowserApi` removed".

### Task 5: Pin the archived FileBrowser image (tasks.md 1.5)

**Files:**
- Modify: `app/packages/desktop-main/src/services/FileManagerService.ts:17`
- Test: `app/packages/desktop-main/src/services/FileManagerService.test.ts`

- [x] **Step 1: Look up the digest** from Docker Hub (do not write one from memory): `curl -s 'https://hub.docker.com/v2/repositories/filebrowser/filebrowser/tags?page_size=100&name=2.63.23' | jq -r '.results[] | "\(.name) \(.digest)"'`. Expected: one line for the `v2.63.23` tag (or `2.63.23`) with a `sha256:` manifest-list digest. If no such tag exists, stop and report.
- [x] **Step 2: Write the failing test** `should launch the helper from an immutable image reference` — capture `registerTaskDefinition`'s argument; `containerDefinitions[0].image` matches `/^filebrowser\/filebrowser:v?2\.63\.23@sha256:[0-9a-f]{64}$/`.
- [x] **Step 3: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/FileManagerService.test.ts` → FAIL.
- [x] **Step 4: Set** `FILEBROWSER_IMAGE = 'filebrowser/filebrowser:<tag>@<digest>'` with a TSDoc line: upstream archived 2026-09-01, `v2.63.23` is the final release, the pin is deliberate. Update the two `@remarks` that say "verified against `filebrowser/filebrowser:latest`" (`tlsLaunch.ts`, `FileBrowserClient.ts`) to name `v2.63.23`.
- [x] **Step 5: Run** → PASS. Then the PR gate: `npm run app:lint && npm run app:typecheck && npm run app:test` → exit 0.
- [ ] **Step 6: Commit** — `build(desktop-main): pin the FileBrowser helper image to v2.63.23`. Open PR 1 with `/pr`.

---

## PR 2 — `fix(app)`: mount every game volume in the helper and upload into the right one

Branch from PR 1's branch. Covers tasks.md 2.1–2.7. Decisions: design.md D7 (fail closed), D12 (layout, output), D13 (#672 fix).

### Task 6: `efsVolumeAccessPoints` stack output (tasks.md 2.1, 2.6)

**Files:**
- Modify: `app/packages/infra/src/program.ts` (`StackOutputValues` doc + field near `:406-410`, `buildStackOutputs` near `:471-500`), `app/packages/shared/src/stackOutputs.ts:72-77`, `app/packages/desktop-main/src/services/PulumiService.ts:1034` (`projectStackOutputs`), `app/packages/desktop-main/src/testing/stack-outputs.fixture.ts`, `app/packages/web/e2e/fixtures/stack-outputs.fixture.ts`
- Test: `app/packages/infra/src/program.test.ts`, `app/packages/desktop-main/src/services/PulumiService.test.ts`

**Interfaces:**
- Produces: `StackOutputs.efsVolumeAccessPoints: Record<string, Record<string, string>>` (game → volume name → access point ID), required on the type; projected with fallback `{}`. `efsAccessPoints` is unchanged. Fixtures: desktop-main default `{ minecraft: { data: 'fsap-1' } }`; web e2e `{ minecraft: { data: 'fsap-mc1234' }, valheim: { data: 'fsap-vh1234' } }`.

- [x] **Step 1: Write the failing tests**:
  - `program.test.ts`: `should export every volume's access point per game` — a game with volumes `config` and `saves` → resolved `efsVolumeAccessPoints` equals `{ <game>: { config: <id of efs.gameAccessPoints['<game>-config']>, saves: <id of '<game>-saves'> } }`, and `efsAccessPoints[<game>]` still equals the `config` id.
  - `PulumiService.test.ts`: `should project efsVolumeAccessPoints and default it to an empty map when absent`.
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/infra/src/program.test.ts packages/desktop-main/src/services/PulumiService.test.ts` → FAIL.
- [x] **Step 3: Implement**; loop over every volume in the existing `buildStackOutputs` loop (same drift `throw` for a missing key). `npm run app:typecheck` lists every inline `StackOutputs` literal to update; switch any such literal in tests to the fixture builder (`.claude/rules/testing-conventions.md` "Fixtures over per-spec scaffolding").
- [x] **Step 4: Run** the same command and `npm run app:typecheck` → PASS / clean.
- [x] **Step 5: Commit** — `feat(infra): export every volume's EFS access point`.

### Task 7: Helper volume layout and multi-volume mounts (tasks.md 2.2, 2.3, 2.6)

**Files:**
- Create: `app/packages/desktop-main/src/services/volumeFiles/helperVolumeLayout.ts`, `helperVolumeLayout.test.ts`
- Modify: `app/packages/desktop-main/src/services/FileManagerService.ts` (inject `DeploymentConfigService`; `launch` mounts the layout; `LaunchOutcome`/`UploadHelperSession` carry `layout`), the module providing `FileManagerService` (`modules/aws.module.ts`: import `DeploymentConfigModule` if not already reachable)
- Test: `FileManagerService.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HelperVolumeMount { volume: string; containerPath: string; dir: string; accessPointId: string; taskVolumeName: string }
export interface HelperVolumeLayout {
  mounts: HelperVolumeMount[];
  /** Declared volumes with no exported access point yet (apply needed). */
  unmounted: { volume: string; containerPath: string }[];
  usedFallback: boolean;
}
export function buildHelperVolumeLayout(
  game: string,
  volumes: readonly { name: string; container_path: string }[],
  outputs: Pick<StackOutputs, 'efsAccessPoints' | 'efsVolumeAccessPoints'>,
): HelperVolumeLayout;
export function toHelperPath(layout: HelperVolumeLayout, volume: string, volumePath: string): string; // throws VolumePathError for an unmounted/unknown volume
export function isVolumeMounted(layout: HelperVolumeLayout, volume: string): boolean;
```

  - `dir`: the volume name when it matches `/^[A-Za-z0-9._-]{1,64}$/`, is not `.`/`..`, is unique among the game's volumes, and does not match `/^volume-\d+$/` (it could collide with another volume's fallback directory); otherwise `volume-<index>`. `taskVolumeName`: `vol-<index>`. Mount point `/srv/<dir>`.
  - Source of volumes: the game's `deployment-config` entry; if the game has no entry (deployed-only), the keys of `efsVolumeAccessPoints[game]` with `containerPath: ''`.
  - Fallback (`efsVolumeAccessPoints[game]` absent): only `volumes[0]` mounted via `efsAccessPoints[game]`, the rest in `unmounted`, `usedFallback: true`.
  - `FileManagerService.planHelperLayout(game: string): Promise<HelperVolumeLayout | null>` (null when not deployed) — used by `launch` and by `FolderUploadService.prepare` (Task 8) so both see the same layout. `launch` registers one `efsVolumeConfiguration` per mount (same `fileSystemId`, `transitEncryption: 'ENABLED'`, `iam: 'DISABLED'`) and one `mountPoints` entry per mount at `/srv/<dir>`; `--root /srv` is unchanged. A layout with zero mounts fails the launch with "No EFS access point found for '<game>'."

- [x] **Step 1: Write the failing tests**:
  - `should mount each applied volume under its own directory` — volumes `config` `/data/config`, `saves` `/data/saves`; output `{ config: 'fsap-c', saves: 'fsap-s' }` → mounts `[{ volume: 'config', dir: 'config', accessPointId: 'fsap-c' }, { volume: 'saves', dir: 'saves', accessPointId: 'fsap-s' }]` (partial), `unmounted: []`.
  - `should fall back to an index directory for an unsafe or duplicate volume name` — names `'../x'`, `'a b'`, `'saves'`, `'saves'` → dirs `volume-0`, `volume-1`, `volume-2`, `volume-3`.
  - `should mount only the first volume when the per-volume output is missing` — `efsVolumeAccessPoints: {}`, `efsAccessPoints: { mc: 'fsap-1' }` → one mount `{ volume: 'config', accessPointId: 'fsap-1' }`, `unmounted: [{ volume: 'saves', containerPath: '/data/saves' }]`, `usedFallback: true`.
  - `should list a declared but unapplied volume as unmounted` — config adds `mods`, output lacks it.
  - `should map a volume path to its helper path and refuse an unmounted volume` — `toHelperPath(layout, 'saves', '/worlds')` → `/saves/worlds`; `toHelperPath(layout, 'mods', '/')` throws `VolumePathError`.
  - `FileManagerService.test.ts`: `should register one EFS volume and mount point per mounted volume` — `volumes` has two `efsVolumeConfiguration.authorizationConfig.accessPointId` values `fsap-c`, `fsap-s`; `mountPoints` container paths `/srv/config`, `/srv/saves`.
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/volumeFiles/helperVolumeLayout.test.ts packages/desktop-main/src/services/FileManagerService.test.ts` → FAIL.
- [x] **Step 3: Implement**.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `feat(desktop-main): mount every applied volume in the file manager helper`.

### Task 8: Upload into the destination's volume (#672 fix) (tasks.md 2.4, 2.6)

**Files:**
- Modify: `app/packages/desktop-main/src/services/FolderUploadService.ts` (`prepare` at `:230-275`), `app/packages/shared/src/folderUpload/paths.ts` (`toRemotePath` TSDoc only)
- Test: `FolderUploadService.test.ts`, `FolderUpload.integration.test.ts`, `app/packages/shared/src/folderUpload/paths.test.ts`

**Interfaces:**
- Consumes: Task 7 `planHelperLayout`, `toHelperPath`, `isVolumeMounted`; existing `validateDestination`, `toRemotePath`.
- Produces: `UploadItem.remotePath = toHelperPath(layout, dest.volume.name, toRemotePath(request.destination, dest.volume.container_path, file.relPath))`. `prepare` throws `Error("Apply the infrastructure to upload into '<volume>'. Your selection is kept.")` when `!isVolumeMounted(layout, dest.volume.name)`, before any launch.

- [x] **Step 1: Write the failing tests**:
  - `paths.test.ts`: `should return a path relative to the owning volume for a second-volume destination` — `toRemotePath('/data/saves/worlds', '/data/saves', 'a.db')` → `/worlds/a.db`.
  - `FolderUploadService.test.ts`: `should target the second volume's mount for a second-volume destination` — volumes `config` `/data/config`, `saves` `/data/saves`, destination `/data/saves/worlds`, relPath `a.db` → the planned remote path is `/saves/worlds/a.db` (assert via the fake backend's recorded upload path).
  - `should refuse before launch when the destination volume is not mounted` — fallback layout (only `config` mounted), destination `/data/saves` → `{ started: false, error: expect.stringContaining("Apply the infrastructure to upload into 'saves'") }`; launch not called.
  - `FolderUpload.integration.test.ts`: `should write a second-volume upload into that volume and nothing into the first` — against `startFakeFileBrowser`: fake `files` has `/saves/worlds/a.db` and no key starting with `/config/`.
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/FolderUpload packages/shared/src/folderUpload` → FAIL (the second-volume path currently resolves to `/worlds/a.db`).
- [x] **Step 3: Implement**.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `fix(desktop-main): upload folders into the destination's own volume`.

### Task 9: Fail-closed server check, tier-2 spec and PR 2 docs (tasks.md 2.5, 2.6, 2.7)

**Files:**
- Modify: `app/packages/desktop-main/src/services/EcsService.ts:232-252`, `FolderUploadService.ts` (`prepare` running-server check at `:259-261`)
- Create: `app/packages/web/e2e/integration-specs/volume-outputs.spec.ts`
- Test: `EcsService.test.ts`, `FolderUploadService.test.ts`
- Docs: `docs/docs/components/infra.md`, `docs/docs/components/management-app.md` (via `write-docs`)

**Interfaces:**
- Produces: `EcsService.findRunningTaskOrThrow(cluster: string, game: string): Promise<Task | null>` — the current body without the `catch`; logs and throws `new Error(errMessage(err))`. `findRunningTask` becomes `try { return await this.findRunningTaskOrThrow(...) } catch { return null }` with its existing `logger.error`, so its callers keep today's behaviour. `FolderUploadService.prepare` calls the throwing variant and maps a throw to `Error("Couldn't confirm '<game>' is stopped. Try again in a moment.")`.

- [x] **Step 1: Write the failing tests**:
  - `EcsService.test.ts`: `should throw a plain Error when ListTasks fails in findRunningTaskOrThrow`; `should still return null from findRunningTask when ListTasks fails`.
  - `FolderUploadService.test.ts`: `should refuse the upload when the server state can't be confirmed` — `findRunningTaskOrThrow` rejects → `{ started: false, error: expect.stringContaining("Couldn't confirm") }`.
  - `volume-outputs.spec.ts` (tier 2, `{ test, expect }` from `./index.js`): `should project efsVolumeAccessPoints from the scripted stack outputs` — `ipc.mocks.pulumi.scriptStackOutputs({ ...DEFAULT_STACK_OUTPUTS, efsVolumeAccessPoints: { minecraft: { data: 'fsap-mc1234', mods: 'fsap-mods' } } })`, then resolve `ConfigService.getStackOutputs()` from the container and assert the map round-trips.
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/EcsService.test.ts packages/desktop-main/src/services/FolderUploadService.test.ts` → FAIL.
- [x] **Step 3: Implement**.
- [x] **Step 4: Run** → PASS; `npm run app:test:integration` → exit 0.
- [x] **Step 5: Docs** — `write-docs`: new output row in `infra.md`; multi-volume helper layout, first-volume fallback, wrong-volume fix and fail-closed upload preflight in `management-app.md`.
- [x] **Step 6: Gate** — `npm run app:lint && npm run app:typecheck && npm run app:test && npm run app:test:integration` → exit 0.
- [x] **Step 7: Commit** — `docs: document multi-volume helper mounts`. Open PR 2 with `/pr` (base: PR 1 branch). PR body: the operator runs plan + apply once after release (output-only change, empty resource diff); until then the helper mounts the first volume only and uploads into other volumes are refused.

---

## PR 3 — `feat(desktop-main)`: helper session registry with TLS browse sessions

Branch from PR 2's branch. Covers tasks.md 3.1–3.9.

### Task 10: Extract launch/teardown primitives from `FileManagerService` (tasks.md 3.1, 3.4 primitive)

**Files:**
- Modify: `app/packages/desktop-main/src/services/FileManagerService.ts`, `app/packages/desktop-main/src/services/EcsService.ts`
- Test: `FileManagerService.test.ts`, `EcsService.test.ts`

**Interfaces:**
- Produces on `FileManagerService` (public; the private `launch` body moves into `launchHelper`):
  - `launchHelper(game: string, options: HelperLaunchOptions): Promise<HelperLaunchOutcome>` where `HelperLaunchOptions = { runId: string; tls: boolean; tags?: readonly { key: string; value: string }[] }` and `HelperLaunchOutcome = { ok: true; taskArn: string; credentials: FileMgrCredentials; cert?: EphemeralCert; operatorIp: string; startedAt: number; autoStopAt: number; scheduleWarning: string; layout: HelperVolumeLayout } | { ok: false; code: 'helper-open' | 'failed'; message: string }`.
  - `stop(game)` unchanged (it is the teardown primitive).
  - `listHelperTask(game: string): Promise<Task | null>` — the `startedBy` lookup `getStatus` already does, extracted.
  - `reauthorizeOperatorIp(game: string, runId: string, taskArn: string, newIp: string): Promise<void>` — authorize `${newIp}/32` with `ruleDescription(game, runId)`, re-tag the task `OperatorIp=newIp`, then `revokeOrphanedRulesExcluding`-style refcount revoke over all helpers (no exclusion).
  - `export const FILEBROWSER_AUTO_STOP_MS` and `export const BROWSE_RUN_ID`.
- Produces on `EcsService`: `tagTask(cluster: string, taskArn: string, tags: { key: string; value: string }[]): Promise<void>` (`TagResourceCommand`; logs and rethrows a plain `Error`).
- `start()` calls `launchHelper(game, { runId: BROWSE_RUN_ID, tls: false })` (legacy modal, deleted in PR 5). `startForUpload` is deleted in Task 12.

- [x] **Step 1: Write the failing tests**:
  - `should launch with TLS container settings when tls is true` — `containerDefinitions[0].entryPoint` equals `['sh', '-c']` and outcome carries `cert.fingerprint256`.
  - `should apply the given tags plus the operator IP tag` — `runTask` tags equal `[{ key: 'Purpose', value: 'seed-upload' }, { key: 'Project', value: 'hyveon' }, { key: 'OperatorIp', value: '203.0.113.7' }]` for `tags: UPLOAD_TAGS`.
  - `should report autoStopAt two hours after launch` — with `vi.setSystemTime`, `autoStopAt - startedAt === 2 * 60 * 60 * 1000`.
  - `should re-authorize a new operator IP and revoke the old rule` — two helpers tagged `198.51.100.1`; after `reauthorizeOperatorIp(game, 'browse', arn, '198.51.100.2')`: `authorizeIngress` called with `'198.51.100.2/32'`, `tagTask` with `OperatorIp=198.51.100.2`, and the `198.51.100.1/32` rule kept only while the other helper still carries that tag.
  - `EcsService`: `should tag a task` / `should throw a plain Error when tagging fails` (aws-sdk-client-mock on `TagResourceCommand`).
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/FileManagerService.test.ts packages/desktop-main/src/services/EcsService.test.ts` → FAIL.
- [x] **Step 3: Implement**; keep exactly one launch body (no copy for browse vs upload).
- [x] **Step 4: Run** → PASS (existing browse/upload launch tests updated to the new entry point).
- [x] **Step 5: Commit** — `refactor(desktop-main): expose helper launch and IP re-authorization primitives`.

### Task 11: `HelperSessionRegistry` core: holders, grace, stop, orphan (tasks.md 3.2, 3.8)

**Files:**
- Create: `app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts`, `HelperSessionRegistry.test.ts`
- Create: `app/packages/desktop-main/src/modules/volume-files.module.ts` (provides `HelperSessionRegistry`; imports `AwsModule`, `FolderUploadModule` provides `FileBrowserClientFactory` → move that provider here and export it), register in `app.module.ts`

**Interfaces:**
- Consumes: Task 10 `FileManagerService.launchHelper/stop/listHelperTask`, `FileBrowserClientFactory.create`.
- Produces:

```ts
export type HelperHolder = 'browse' | `upload:${string}`;
export type HelperSessionState = 'not_deployed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'failed';
export interface HelperSessionSnapshot {
  game: string; state: HelperSessionState; startedAt?: number; autoStopAt?: number;
  browseHeld: boolean; uploadHolders: number; error?: string; supportsArchive: boolean;
  /** Every declared volume; `mounted` is false for volumes the session's layout could not mount (apply needed). */
  volumes: { name: string; containerPath: string; mounted: boolean }[];
}
export type AcquireResult = { ok: true } | { ok: false; code: 'orphaned' | 'not_deployed' | 'failed'; message: string };
export interface AcquireOptions { tags?: readonly { key: string; value: string }[]; runId?: string }
export class HelperSessionRegistry {
  readonly timings: { browseGraceMs: number; pollMs: number; helperIpTimeoutMs: number; loginTimeoutMs: number };
  acquire(game: string, holder: HelperHolder, options?: AcquireOptions): Promise<AcquireResult>; // resolves when ready
  attach(game: string): boolean;   // re-hold 'browse' on an existing session, cancelling its grace timer
  release(game: string, holder: HelperHolder): void; // browse → grace timer; upload → immediate teardown when last
  stop(game: string): Promise<{ success: boolean; message: string }>; // runs beforeStop listeners, then tears down; stops an orphan too
  restart(game: string): Promise<AcquireResult>;                       // stop then acquire('browse')
  status(game: string): Promise<HelperSessionSnapshot>;
  withBackend<T>(game: string, op: (backend: VolumeFileBackend, layout: HelperVolumeLayout) => Promise<T>): Promise<T>; // Task 12
  ownedGames(): ReadonlySet<string>;
  onState(listener: (snapshot: HelperSessionSnapshot) => void): () => void;
  onBeforeStop(listener: (game: string) => Promise<void> | void): () => void;
  stopAll(): Promise<void>;
}
```

- Entry state per game (private): `{ runId, taskArn?, startedAt?, autoStopAt?, state, holders: Set<HelperHolder>, backend?: VolumeFileBackend, layout?: HelperVolumeLayout, credentials?, cert?, operatorIp?, ready: Promise<AcquireResult>, graceTimer?, error? }`. With no entry, `status()` reports `volumes` from `fileManager.planHelperLayout(game)` (Task 7). `runId` is `BROWSE_RUN_ID` unless `options.runId` is given.
- Concurrency rule: the entry (state `starting`, `ready` promise) is inserted synchronously before the first `await`, so a second `acquire` adds its holder and awaits the same `ready`.
- `status()` with no entry: `not_deployed` when stack outputs are absent, `orphaned` when `listHelperTask(game)` returns a task, else `stopped`. With an entry in `running`: if `listHelperTask` returns null or a different `taskArn`, transition to `failed` with `getHelperStopReason(taskArn)` and drop the backend.
- Teardown (last holder gone, `stop`, `stopAll`): close backend, `fileManager.stop(game)`, delete entry, emit `stopped`. A `failed` launch removes the entry and emits `failed` with the error; the next `status()` reports `failed` once (kept in a `lastError` map until the next `acquire`).

- [x] **Step 1: Write the failing tests** with a `Partial<FileManagerService>` stub (`launchHelper` resolves `{ ok: true, taskArn: 'arn:t1', credentials, cert, operatorIp: '203.0.113.7', startedAt: 0, autoStopAt: 7_200_000, scheduleWarning: '' }`), `getHelperPublicIp` → `'127.0.0.1'`, a `fakeBackend()` factory, and fake timers:
  - `should share one launch between concurrent acquires` — two `acquire('mc','browse')` + `acquire('mc','upload:r1')` in parallel → `launchHelper` called once; snapshot `{ state: 'running', browseHeld: true, uploadHolders: 1 }`.
  - `should keep the helper while another holder remains` — release `upload:r1` → `fileManager.stop` not called.
  - `should stop the helper after the browse grace period` — release `browse` as last holder; advance `5 * 60 * 1000 - 1` → not stopped; advance `1` → `fileManager.stop('mc')` called once, snapshot `stopped`.
  - `should cancel the grace timer when the page re-attaches` — release `browse`, advance 1 min, `attach('mc') === true`, advance 10 min → not stopped.
  - `should stop an upload-only session as soon as the upload releases` — `acquire('mc','upload:r1')`, release → stop called without advancing timers.
  - `should ignore a release for an unknown holder or game` — no throw, no stop.
  - `should run beforeStop listeners before tearing down` — listener records order; `stop('mc')` → listener before `fileManager.stop`.
  - `should report orphaned when ECS has a helper the registry does not own` — no entry, `listHelperTask` → task → `state: 'orphaned'`; `acquire` → `{ ok: false, code: 'orphaned' }`, `launchHelper` not called.
  - `should restart an orphan by stopping it and launching a fresh session` — `restart('mc')` → `fileManager.stop` then `launchHelper`.
  - `should report failed when the session task disappears from ECS` — running entry, `listHelperTask` → null, `getHelperStopReason` → `'Essential container exited'` → `{ state: 'failed', error: expect.stringContaining('Essential container exited') }`.
  - `should not expose credentials, cert or address in a snapshot` — `JSON.stringify(await status('mc'))` matches none of `/password|credential|cert|fingerprint|127\.0\.0\.1|https?:/i`.
- [x] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.test.ts` → FAIL.
- [x] **Step 3: Implement** (readiness can call a private `waitUntilReady` that Task 12 fills in; for this task it resolves after `connect()`).
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `feat(desktop-main): add the helper session registry`.

### Task 12: Readiness over pinned TLS and operator-IP recovery (tasks.md 3.3, 3.4, 3.8)

**Files:**
- Modify: `HelperSessionRegistry.ts`, `FolderUploadService.ts` (delete `waitForHelperIp`, `waitForLogin`, `withStopReason`; they move into the registry)
- Test: `HelperSessionRegistry.test.ts`

**Interfaces:**
- Consumes: `FileManagerService.getHelperPublicIp`, `getHelperStopReason`, `reauthorizeOperatorIp`, `PublicIpService.detect`.
- Produces: `acquire` resolves only after task RUNNING + public IP + `backend.connect()` succeeds (the moved poll loops, using `timings.pollMs`/`helperIpTimeoutMs`/`loginTimeoutMs`; defaults `3000` / `180000` / `120000`). `withBackend(game, op)`:
  - throws `NoSessionError` (exported; `extends VolumeFileError` with code `unreachable`, message "No file manager session is running for '<game>'.") when no `running` entry;
  - on `VolumeFileError` code `unreachable` from `op`: `detect()` the IP; if it differs from the entry's `operatorIp`, `reauthorizeOperatorIp`, update the entry, retry `op` once; otherwise rethrow.
  - a `pin-mismatch` error fails the session (`failed`, backend dropped) and rethrows.

- [x] **Step 1: Write the failing tests**:
  - `should stay starting until the backend accepts the login` — `connect` rejects `unreachable` twice then resolves; snapshot during the wait is `starting`; final `running`.
  - `should stay starting while the task has no public IP` — `getHelperPublicIp` → `null`, `null`, `'127.0.0.1'`.
  - `should fail with the stop reason when the task exits during start` — `getHelperPublicIp` throws `Error('The file manager helper stopped before it was reachable: CannotPullContainerError')` → `{ ok: false, code: 'failed', message: expect.stringContaining('CannotPullContainerError') }` and snapshot `failed`.
  - `should fail closed on a pin mismatch without retrying login` — `connect` rejects `PinMismatchError` → one `connect` call, `failed`.
  - `should re-authorize and retry once when the operator IP changed` — `op` rejects `unreachable` once; `detect` → new IP; `reauthorizeOperatorIp` called with it; `op` called twice; result returned.
  - `should not retry when the IP is unchanged` — `op` called once; rejects `unreachable`.
- [x] **Step 2: Run to verify failure**, **Step 3: implement**, **Step 4: run** — same command as Task 11 → PASS.
- [x] **Step 5: Commit** — `feat(desktop-main): define helper readiness as an authenticated pinned round-trip`.

### Task 13: Folder upload on the registry, sweep exclusion, quit hook (tasks.md 3.5, 3.6, 3.7, 3.8)

**Files:**
- Modify: `app/packages/desktop-main/src/services/FolderUploadService.ts`, `FileManagerService.ts` (delete `startForUpload`, `UploadHelperSession`, `UploadHelperLaunch`), `app/packages/desktop-main/src/electron-entry.ts`
- Create: `app/packages/desktop-main/src/helper-quit-hook.ts`, `helper-quit-hook.test.ts`
- Test: `FolderUploadService.test.ts`, `FolderUpload.integration.test.ts`

**Interfaces:**
- Consumes: Task 11/8 registry.
- Produces:
  - `FolderUploadService` constructor takes `HelperSessionRegistry` instead of `FileBrowserClientFactory`, and keeps `FileManagerService` only for `planHelperLayout` (Task 7). `prepare()`: registry `status(game)` `orphaned` → throw `Error("A file manager session is already open for '<game>'. Restart it, then retry.")` (keeps the card's `HELPER_OPEN` regex matching until PR 5). Any other state passes.
  - `execute()`: `acquire(game, \`upload:${runId}\`, { tags: UPLOAD_TAGS, runId })`; all helper I/O through `registry.withBackend(game, op)`; `finally` → `registry.release(game, \`upload:${runId}\`)`. `UPLOAD_TAGS` is exported from `FileManagerService.ts`.
  - Remote paths are re-derived from the *session's* layout (the `layout` argument of `withBackend`), not the preflight one, because a reused browse session may predate an apply. If the destination volume is not mounted in that session, the run fails before writing with "Restart the file manager session to upload into '<volume>'." 
  - Constructor registers `registry.onBeforeStop((game) => { this.cancel(game) })`.
  - `onApplicationBootstrap` and `cleanupStrayHelpers` pass `activeGames = active run games ∪ registry.ownedGames()` (startup: empty set as today).
  - `installHelperQuitHook(app: QuitApp, registry: Pick<HelperSessionRegistry, 'ownedGames' | 'stopAll'>, timeoutMs = 5000): void` where `QuitApp = { on(event: 'before-quit', fn: (e: { preventDefault(): void }) => void): void; quit(): void }`. With no owned games it does nothing (so `electron-clean-quit.spec.ts` is unaffected); otherwise `preventDefault()` once, `Promise.race([stopAll(), timeout])`, log the outcome, then `quit()`; a second `before-quit` passes through.
  - `electron-entry.ts` calls `installHelperQuitHook(app, nestApp.get(HelperSessionRegistry))` after bootstrap.

- [ ] **Step 1: Write the failing tests**:
  - `FolderUploadService`: `should reuse the browse session instead of refusing` — registry stub `status` → `running`; `startUpload` → `{ started: true }`; `acquire` called with holder `upload:<runId>`.
  - `should refuse with a restart message when an orphaned helper exists` — `{ started: false, error: expect.stringMatching(/already open.*Restart/) }`.
  - `should release its hold on success, failure and cancel` — three runs; `release` called with `upload:<runId>` each time.
  - `should cancel the run when the session is force-stopped` — trigger the registered `onBeforeStop('mc')` → terminal phase `cancelled`.
  - `should exclude registry-owned games from the stray sweep` — `ownedGames` → `{'mc'}`; `sweepStrayHelpers` called with `activeGames` containing `'mc'`.
  - `helper-quit-hook`: `should not delay quit when no helpers are owned`; `should stop owned helpers before quitting` (`preventDefault` once, `stopAll` awaited, `quit` called once); `should quit after the timeout when stopAll never settles` (fake timers, `stopAll` never resolves, advance `5000` → `quit` called).
  - `FolderUpload.integration.test.ts`: wire a real `HelperSessionRegistry` with the stubbed `FileManagerService` and the real `FileBrowserClientFactory` against `startFakeFileBrowser`; existing scenarios (upload, resume, pin mismatch, overwrite) stay green, plus `should leave an existing browse session running after the upload` (pre-`acquire('mc','browse')`; after the run `fileManager.stop` not called).
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/FolderUpload packages/desktop-main/src/helper-quit-hook.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; then `npm run app:test` → exit 0.
- [ ] **Step 5: Commit** — `feat(desktop-main): share the helper session between browsing and folder upload`.

### Task 14: Tier-2 wiring test and PR 3 docs (tasks.md 3.8, 3.9)

**Files:**
- Create: `app/packages/web/e2e/integration-specs/helper-session.spec.ts`
- Modify: `docs/docs/components/management-app.md`, `docs/docs/architecture.md` (through the `write-docs` skill)

- [ ] **Step 1: Write the spec** using `{ test, expect }` from `./index.js`: resolve `HelperSessionRegistry` from the in-process container; script `ServerMocks` for one `RunTask`, `DescribeTasks` (RUNNING with an ENI), `DescribeNetworkInterfaces` (no public IP) and assert `should report starting while the helper has no public IP` via `registry.status('minecraft')`, and `should report orphaned for an unowned helper` by seeding a `filemgr-minecraft` task with no prior acquire.
- [ ] **Step 2: Run** `npm run app:test:integration` → the new spec passes along with the existing ones (exit 0).
- [ ] **Step 3: Docs** — `write-docs` skill: registry, TLS for every helper session, upload reuse/Restart, quit hook, sweep exclusion (`management-app.md`); helper transport and the secrets boundary (`architecture.md`).
- [ ] **Step 4: Gate** — `npm run app:lint && npm run app:typecheck && npm run app:test && npm run app:test:integration` → exit 0.
- [ ] **Step 5: Commit** — `docs: document the helper session registry`. Open PR 3 with `/pr` (base: PR 2 branch).

---

## PR 4 — `feat(app)`: volumeFiles IPC surface and preload API

Branch from PR 3's branch. Covers tasks.md 4.1–4.9.

### Task 15: Shared `volumeFiles` IPC types (tasks.md 4.1)

**Files:**
- Create: `app/packages/shared/src/volumeFiles/types.ts`; modify `volumeFiles/index.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_TEXT_EDIT_BYTES = 1_048_576;
export const AUTO_STOP_WARNING_MS = 10 * 60 * 1000;
export type VolumeSessionState = 'not_deployed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'failed';
export interface VolumeSessionStatus {
  game: string; state: VolumeSessionState;
  startedAt?: string; autoStopAt?: string;        // ISO 8601
  browseHeld: boolean; uploadHolders: number; supportsArchive: boolean; error?: string;
  volumes: VolumeInfo[];
}
export interface VolumeInfo { name: string; containerPath: string; mounted: boolean }
/** Every file request names its volume; `path` is relative to that volume's root. */
export interface VolumeRef { game: string; volume: string }
export interface VolumeEntryInfo { name: string; isDir: boolean; size: number; modifiedMs: number }
export interface VolumeListing { path: string; entries: VolumeEntryInfo[] }
export interface VolumeTextFile { path: string; content: string; modifiedMs: number }
export type VolumeFilesErrorCode =
  | 'not-found' | 'conflict' | 'unreachable' | 'auth' | 'pin-mismatch'
  | 'invalid-path' | 'unknown-volume' | 'server-running' | 'server-check-failed' | 'no-session' | 'too-large' | 'binary' | 'failed';
export type VolumeResult<T> = { ok: true; value: T } | { ok: false; code: VolumeFilesErrorCode; message: string };
export interface VolumeTransferProgress {
  game: string; transferId: string; kind: 'download' | 'upload'; name: string;
  bytesDone: number; bytesTotal: number | null; phase: 'running' | 'done' | 'failed' | 'cancelled';
  savedAs?: string; error?: string;
}
export const VOLUME_FILES_SESSION_CHANNEL = 'volumeFiles.session';
export const VOLUME_FILES_TRANSFER_CHANNEL = 'volumeFiles.transfer';
```

- [ ] **Step 1: Add the types** (no runtime test beyond typecheck; constants are covered by Task 17/16 tests).
- [ ] **Step 2: Run** `npm run app:typecheck` → clean.
- [ ] **Step 3: Commit** — `feat(shared): add volumeFiles IPC types`.

### Task 16: `NativeDialogService` extraction (tasks.md 4.2)

**Files:**
- Create: `app/packages/desktop-main/src/services/NativeDialogService.ts`, `NativeDialogService.test.ts`
- Modify: `app/packages/desktop-main/src/services/FolderScanService.ts:37-39`, `app/packages/desktop-main/src/controllers/diagnostics.controller.ts:103-115` (both call the service), the modules that provide them

**Interfaces:**
- Produces: `NativeDialogService.pickDirectory(): Promise<string | null>`, `pickFiles(): Promise<string[]>`, `pickSavePath(defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>`. Each returns the cancelled value outside Electron (`!process.versions.electron`), using the same dynamic `import('electron')` pattern.

- [ ] **Step 1: Write the failing tests** — `should return null outside Electron` for each method; `should pass the default name to showSaveDialog` (mock the dynamic import via `vi.mock('electron', ...)` with `process.versions.electron` stubbed).
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/NativeDialogService.test.ts` → FAIL.
- [ ] **Step 3: Implement**; migrate both call sites (third dialog consumer is Task 18 → extraction now per the duplication rule). Existing `FolderScanService`/`diagnostics.controller` tests stay green.
- [ ] **Step 4: Run** `cd app && npx vitest run packages/desktop-main/src` → PASS.
- [ ] **Step 5: Commit** — `refactor(desktop-main): extract NativeDialogService`. PR body names this extraction.

### Task 17: `VolumeFilesService` session and file operations (tasks.md 4.3, 4.8)

**Files:**
- Create: `app/packages/desktop-main/src/services/volumeFiles/VolumeFilesService.ts`, `VolumeFilesService.test.ts`
- Create: `app/packages/desktop-main/src/testing/no-secret-fields.ts` (`expectNoSecretFields(value: unknown): void` — fails when any key or string value matches `/password|credential|token|fingerprint|cert|https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b/i`)

**Interfaces:**
- Consumes: registry (`acquire`, `attach`, `release`, `stop`, `restart`, `status`, `withBackend`), `ConfigService.getStackOutputs`, `EcsService.findRunningTask`, shared `normalizeVolumePath`/`isValidEntryName`/`joinVolumePath`/`parentOfVolumePath`.
- Produces:
  - Session: `sessionStatus(game): Promise<VolumeSessionStatus>`, `sessionStart(game)` (fires `acquire(game,'browse')` without awaiting readiness, returns the `starting` status), `sessionAttach(game)`, `sessionDetach(game)` (both return status), `sessionStop(game)`, `sessionRestart(game)`.
  - Files (each returns `VolumeResult<…>`; `ref: VolumeRef`): `list(ref, path)`, `mkdir(ref, parent, name)`, `rename(ref, path, newName)` (target = `joinVolumePath(parentOfVolumePath(path), newName)`), `remove(ref, path)` (refuses `/`, the volume root), `readText(ref, path)`, `writeText(ref, path, content, expectedModifiedMs)`. Inside `withBackend(game, (backend, layout) => …)`, every path goes through `toHelperPath(layout, ref.volume, normalizeVolumePath(path))`; an unmounted or unknown volume → `unknown-volume`, without calling the backend.
  - `toVolumeResult(err)`: `VolumePathError` → `invalid-path`; `VolumeFileError` → same code; anything else → `failed` with `errMessage(err)`; logged `warn` for expected codes, `error` for `failed`.
  - `assertWritable(game)`: `findRunningTaskOrThrow(outputs.ecsClusterName, game)` non-null → `{ ok: false, code: 'server-running', message: "'<game>' is running. Stop the server to change files." }`; a throw → `{ ok: false, code: 'server-check-failed', message: "Couldn't confirm the server is stopped." }` (fail closed, logged `warn`).
  - `readText`: `stat.size > MAX_TEXT_EDIT_BYTES` → `too-large`; decode with `new TextDecoder('utf-8', { fatal: true })`; decode failure or a NUL byte → `binary`.
  - `writeText`: `Buffer.byteLength(content) > MAX_TEXT_EDIT_BYTES` → `too-large`; `stat.modifiedMs !== expectedModifiedMs` → `conflict` ("The file changed on the volume since you opened it."); success returns the new `modifiedMs`.
  - Snapshot → `VolumeSessionStatus` maps epoch ms to ISO strings.

- [ ] **Step 1: Write the failing tests** (registry stub whose `withBackend` invokes `op(fakeBackend(...))`):
  - `should reject a traversal path without contacting the backend` — `list({ game: 'mc', volume: 'saves' }, '/a/../b')` → `{ ok: false, code: 'invalid-path' }`; backend not called.
  - `should reject a new folder name containing a slash` — `mkdir(ref, '/', 'a/b')` → `invalid-path`.
  - `should reject a volume the session did not mount` — layout mounts only `config`; `list({ game: 'mc', volume: 'saves' }, '/')` → `unknown-volume`; backend not called.
  - `should map a volume path to its mount directory` — `list({ game: 'mc', volume: 'saves' }, '/worlds')` → backend `list('/saves/worlds')`.
  - `should refuse mutations while the server runs and still allow listing` — `findRunningTaskOrThrow` → task; `mkdir`, `rename`, `remove`, `writeText` → `server-running`; `list` → `ok: true`.
  - `should refuse mutations when the server state can't be confirmed` — `findRunningTaskOrThrow` rejects → `mkdir`, `rename`, `remove`, `writeText` → `server-check-failed`; `list` and `download` still `ok: true`.
  - `should map a backend conflict on rename` — backend `move` rejects `conflict` → `{ ok: false, code: 'conflict' }`.
  - `should refuse to delete the volume root` — `remove(ref, '/')` → `invalid-path`.
  - `should refuse to open a file over 1 MiB` — `stat.size === 1_048_577` → `too-large`; exactly `1_048_576` → `ok: true`.
  - `should refuse to open a non-UTF-8 file` — content `Buffer.from([0xff, 0xfe])` → `binary`.
  - `should refuse a save when the modification time changed` — `stat.modifiedMs` 2 vs expected 1 → `conflict`; `writeStream` not called.
  - `should save and return the new modification time` — `writeStream` called with `overwrite: true`; result `{ ok: true, value: { modifiedMs: <post-write stat> } }`.
  - `should return no-session when nothing is running` — `withBackend` rejects `new NoSessionError('mc')` → `no-session`.
  - `should carry no secret fields in any result` — run every method once; `expectNoSecretFields` on each result and on `sessionStatus`.
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/volumeFiles/VolumeFilesService.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `toVolumeResult` maps Task 12's `NoSessionError` to `no-session` before the generic `VolumeFileError` branch.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(desktop-main): add VolumeFilesService file operations`.

### Task 18: Downloads and uploads (tasks.md 4.4, 4.5, 4.8)

**Files:**
- Create: `app/packages/desktop-main/src/services/volumeFiles/localNames.ts` (+test), `transfers.ts` (+test)
- Modify: `VolumeFilesService.ts` (+test), `FolderUploadService.ts` (`startUpload(request, options?: { persistSelection?: boolean })`, default `true`)

**Interfaces:**
- Produces:
  - `sanitizeLocalFileName(name: string, platform: NodeJS.Platform): string` — on `win32`: replace each of `<>:"/\|?*` and control chars with `_`, strip trailing dots/spaces, prefix `_` to reserved stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive, with or without extension); elsewhere replace `/` and NUL only. Empty result → `download`.
  - `streamToFile(source: Readable, target: string, options: { signal: AbortSignal; onBytes: (n: number) => void }): Promise<void>` — writes `${target}.part`, renames to `target` on success, unlinks the `.part` on any failure or abort, rethrows.
  - `VolumeFilesService.download(ref, path, isDir): Promise<VolumeResult<{ transferId: string } | null>>` — default name `sanitizeLocalFileName(basename + (isDir ? '.zip' : ''), process.platform)`; `null` when the dialog is cancelled; `isDir && !backend.supportsArchive` → `failed` ("Folder download is not supported by this backend."); emits `VolumeTransferProgress` events (`bytesTotal` from `stat.size` for files, `null` for archives; `savedAs` = chosen path) through `onTransfer(listener)`; runs in the background after the dialog.
  - `cancelTransfer(game, transferId): { cancelled: boolean }`.
  - `uploadFiles(ref, dir, localPaths?: string[]): Promise<VolumeResult<{ transferId: string } | null>>` — `localPaths` absent → `pickFiles()`; empty strings rejected (`invalid-path`); `assertWritable`; each file `writeStream(joinVolumePath(dir, basename), createReadStream, { size, overwrite: false })` so an existing name returns `conflict` and nothing is overwritten.
  - `uploadFolder(ref, dir): Promise<VolumeResult<FolderUploadStartResult | null>>` — `pickDirectory` → `FolderScanService.scan` → `FolderUploadService.startUpload({ game, scanId, include: [''], destination }, { persistSelection: false })` where `destination = selectedVolume.container_path + (dir === '/' ? '' : dir)` and `selectedVolume` is the game's volume named `ref.volume` (unknown → `unknown-volume`). The folder-upload flow then routes the bytes into that volume's mount (Task 8).

- [ ] **Step 1: Write the failing tests**:
  - `localNames`: `should replace characters reserved on Windows` (`'a:b?.txt'` → `'a_b_.txt'`); `should prefix reserved device names` (`'con.txt'` → `'_con.txt'`, `'NUL'` → `'_NUL'`); `should leave names alone on Linux and macOS` (`'a:b?.txt'` unchanged for `'linux'` and `'darwin'`).
  - `transfers`: `should rename the part file on success`; `should leave no partial file when the source errors` (source emits an error after 3 bytes → neither `target` nor `target.part` exists); `should leave no partial file when cancelled`.
  - `VolumeFilesService`: `should not start a download when the save dialog is cancelled`; `should emit progress and done with the saved path` (`savedAs` equals the dialog path; final `phase: 'done'`, `bytesDone === size`); `should refuse a folder download when the backend has no archive support`; `should refuse an upload whose name already exists` (`conflict`, original size unchanged); `should reject a dropped path that did not resolve` (`['']` → `invalid-path`); `should start a folder upload into the selected volume's current directory without persisting the selection` (volumes `config` `/data/config` and `saves` `/data/saves`; `uploadFolder({ game: 'mc', volume: 'saves' }, '/worlds')` → `startUpload` called with `destination: '/data/saves/worlds'`, options `{ persistSelection: false }`).
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/services/volumeFiles packages/desktop-main/src/services/FolderUploadService.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(desktop-main): add volume file downloads and uploads`.

### Task 19: `VolumeFilesController` and push channels (tasks.md 4.6, 4.8)

**Files:**
- Create: `app/packages/desktop-main/src/controllers/volume-files.controller.ts`, `volume-files.controller.test.ts`
- Modify: `app/packages/desktop-main/src/modules/volume-files.module.ts` (add `VolumeFilesService`, `NativeDialogService`), `app/packages/desktop-main/src/app.module.ts` (controller)

**Interfaces:**
- Produces channels (payload → result):

| Channel | Payload | Result |
|---|---|---|
| `volumeFiles.session.status` / `.start` / `.attach` / `.detach` / `.stop` / `.restart` | `game: string` | `VolumeSessionStatus` (`stop`/`restart` → `VolumeResult<VolumeSessionStatus>`) |
| `volumeFiles.list` | `{ game, volume, path }` | `VolumeResult<VolumeListing>` |
| `volumeFiles.mkdir` | `{ game, volume, parent, name }` | `VolumeResult<VolumeEntryInfo>` |
| `volumeFiles.rename` | `{ game, volume, path, newName }` | `VolumeResult<VolumeEntryInfo>` |
| `volumeFiles.delete` | `{ game, volume, path }` | `VolumeResult<true>` |
| `volumeFiles.readText` | `{ game, volume, path }` | `VolumeResult<VolumeTextFile>` |
| `volumeFiles.writeText` | `{ game, volume, path, content, expectedModifiedMs }` | `VolumeResult<{ modifiedMs: number }>` |
| `volumeFiles.download` | `{ game, volume, path, isDir }` | `VolumeResult<{ transferId } \| null>` |
| `volumeFiles.cancelTransfer` | `{ game, transferId }` | `{ cancelled: boolean }` |
| `volumeFiles.uploadFiles` | `{ game, volume, dir, localPaths? }` | `VolumeResult<{ transferId } \| null>` |
| `volumeFiles.uploadFolder` | `{ game, volume, dir }` | `VolumeResult<FolderUploadStartResult \| null>` |

- Push channels `VOLUME_FILES_SESSION_CHANNEL` (registry `onState` → snapshot mapped to `VolumeSessionStatus`) and `VOLUME_FILES_TRANSFER_CHANNEL` (service `onTransfer`), forwarded in `onModuleInit` behind `if (!process.versions.electron) return;` exactly like `FolderUploadController.onModuleInit`.
- Every handler's first line: `logger.debug('VolumeFilesController: <channel> invoked', { game })` (plus `volume` and `path` for path-carrying channels; never `content` or `localPaths`). Payload shape guarded with `isNonEmptyString` from `controllers/validation.ts`; a malformed payload returns `{ ok: false, code: 'invalid-path', message: 'Invalid request.' }`.

- [ ] **Step 1: Write the failing tests**:
  - `should register every volumeFiles channel` — `expectChannels(VolumeFilesController.prototype, [...rows])` from `testing/message-pattern.test-utils.ts` for all 16 channels.
  - `should log each invocation with the game and without file content` — `writeText` with `content: 'SECRET-CONTENT'` → `logger.debug` called with `'VolumeFilesController: volumeFiles.writeText invoked'` and an object not containing `'SECRET-CONTENT'`.
  - `should reject a malformed payload` — `list({ game: 'mc', path: '/' })` (no `volume`) → `invalid-path`.
  - `should not forward events outside Electron` — `onModuleInit` with `process.versions.electron` undefined → registry `onState` not subscribed.
  - `should return results free of secret fields` — `expectNoSecretFields` over each delegated result.
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-main/src/controllers/volume-files.controller.test.ts` → FAIL.
- [ ] **Step 3: Implement**, **Step 4: run** → PASS.
- [ ] **Step 5: Commit** — `feat(desktop-main): expose volumeFiles over IPC`.

### Task 20: Preload `window.hyveon.volumeFiles` and docs (tasks.md 4.7, 4.8, 4.9)

**Files:**
- Modify: `app/packages/desktop-preload/src/preload.ts` (after the `folderUpload` block, `:450-467`), `app/packages/desktop-preload/src/hyveon-api.ts` (new `HyveonVolumeFilesApi`, added to `HyveonApi`), `app/packages/desktop-preload/src/preload.test.ts`
- Modify: `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (bridge entries for the chromium project: `/api/volume-files/<channel>` routes)
- Modify: `docs/docs/components/management-app.md` (IPC channel table, via `write-docs`)

**Interfaces:**
- Produces `HyveonVolumeFilesApi`: one method per Task 19 channel (`sessionStatus(game)`, `sessionStart(game)`, `sessionAttach(game)`, `sessionDetach(game)`, `sessionStop(game)`, `sessionRestart(game)`, `list(game, volume, path)`, `mkdir(game, volume, parent, name)`, `rename(game, volume, path, newName)`, `remove(game, volume, path)`, `readText(game, volume, path)`, `writeText(game, volume, path, content, expectedModifiedMs)`, `download(game, volume, path, isDir)`, `cancelTransfer(game, transferId)`, `uploadFiles(game, volume, dir)`, `uploadDropped(game, volume, dir, files: File[])`, `uploadFolder(game, volume, dir)`), plus `onSession(cb)` and `onTransfer(cb)` returning unsubscribe functions (same shape as `folderUpload.onProgress`).
- `uploadDropped` resolves paths inside the preload with `webUtils.getPathForFile(file)` and invokes `volumeFiles.uploadFiles` with `localPaths`; the renderer never handles path strings. All methods go through the mock-aware `invoke`, so `__test.mock('volumeFiles.list', …)` works.

- [ ] **Step 1: Write the failing tests** in `preload.test.ts`: `should invoke volumeFiles.list with game, volume and path`; `should resolve dropped files to paths in the preload` (`webUtils.getPathForFile` mocked → `'/tmp/a.txt'`; `invoke` called with `('volumeFiles.uploadFiles', { game: 'mc', volume: 'saves', dir: '/', localPaths: ['/tmp/a.txt'] })`); `should route a mocked volumeFiles channel through __test.mock`; `should subscribe and unsubscribe session events`.
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/desktop-preload/src/preload.test.ts` → FAIL.
- [ ] **Step 3: Implement**; add bridge entries.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Docs** — `write-docs`: `volumeFiles.*` rows and the two push channels in `management-app.md`.
- [ ] **Step 6: Gate** — `npm run app:lint && npm run app:typecheck && npm run app:test && npm run app:test:integration && npm run app:test:e2e` → exit 0.
- [ ] **Step 7: Commit** — `feat(desktop-preload): add the volumeFiles bridge`. Open PR 4 with `/pr` (base: PR 3 branch).

---

## PR 5 — `feat(web)`: in-app file browser page replaces the external link

Branch from PR 4's branch. Covers tasks.md 5.1–5.6.

### Task 21: Session and listing hooks (tasks.md 5.1)

**Files:**
- Modify: `app/packages/web/src/api.service.ts` (add `volume*` wrappers over `hyveon().volumeFiles`)
- Create: `app/packages/web/src/components/volume-files/use-volume-session.hook.ts` (+test), `use-volume-files.hook.ts` (+test)

**Interfaces:**
- Produces:
  - `useVolumeSession(game: string): { status: VolumeSessionStatus | null; start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; error: string | null }` — on mount `sessionAttach`; on unmount `sessionDetach`; subscribes to `onSession`; registers `usePoller(VOLUME_SESSION_POLLER = 'volumeSession', refresh, 3000, status?.state === 'starting' || status?.state === 'stopping')`, so polling continues until `running` (ready) or a terminal state.
  - `useVolumeFiles(game: string, volume: string | null, enabled: boolean): { path: string; listing: VolumeEntryInfo[] | null; sort: { key: 'name' | 'size' | 'modifiedMs'; dir: 'asc' | 'desc' }; setSort; open(path: string): void; refresh(); mkdir(name); rename(path, newName); remove(path); readText(path); writeText(path, content, expectedModifiedMs); download(entry); uploadFiles(); uploadDropped(files: File[]); uploadFolder(); transfers: VolumeTransferProgress[]; error: string | null }` — changing `volume` resets `path` to `/`; directories sort before files; each mutation refreshes the listing on success and sets `error` from `result.message` on failure.

- [ ] **Step 1: Write the failing tests** (jsdom, `vi.mock('../../api.service.js')`):
  - `should attach on mount and detach on unmount`.
  - `should keep polling while starting and stop once running` — status sequence `starting`, `starting`, `running`; fake timers; `sessionStatus` called 3 times then not again.
  - `should list the root when enabled and sort folders first` — entries `b.txt`, `A/`, `a.txt` → `['A', 'a.txt', 'b.txt']`.
  - `should surface a conflict message and keep the listing` — `rename` → `{ ok: false, code: 'conflict', message: 'x exists' }` → `error === 'x exists'`.
  - `should not list while disabled`.
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/web/src/components/volume-files` → FAIL.
- [ ] **Step 3: Implement** (re-arm any `mountedRef` in the effect body per `typescript-conventions.md`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add volume session and listing hooks`.

### Task 22: Page and components (tasks.md 5.2, 5.3)

**Files:**
- Create in `app/packages/web/src/components/volume-files/`: `session-bar.component.tsx`, `volume-picker.component.tsx`, `volume-breadcrumb.component.tsx`, `file-table.component.tsx`, `file-actions.component.tsx`, `name-dialog.component.tsx`, `text-editor-dialog.component.tsx`, `drop-zone.component.tsx`, `transfer-list.component.tsx`
- Create: `app/packages/web/src/pages/volume-files.page.tsx`, `volume-files.page.test.tsx`
- Modify: `app/packages/web/src/app.component.tsx:107` (add `<Route path="/games/:name/files" element={<VolumeFilesPage />} />`), `app/packages/web/src/pages/dashboard.page.tsx` (Files → `navigate(\`/games/${game}/files\`, { state: { autoStart: true } })`), `app/packages/web/src/pages/game-detail.page.tsx:139-141` (a "Files" link in the `PageHeader` actions)

**Interfaces:**
- Consumes: Task 21 hooks; `useGameStatus()` (server `state` `starting`/`running` → read-only); `PageHeader`, `ConfirmDialog`, `EmptyStateCard`, `InlineAlert`, `LoadingState`, `ui/table`, `ui/button`, `ui/dialog`, `ui/textarea`, `ui/badge`; `FolderUploadProgressMeter` + `useFolderUploadProgress(game)` for folder uploads.
- Produces:
  - Page reads `location.state?.autoStart`; when true and the session is `stopped`, calls `start()` once and replaces the history entry with `state: null` (so Back/refresh does not relaunch). Without it, the page only shows state (spec "Opening the page directly").
  - Session bar: state badge, elapsed (`useNowTick`), auto-stop countdown, warning text when `autoStopAt - now < AUTO_STOP_WARNING_MS`, buttons Start (stopped/failed), Stop (running; a `ConfirmDialog` "This cancels the running upload." when `uploadHolders > 0`), Restart (orphaned/failed), failure `error` shown via `InlineAlert`.
  - Volume picker: one option per `status.volumes` entry showing name and container path; defaults to the first mounted volume; an entry with `mounted: false` is disabled with "Apply the infrastructure to browse this volume." The breadcrumb root is the selected volume's name.
  - Read-only banner text: "The server is running. Stop it to change files." — mutating buttons `disabled` with that `title`. When a mutation returns `server-check-failed`, or the game status is `error`, the banner reads "Couldn't confirm the server is stopped." with a Retry button that calls `useGameStatus().refreshGame(game)` and re-enables actions once the status is `stopped`.
  - Delete confirm wording: file → "Delete <name>?"; folder → "Delete <name> and everything in it?".
  - Name dialog validates with `isValidEntryName` before submit ("Names can't contain / or be . or ..").
  - Text editor: opens on a file row action when `size <= MAX_TEXT_EDIT_BYTES`; on `too-large`/`binary` shows "This file can't be edited here. Download it instead." with a Download button; on save `conflict` keeps the textarea content and shows the message.
  - Folder download action hidden when `status.supportsArchive` is false.
  - `not_deployed` → `EmptyStateCard` "This game's volume doesn't exist yet. Apply the infrastructure first." with no session or file actions.

- [ ] **Step 1: Write the failing routed-page tests** with `renderPage(<Routes><Route path="/games/:name/files" element={<VolumeFilesPage />} /></Routes>, { initialEntries: ['/games/mc/files'] })` and a mocked `api`:
  - `should show session state without starting a helper when opened directly` — `sessionStart` not called.
  - `should start the session when arriving from the dashboard Files action` — `initialEntries: [{ pathname: '/games/mc/files', state: { autoStart: true } }]` → `sessionStart` called once.
  - `should navigate into a folder and update the breadcrumb`.
  - `should sort by size when the size header is clicked`.
  - `should disable mutating actions while the server is running` — game status `running` → New folder/Upload/Rename/Delete disabled; Download enabled.
  - `should disable mutating actions and offer Retry when the server state can't be confirmed` — `mkdir` returns `server-check-failed` → banner "Couldn't confirm the server is stopped.", Retry calls `refreshGame('mc')`.
  - `should list the selected volume when the operator switches volumes` — volumes `config`, `saves`; selecting `saves` → `volumeList` called with `('mc', 'saves', '/')`.
  - `should show an unapplied volume as unavailable` — `{ name: 'mods', mounted: false }` option disabled with the apply text.
  - `should confirm before deleting a folder with folder wording`.
  - `should keep edits and show a conflict on save` — `writeText` → `conflict`; textarea still holds the edited text.
  - `should offer only Restart for an orphaned session`.
  - `should explain a not-deployed volume and offer no actions`.
  - `should warn when fewer than ten minutes remain before auto-stop`.
  - `should hide folder download when the backend has no archive support`.
  - Dashboard: update `dashboard.page.test.tsx` Files case to `should navigate to the game's files page when Files is clicked`.
- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run packages/web/src/pages/volume-files.page.test.tsx packages/web/src/pages/dashboard.page.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; each component body < ~200 lines; the `.map()` row in `file-table` is its own `FileRow` component.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add the in-app file browser page`.

### Task 23: Remove the external-link path (tasks.md 5.4)

**Files:**
- Delete: `web/src/components/file-manager-modal.component.tsx` (+test), `web/src/hooks/use-file-manager.hook.ts` (+test), `desktop-main/src/controllers/files.controller.ts` (+test)
- Modify: `desktop-main/src/app.module.ts` (drop `FilesController`), `desktop-main/src/services/FileManagerService.ts` (delete `start`, `getStatus`, `FileMgrStatus`, `FileMgrResult.credentials`, the `tls: false` branch — every launch is TLS; `HelperLaunchOptions.tls` removed), `desktop-preload/src/preload.ts:444-448` and `hyveon-api.ts` (`files` namespace, `FileMgrStatus`, `FileMgrCredentials`, `FileMgrResult`), `web/src/api.service.ts:184-200,286-288` (`FileMgr*`, `filesMgr*`), `web/src/pages/dashboard.page.tsx` (modal mount), `web/src/components/folder-upload/folder-upload-card.component.tsx:97-106` (`stopHelperAndRetry` → `api.volumeSessionStop(game)` then retry; prompt text "Restart the file manager session"), `web/e2e/fixtures/hyveon-http-bridge.ts:54-57`

- [ ] **Step 1: Delete and update**; `grep -rn "files\.list\|files\.start\|files\.stop\|filesMgr\|FileMgrCredentials\|FileManagerModal\|useFileManager\|credentials?:" app/packages --include='*.ts' --include='*.tsx'` → no hits outside `node_modules` (the `credentials` hits that remain are the registry's private entry field only).
- [ ] **Step 2: Update** `folder-upload-card.component.test.tsx`'s helper-open case: `should stop the orphaned session and retry the upload` (`volumeSessionStop` then `folderStartUpload` called).
- [ ] **Step 3: Run** `npm run app:typecheck && npm run app:test` → exit 0.
- [ ] **Step 4: Commit** — `refactor(app): remove the external FileBrowser link and legacy files channels`.

### Task 24: Playwright specs and docs (tasks.md 5.5, 5.6)

**Files:**
- Create: `app/packages/web/e2e/pages/VolumeFilesPage.ts` (export from `e2e/pages/index.ts`), `app/packages/web/e2e/specs/volume-files.spec.ts` (chromium), `app/packages/web/e2e/specs/volume-files-electron.spec.ts` (add to `ELECTRON_SPECS` in `playwright.config.ts`)
- Modify: `docs/docs/app/dashboard.md`, `docs/docs/app/games.md`, `docs/docs/architecture.md` (secrets boundary wording), `docs/docs/setup.md` only if it mentions the file manager link (check with `grep -n "file manager\|FileBrowser" docs/docs/setup.md`)

**Interfaces:**
- `VolumeFilesPage`: `sessionState()`, `startButton()`, `stopButton()`, `restartButton()`, `row(name)`, `breadcrumb()`, `newFolderButton()`, `readOnlyBanner()`, `goto(game)` (uses `hashRoute`).

- [ ] **Step 1: Write the chromium spec** (through the page object and bridge routes): `should browse into a folder from the dashboard Files action`; `should show the read-only banner while the server runs`; `should never receive a credential, IP or URL in volumeFiles responses` (intercept every `/api/volume-files/*` response and assert no key/value matches the `expectNoSecretFields` pattern).
- [ ] **Step 2: Write the electron smoke spec**: `should render the files route and call volumeFiles.session.start on Start` (`__test.mock('volumeFiles.session.status', …stopped…)`, record calls to `volumeFiles.session.start`).
- [ ] **Step 3: Run** `npm run app:test:e2e` → exit 0 (both projects).
- [ ] **Step 4: Docs** — `write-docs`: the files page, session behaviour (Start, grace stop, quit, auto-stop warning), the read-only rule, and the removal of the external link/password in `dashboard.md` and `games.md`; screenshots only if `e2e/screenshots/capture.spec.ts` covers these pages.
- [ ] **Step 5: Gate** — `npm run app:lint && npm run app:typecheck && npm run app:test && npm run app:test:e2e` → exit 0.
- [ ] **Step 6: Commit** — `docs: document the in-app file browser`. Open PR 5 with `/pr` (base: PR 4 branch).

---

## Close-out (tasks.md 6.1–6.4)

- [ ] **Infra apply after PR 2 is released** (tasks.md 6.1): the operator runs plan + apply once from the Infrastructure page; expected plan: `efsVolumeAccessPoints` output change only, empty resource diff. Mark `[~]` if not run this cycle and list it in verify.md §7 (automated equivalents: Tasks 6, 7, 9).
- [ ] **Dogfood on a real stack** (tasks.md 6.2; mark `[~]` if not run and list it in verify.md §7 with Tasks 8, 13, 17, 18, 22 as the automated equivalents): start from Files, switch volumes, navigate, upload a folder into a second volume and confirm it lands there, download a file and a folder, rename, delete, edit `options.json`, confirm read-only while the server runs, confirm the helper stops 5 min after leaving the page and on quit.
- [ ] **`/opsx:verify`**, then `/opsx:sync` or `/opsx:archive` (tasks.md 6.3).
- [ ] **Follow-up issue** for replacing the archived FileBrowser backend (tasks.md 6.4; Open Question 3 default).
