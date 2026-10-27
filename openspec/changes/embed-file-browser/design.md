## Open Questions

**Resolved 2026-10-26:** the operator accepted every default below as written. The tasks already assume these defaults, so no task changes were needed.

1. **Auto-start on page entry, or an explicit Start?** Default: explicit **Start session** on the Files page. The dashboard **Files** button navigates *and* starts, since clicking it states the intent; navigating to the page any other way only shows state. Auto-start on every page entry bills and opens a `/32` rule silently.
2. **Write access while the game server runs.** Default: read-only while the server task is STARTING/RUNNING, with no override. Alternative: allow writes behind a confirm ("the server may overwrite or corrupt this").
3. **Replace the archived FileBrowser image in this change or a follow-up?** Default: follow-up. This change pins `filebrowser/filebrowser` to the final v2.63.23 digest and puts it behind `VolumeFileBackend`. Candidates for the follow-up: Lambda-on-EFS (no public exposure, no cold start; new VPC Lambda + S3 hop for >6 MB), a minimal purpose-built helper image, or a maintained fork.
4. **v1 scope of text editing.** Default: view and edit UTF-8 files ≤ 1 MiB with an mtime conflict check (covers FoundryVTT `options.json`, game `*.ini`). Alternative: view-only in v1.
5. **Grace period before stopping an unheld session after leaving the page.** Default: 5 minutes. Alternatives: stop immediately, or rely only on the 2 h auto-stop.
6. **Keep a "Open in external browser" escape hatch?** Default: no. It reintroduces the plaintext-credential and egress-mismatch problems this change removes.

## Context

**Current flow.** The dashboard card's **Files** button (`game-card.component.tsx:266`) opens `FileManagerModal`, driven by `useFileManager`. **Launch** calls `files.start` → `FilesController` → `FileManagerService.launch`, which:
- registers a throwaway `filebrowser-{game}` task definition mounting the game's EFS access point;
- opens an operator-IP `/32` ingress on the shared file-manager SG (port 8080);
- runs the task with a public IP and creates a 2 h EventBridge auto-stop schedule;
- returns a one-time username/password.

Once the task is RUNNING, the modal renders `<a href="http://<ip>:8080" target="_blank">` and the credential. `setDefaultBrowserOpener` (`electron-entry.ts:44-51`) converts the `window.open` into `shell.openExternal`.

**Root cause of the reported "click does nothing"** (full notes in `brainstorm.md`). The operator's log for the session shows the helper launched, the `/32` was authorized for the operator's current IP, and `getStatus` returned `running` with `url: http://<ip>:8080` at the first RUNNING read. The helper's CloudWatch log shows FileBrowser listening for the whole session. The operator then confirmed that clicking the link did open the page, but the OS opened the browser window behind another application without focusing it, so from inside Hyveon nothing appeared to happen. The external-browser hop worked; it is just invisible from the app. This change removes that hop, which is why no fix to today's external link is planned.

The investigation also found weaknesses in the external hop that this change removes rather than fixes:
- `openExternal` rejections go only to `console.error`, which a packaged build discards.
- Reachability requires the browser's egress IP to equal the IP the main process detected via `checkip.amazonaws.com`. Since #672's infra edit removed the world-open rule, any divergence is a silent connect timeout.
- `useFileManager` stops polling once `pendingStart` clears on the first `running` read, even if `url` is still undefined, so the link would never appear (`use-file-manager.hook.ts:122-136`).

The operator chose not to patch the current external-link flow, since the renderer swap in this change deletes it.

**FileBrowser is archived.** The helper image prints the project's wind-down notice at startup. The repo was archived 2026-09-01, the final release is v2.63.23, and advisories remain unfixed (non-revocable JWTs among them). `:latest` is frozen.

**Constraints:**
- No persistent ECS Service.
- Secrets never reach the renderer.
- No HTTP transport in the desktop app (IPC only).
- `@hyveon/shared`'s barrel stays free of new AWS SDK imports.
- No host-installed binaries.
- Every IPC handler logs on entry, and no raw SDK error escapes (`.claude/rules/logging.md`).
- Duplication is extracted at the second copy (`.claude/rules/duplication.md`).

**Stakeholders:** the operator (single-user desktop console).

## Goals / Non-Goals

**Goals:**
- Browse and manage a game's volume files entirely inside the app: list, navigate, upload (files and folders), download, new folder, rename, delete, and view/edit small text files.
- desktop-main is the only client of the helper. Credentials and URLs never cross IPC.
- All helper traffic is TLS with a per-launch pinned certificate, browse sessions included.
- One app-owned helper session per game, shared by browse and upload, stopped when no longer used.
- FileBrowser is isolated behind an interface so it can be replaced.
- Failures are visible: every helper/file operation logs, and errors surface in the UI.

**Non-Goals:**
- Replacing the FileBrowser image or backend (follow-up — Open Question 3).
- Previews, search, share links, archive extraction, or multi-select bulk move in v1.
- Browsing volumes of games whose infrastructure is not applied.
- Removing the 30–60 s helper cold start.
- Changing infra, IAM, or `deployment-config.json`.
- Fixing or polishing the current external-link flow (focus, logging, Copy URL). It is deleted by this change.

## Decisions

### D1: Native renderer page backed by IPC, not an embedded FileBrowser UI
- **Choice**: Build a routed `/games/:name/files` page in `@hyveon/web`. desktop-main exposes typed `files.*` IPC operations and calls the helper's REST API itself.
- **Rationale**:
  - FileBrowser is archived, and embedding its SPA would put unpatched remote content in the operator console.
  - The native page keeps the credential in main, and the operator never sees it.
  - It avoids `WebContentsView` z-order problems: the view draws above all renderer DOM, so app dialogs and toasts can't overlay it, and bounds must be synced over IPC with DIP/zoom conversion.
  - It matches app theme, keyboard and accessibility.
  - It is testable with existing seams (jsdom, IPC `__test.mock`, `fake-filebrowser-server`).
- **Alternatives considered**:
  - (a) `WebContentsView` embedding FileBrowser's SPA in an in-memory partition, with `setCertificateVerifyProc` pinning, a navigation allowlist, deny-all permission handlers, and the JWT seeded via cookie + localStorage, or FileBrowser proxy auth via an injected header. Rejected: unpatched remote UI, a token in renderer-adjacent storage (proxy auth trusts anyone who can set the header), z-order/bounds complexity, and the archived UI becoming our product surface. `BrowserView` is deprecated and `<webview>` is discouraged upstream, so (a) would have meant `WebContentsView`.
  - (c) Hybrid (native core plus embedded SPA as "Advanced"). Rejected for v1: it inherits all of (a)'s costs for long-tail features.
  - Keep the external browser and only fix its rough edges (focus, logging, polling). Rejected, because plaintext HTTP, a hand-copied password, a context switch out of the app and the egress-mismatch fragility remain.

### D2: Transport stays public IP + operator `/32` + pinned TLS, now for browse too
- **Choice**: Browse launches use `buildTlsContainerSettings` exactly like upload launches. The per-launch `EphemeralCert` fingerprint is pinned by the backend client on every request. Ingress is the existing app-managed `/32` for the main process's detected IP.
- **Rationale**: With main as the only client, the IP that `checkip` sees is the IP requests come from, so the egress-mismatch failure class disappears. TLS plus pinning removes the plaintext-credential exposure. No infra change is needed.
- **Alternatives considered**:
  - SSM/ECS Exec port-forward. Rejected: it requires the host `session-manager-plugin` binary.
  - Caddy sidecar with an ACME cert. Rejected: DNS plus issuance per launch for a client that can pin.
  - Lambda mounted on EFS. Deferred as a future `VolumeFileBackend` (Open Question 3).

### D3: Main-process helper session registry shared by browse and upload
- **Choice**: Add a `HelperSessionRegistry` (desktop-main, singleton) keyed by game. Each entry is `{taskArn, ip, credentials, cert, backend, holders: Set<'browse'|uploadRunId>, state}`.
  - `acquire(game, holder)` launches the helper if no entry exists (via the extracted `FileManagerService.launch`), or reuses the existing one.
  - `release(game, holder)` tears down (stop task, delete schedule, deregister task def, revoke orphaned `/32`) when `holders` empties. For the browse holder this happens after the grace period (Open Question 5).
  - `stop(game)` force-releases all holders and cancels any upload run first, with a confirm in the UI.
  - `before-quit` stops every registry-owned helper, best-effort with a bounded timeout.
  - A helper present in ECS with no registry entry is reported as `orphaned`. The only offered action is **Restart session** (stop, then start).
- **Rationale**: Removes the `helper-open` refusal's premise (an unknown credential), keeps "one helper per game", and ends sessions with use.
- **Alternatives considered**:
  - Persisting credentials (safeStorage) to survive restarts. Rejected: it widens secret storage for a rare case, and Restart is cheap.
  - Separate helpers for browse and upload. Rejected: it breaks the one-per-game invariant and the shared SG rule accounting, and doubles cost.

### D4: `VolumeFileBackend` interface; FileBrowser is the first implementation
- **Choice**: Define the interface in desktop-main:
  - `list(dir)`, `stat(path)`
  - `readStream(path)`, `writeStream(path, {overwrite})`
  - `mkdir(path)`, `move(from, to)`, `remove(path, {recursive})`
  - optional `archiveStream(dir)`

  `FileBrowserClient` (from #672) is extended to implement it, adding the `GET /api/raw`, `PATCH ?action=rename`, `DELETE`, and `?algo=zip` endpoints. The upload engine is migrated onto the interface so there is one FileBrowser client. Pin the image to the v2.63.23 digest.
- **Rationale**: Bounds the archived dependency to one class, and makes a backend swap a desktop-main-only change.
- **Alternatives considered**: Calling FileBrowser directly from a new service. Rejected: it would be a second FileBrowser HTTP client, which `.claude/rules/duplication.md` forbids.

### D5: IPC contract carries names, sizes, times and progress — never URLs or secrets
- **Choice**: Add a new `volumeFiles` IPC namespace and preload API (`window.hyveon.volumeFiles`), so it can land additively next to the legacy `files.*` channels:
  - Session channels: `volumeFiles.session.status|start|stop|restart`, plus a session-state event channel.
  - Operations: `volumeFiles.list`, `.mkdir`, `.rename`, `.delete`, `.readText`, `.writeText`, `.download` (main opens the save dialog and streams, with a progress event), `.uploadFiles` (paths chosen via the native dialog or drag-drop), and `.uploadFolder` (delegates to #672's folder-upload flow targeted at the current directory).

  Shapes live in a `@hyveon/shared` subpath module. The legacy `files.list|start|stop` channels, `FileMgrResult.credentials` and `FileMgrStatus.url` are deleted in the renderer-swap PR. The preload exposes `webUtils.getPathForFile` for drag-and-drop, because Electron ≥ 32 removed `File.path`.
- **Rationale**: Enforces the secrets-never-reach-the-renderer invariant structurally, and the renderer cannot open a connection to the helper even if it wanted to.
- **Alternatives considered**: Streaming file bytes over IPC for upload/download. Rejected: main reads and writes local paths directly, so only paths and progress cross IPC.

### D6: Path safety in main
- **Choice**: Every volume path is POSIX-normalized and must be absolute under the volume root. Segments of `..`, NUL bytes and empty names are rejected before reaching the backend. Rename and new-folder names reject `/`. Local save/upload paths come only from native dialogs or drag-drop resolution in main.
- **Rationale**: Defence in depth on top of FileBrowser's own `--root /srv` jail, and required for any future backend that lacks one.
- **Alternatives considered**: Trusting the backend's root jail. Rejected: backend-specific and unverifiable for future backends.

### D7: Read-only while the game server is running
- **Choice**: The page reads game status (existing `games.status`). While the server task is STARTING/RUNNING, mutating IPC handlers refuse with a typed `server-running` result, and the UI disables those actions with an explanation. Upload already enforces this (#672).
- **Rationale**: Concurrent EFS writes under a live server can corrupt saves. Reads are safe.
- **Alternatives considered**: Allow writes with a warning (Open Question 2).

### D8: Text view/edit for small files
- **Choice**: `files.readText` refuses files over 1 MiB or that are not valid UTF-8 (typed `too-large` / `binary` results). `files.writeText` takes the mtime the editor loaded and refuses on mismatch (`conflict`). The editor is a plain monospace textarea: no syntax highlighting, no new dependency.
- **Rationale**: Covers the common "tweak a config file" job without an editor dependency.
- **Alternatives considered**: CodeMirror/Monaco. Rejected for v1: weight and dependency surface for a niche need.

### D9: Session lifecycle UX and cost
- **Choice**: The session bar shows state (`stopped`/`starting`/`running`/`stopping`/`orphaned`/`not_deployed`), elapsed time and time until auto-stop. It offers Start/Stop/Restart. While `starting`, it polls via the shared `PollingProvider`, and keeps polling until the backend reports ready, not merely `RUNNING`. Ready means the task is RUNNING, it has a public IP, and the backend login succeeds over the pinned TLS. This fixes the stop-early bug by construction.
- **Rationale**: Sessions end with use, and "ready" is defined by an authenticated round-trip rather than an ECS status.
- **Alternatives considered**: Auto-start on page entry (Open Question 1).

### D10: Testing approach
- **Choice**:
  - desktop-main unit tests: registry (acquire/release/refcount/grace/quit/orphan), path validation, backend against the existing `fake-filebrowser-server` (extended with raw, rename, delete, zip and TLS), service error normalization, IPC controller entry logs.
  - web jsdom tests: the `use-volume-files` hook, and a routed-page test for `/games/:name/files` (navigation, disabled-while-running, delete confirm, editor conflict).
  - Playwright chromium: spec driving the page through `window.hyveon.__test.mock()`. Streaming download progress is asserted in jsdom, because the contextBridge cannot clone async generators.
  - Playwright electron: one smoke test that the route renders and Start calls `volumeFiles.session.start`.
  - Integration tier (in-process Nest): the registry wired with real services against fakes.
  - No live-AWS test in CI. Manual dogfood against a real stack is listed in tasks as `[~]`-eligible.
- **Rationale**: Uses established seams (`docs/docs/components/integration-tests.md`).
- **Alternatives considered**: None.

### D11: Platform behaviour
- **Choice**: There are no platform branches. Native dialogs (`showOpenDialog` / `showSaveDialog`) and drag-and-drop through `webUtils.getPathForFile` behave the same on Windows, macOS and Linux. Downloads are written with the OS path module, and only volume paths are POSIX. On Windows, local filenames with characters reserved on Windows (`<>:"/\|?*`) or reserved names (`CON`, `NUL`, …) are sanitized at download time, and the UI reports the renamed target.
- **Rationale**: The renderer-native approach avoids the `WebContentsView` platform quirks (Wayland, fractional scaling) entirely.
- **Alternatives considered**: None.

## Risks / Trade-offs

- [Risk] More UI to build and maintain than an embed. → Mitigation: tight v1 scope (Non-Goals), reuse of the existing table/dialog/progress primitives and #672's upload engine and meter, and a component-size rule enforced in review.
- [Risk] The archived FileBrowser keeps running as the backend. → Mitigation: pinned digest, reachable only by the main process from one `/32` over pinned TLS, a per-launch random credential, sessions bounded by use plus the 2 h backstop, and the backend interface to replace it (Open Question 3).
- [Risk] Main-process egress IP changes mid-session (Wi-Fi switch, VPN toggle). → Mitigation: on connect failure the backend re-detects the IP. If it changed, it authorizes the new `/32`, revokes the old one through the existing reference-counted revoke, and retries once. Otherwise it surfaces a typed `unreachable` error with a Restart action.
- [Risk] App crash leaves a helper and a `/32` rule. → Mitigation: the existing startup orphan sweep and 2 h auto-stop. A crash-left helper shows as `orphaned` with Restart.
- [Risk] Long downloads or uploads outlive the 2 h auto-stop. → Mitigation: the session bar warns at 10 minutes remaining. Extending the schedule is out of scope; upload already has Resume.
- [Risk] Removing `credentials`/`url` from IPC breaks anything else reading them. → Mitigation: only `file-manager-modal` and `use-file-manager` consume them, and both are deleted in the same PR as the route swap.
- [Trade-off] FileBrowser niceties (previews, search, share links) are dropped. → Accepted: not needed for the save/config-file jobs operators do, and they can be added on the native page later.
- [Trade-off] An orphaned helper can't be reattached after a restart. → Accepted: credentials are deliberately not persisted, and Restart costs ~30–60 s.

## Migration Plan

1. Archive `add-folder-volume-upload` so `openspec/specs/game-volume-folder-upload/spec.md` exists for this change's delta.
2. Ship the PR stack in `tasks.md` order. Each PR passes lint, typecheck, unit, plus integration/e2e where relevant, on its own. The renderer swap (new page + removal of modal, link and credentials) lands in one PR so there is never a window where neither path works.
3. No infra apply, IAM change or data migration. Helpers launched by an older build are handled by the orphan path (Restart) and the startup sweep.
4. **Rollback:** revert the renderer-swap PR to restore the modal. The backend and registry PRs are additive and safe to leave in place. Browse-over-TLS would also need reverting, because the old modal links to `http://`.
5. **Acceptance:**
   - the operator opens Files, starts a session, navigates, uploads, downloads, renames, deletes and edits `options.json` on a real stack without leaving the app;
   - no credential or helper URL appears in the renderer (IPC payload assertions in tests);
   - leaving the page stops the helper after the grace period;
   - `npm run app:lint`, `app:typecheck`, `app:test`, `app:test:integration` and `app:test:e2e` all pass.
