<!--
PR stack (per .claude/rules/pr-stacking.md). Each numbered group from 1 to 5 is one PR, branched from the previous group's branch; group 1 bases on `main`.
Every PR must pass `npm run app:lint`, `app:typecheck` and `app:test` with exit code 0, plus `app:test:integration` (groups 2–3) and `app:test:e2e` (groups 3–4).
Docs ship in the PR whose behaviour they describe (no dedicated docs PR).
The current external-link flow is not patched separately; group 4 deletes it.
-->

## 0. Prerequisites (no code PR)

- [x] 0.1 Archive `add-folder-volume-upload` (`/opsx:archive`) so `openspec/specs/game-volume-folder-upload/spec.md` exists for this change's MODIFIED delta, then rebase this change's branch on it.
- [x] 0.2 Record the operator's answers to design.md Open Questions 1–6 in design.md. Adjust the affected tasks below if any answer differs from the default.

## 1. PR 1 — `refactor(desktop-main)`: volume file backend interface and path safety

- [ ] 1.1 Define the `VolumeFileBackend` interface in desktop-main: `list`, `stat`, `readStream`, `writeStream`, `mkdir`, `move`, `remove`, optional `archiveStream`, plus typed error results (`not-found`, `conflict`, `unreachable`, `auth`, `pin-mismatch`). Give it TSDoc per `.claude/rules/tsdoc-tags.md`.
- [ ] 1.2 Extend `FileBrowserClient` to implement the interface. Add raw download (`GET /api/raw`), rename/move (`PATCH ?action=rename`), delete (`DELETE /api/resources`), stat, and folder archive (`?algo=zip`). Keep the existing pinned-fingerprint check on every request.
- [ ] 1.3 Migrate `uploadEngine` onto the interface so there is exactly one FileBrowser HTTP client (`.claude/rules/duplication.md`), and name this extraction in the PR body.
- [ ] 1.4 Add the volume path validator (absolute POSIX under the root, no `..`/NUL/empty segments, and names without `/`). Use it in the upload planner as well.
- [ ] 1.5 Pin `FILEBROWSER_IMAGE` to the v2.63.23 image digest, looked up from the registry rather than written from memory (`~/.claude/rules/dependencies.md`), with a comment noting the project is archived and the pin is deliberate.
- [ ] 1.6 Extend `fake-filebrowser-server` with raw, rename, delete, stat, zip and TLS. Add unit tests for every backend method, including pin mismatch and the validator's traversal cases.

## 2. PR 2 — `feat(desktop-main)`: helper session registry with TLS browse sessions

- [ ] 2.1 Extract the launch/teardown bodies of `FileManagerService` so both the legacy `start()` and the registry call them, with no duplicated launch code.
- [ ] 2.2 Add `HelperSessionRegistry` with `acquire(game, holder)`, `release(game, holder)` (the browse holder's grace timer is configurable, default 5 min), `stop(game)`, `status(game)`, and the `orphaned` detection for an ECS helper with no registry entry.
- [ ] 2.3 Registry-launched sessions always use `buildTlsContainerSettings`. Readiness = task RUNNING, public IP present, and a successful backend login over the pinned connection. Surface the stop reason on early exit.
- [ ] 2.4 On connect failure, re-detect the operator IP. If it changed, authorize the new `/32`, revoke the orphaned rules through the existing reference-counted revoke, and retry once.
- [ ] 2.5 Make `FolderUploadService` acquire/release a registry session (holder = run id) instead of `startForUpload` + `stop`. Replace the `helper-open` refusal with "reuse if registry-held, Restart if orphaned". Keep upload tags on helpers the upload launched.
- [ ] 2.6 Make `sweepStrayHelpers` skip helpers owned by a registry session as well as active runs.
- [ ] 2.7 Add a `before-quit` hook that stops registry-owned helpers with a bounded timeout, without blocking quit indefinitely.
- [ ] 2.8 Add unit tests: refcount, grace expiry and cancel-on-return, stop with an active upload, quit, orphan, IP re-authorization, sweep exclusion. Add integration-tier wiring tests in the in-process Nest container.
- [ ] 2.9 Docs: `docs/docs/components/management-app.md` (registry, TLS for all helper sessions) and `docs/docs/architecture.md` (helper transport, secrets boundary), via the `write-docs` skill.

## 3. PR 3 — `feat(app)`: volumeFiles IPC surface and preload API

- [ ] 3.1 Add shared request/result/event types for `volumeFiles` in a `@hyveon/shared` subpath module, not the barrel. They must contain no credential, token, IP or URL fields.
- [ ] 3.2 Add `VolumeFilesService`: session start/stop/restart/status through the registry, and list/mkdir/rename/delete/readText/writeText through the backend. Validate every path. Refuse mutations with `server-running` while the game's server task is STARTING/RUNNING. Enforce the 1 MiB/UTF-8 text limits and the mtime conflict check. Normalize and log errors per `.claude/rules/logging.md`.
- [ ] 3.3 Implement downloads: a native save dialog, streaming to disk with progress events and cancel, deletion of the partial file on cancel/failure, Windows-reserved local filename sanitization, and folder archive only when the backend supports it.
- [ ] 3.4 Implement `uploadFiles` (dialog or drag-dropped paths) through the backend, and `uploadFolder` delegating to the folder-upload flow with the current directory as its destination.
- [ ] 3.5 Add `VolumeFilesController` with `@MessagePattern` handlers, each logging on entry with safe identifiers only, and an electron-bootstrap guard per the existing controller pattern.
- [ ] 3.6 Add the preload `window.hyveon.volumeFiles` API and event subscriptions, plus `webUtils.getPathForFile` for drag-and-drop, and wire them through the `__test.mock` seam.
- [ ] 3.7 Add tests: service unit tests (validation, read-only refusal, text limits, conflict, download partial-file cleanup, no secret fields in any result), controller tests, and a preload bridge test.
- [ ] 3.8 Docs: `docs/docs/components/management-app.md` IPC channel table.

## 4. PR 4 — `feat(web)`: in-app file browser page replaces the external link

- [ ] 4.1 Add the `use-volume-files.hook.ts` hook: session state via the shared `PollingProvider` while starting (until ready, not merely RUNNING), the listing for the current path, operations, and download/upload progress.
- [ ] 4.2 Add the `/games/:name/files` page with these components:
  - session bar (state, elapsed, auto-stop countdown with the 10-minute warning, Start/Stop/Restart);
  - breadcrumb;
  - sortable file table;
  - action bar;
  - delete confirm (folder wording);
  - rename/new-folder dialogs with validation;
  - text editor;
  - drag-and-drop zone.

  Reuse existing `ui/` primitives, keep each component under the size rule, and disable mutating actions while the server runs.
- [ ] 4.3 Make the dashboard card Files action navigate and start the session, and add a Files link on the game detail page.
- [ ] 4.4 Delete `FileManagerModal`, `useFileManager`, the legacy `files.list|start|stop` channels/controller/preload API, `FileMgrResult.credentials`/`FileMgrStatus.url`, and `FileManagerService.start()`/`getStatus()` once unused.
- [ ] 4.5 Add tests:
  - jsdom hook tests;
  - a routed-page test (navigate, sort, disabled-while-running, delete confirm, editor conflict, orphaned → Restart);
  - a Playwright chromium spec through the IPC mock;
  - one Playwright electron smoke test (route renders, Start calls `volumeFiles.session.start`);
  - assert that no IPC payload reaching the renderer carries credential, IP or URL fields.
- [ ] 4.6 Docs: `docs/docs/app/dashboard.md` and `docs/docs/app/games.md` (new page, session behaviour, read-only rule), plus screenshots if the docs-screenshot capture covers these pages, via the `write-docs` skill.

## 5. Close-out

- [ ] 5.1 Manual dogfood on a real stack (`[~]`-eligible if not run, recorded in verify.md): start a session from Files, navigate, upload a folder, download a file and a folder, rename, delete, edit `options.json`, confirm the read-only state while the server runs, and confirm the helper stops after leaving the page and on quit.
- [ ] 5.2 `/opsx:verify`, then `/opsx:sync` or `/opsx:archive` so `openspec/specs/` contains `game-volume-file-browser` and the updated `game-volume-folder-upload`.
- [ ] 5.3 Open a follow-up issue for replacing the archived FileBrowser backend (Open Question 3), unless the operator chose to fold it in.
