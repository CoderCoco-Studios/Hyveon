<!--
PR stack (per .claude/rules/pr-stacking.md). Each numbered group from 1 to 5 is one PR, branched from the previous group's branch; group 1 bases on `main`.
Groups were renumbered on 2026-10-26: multi-volume mounting and the #672 wrong-volume fix got their own PR (group 2), so the registry, IPC and web PRs are now groups 3, 4 and 5.
Every PR must pass `npm run app:lint`, `app:typecheck` and `app:test` with exit code 0, plus `app:test:integration` (groups 2–4) and `app:test:e2e` (groups 4–5).
Docs ship in the PR whose behaviour they describe (no dedicated docs PR).
The current external-link flow is not patched separately; group 5 deletes it.
Execution is subagent-driven (plan.md).
-->

## 0. Prerequisites (no code PR)

- [x] 0.1 Archive `add-folder-volume-upload` (`/opsx:archive`) so `openspec/specs/game-volume-folder-upload/spec.md` exists for this change's MODIFIED delta, then rebase this change's branch on it.
- [x] 0.2 Record the operator's answers to design.md Open Questions 1–6 in design.md. Adjust the affected tasks below if any answer differs from the default.
- [x] 0.3 Record the operator's second-round decisions (Open Questions 7–10: every volume, in-stack #672 fix, fail-closed guard, subagent-driven execution) across design.md, both spec deltas, proposal.md, this file and plan.md.

## 1. PR 1 — `refactor(desktop-main)`: volume file backend interface and path safety

- [x] 1.1 Define the `VolumeFileBackend` interface in desktop-main: `list`, `stat`, `readStream`, `writeStream`, `mkdir`, `move`, `remove`, optional `archiveStream`, plus typed error results (`not-found`, `conflict`, `unreachable`, `auth`, `pin-mismatch`). Give it TSDoc per `.claude/rules/tsdoc-tags.md`.
- [x] 1.2 Extend `FileBrowserClient` to implement the interface. Add raw download (`GET /api/raw`), rename/move (`PATCH ?action=rename`), delete (`DELETE /api/resources`), stat, and folder archive (`?algo=zip`). Keep the existing pinned-fingerprint check on every request.
- [x] 1.3 Migrate `uploadEngine` onto the interface so there is exactly one FileBrowser HTTP client (`.claude/rules/duplication.md`), and name this extraction in the PR body.
- [x] 1.4 Add the volume path validator in the `@hyveon/shared/volumeFiles` subpath (absolute POSIX under the root, no `..`/NUL/empty segments, and names without `/`). Use it in the upload planner as well.
- [x] 1.5 Pin `FILEBROWSER_IMAGE` to the v2.63.23 image digest, looked up from the registry rather than written from memory (`~/.claude/rules/dependencies.md`), with a comment noting the project is archived and the pin is deliberate.
- [x] 1.6 Extend `fake-filebrowser-server` with raw, rename, delete, stat, zip and TLS. Add unit tests for every backend method, including pin mismatch and the validator's traversal cases.

## 2. PR 2 — `fix(app)`: mount every game volume in the helper and upload into the right one

- [x] 2.1 Add the `efsVolumeAccessPoints` stack output (game → volume name → access point ID) in `infra/src/program.ts` `buildStackOutputs`/`StackOutputValues`, built from the existing `efs.gameAccessPoints`; mirror it on `StackOutputs` in `@hyveon/shared`; project it in `PulumiService.projectStackOutputs` with an `{}` fallback; update the stack-output fixture builders (desktop-main and web e2e). No new resources, no IAM change.
- [x] 2.2 Add the pure `buildHelperVolumeLayout` (design D12): one task-definition volume per applied volume, mounted at `/srv/<dir>` (volume name when it matches `^[A-Za-z0-9._-]{1,64}$`, is unique, and is not itself of the form `volume-<N>`, else `volume-<index>`), with a first-volume fallback via `efsAccessPoints` when the new output is absent, and `toHelperPath(volume, path)`.
- [x] 2.3 Make `FileManagerService` launches mount the layout (every launch, browse and upload) and return it in-process. The legacy browse modal now shows one top-level folder per mounted volume until group 5 removes it.
- [x] 2.4 Fix the shipped #672 bug: `FolderUploadService` resolves the destination's volume and writes to `layout.toHelperPath(volume, toRemotePath(...))`; refuse before launch when that volume is not mounted ("Apply the infrastructure to upload into '<volume>'"). Update `toRemotePath`'s TSDoc to say it returns a volume-relative path. Add the regression test pinning a second-volume destination to the second volume's mount (unit and `FolderUpload.integration.test.ts` against the fake helper).
- [x] 2.5 Add `EcsService.findRunningTaskOrThrow` (rethrows a plain `Error`) and make `findRunningTask` a catch-and-log wrapper around it so existing callers keep their behaviour. Switch the folder-upload preflight to the throwing variant so an upload is refused when the server state can't be confirmed.
- [x] 2.6 Tests: infra output test (`program.test.ts` or the existing outputs test) for two volumes; layout naming and fallback; `PulumiService` projection fallback; `findRunningTaskOrThrow` error path; upload refusal for an unmounted volume and for an unconfirmed server state. Add a tier-2 integration spec asserting the projected output.
- [x] 2.7 Docs: `docs/docs/components/infra.md` (new output), `docs/docs/components/management-app.md` (multi-volume helper, fail-closed upload preflight), via the `write-docs` skill. Note in the PR body that the operator must run plan + apply once after release to record the output (output-only diff), and that until then the helper mounts the first volume only.

## 3. PR 3 — `feat(desktop-main)`: helper session registry with TLS browse sessions

- [x] 3.1 Extract the launch/teardown bodies of `FileManagerService` (`launchHelper`, `listHelperTask`) so both the legacy `start()` and the registry call them, with no duplicated launch code.
- [x] 3.2 Add `HelperSessionRegistry` with `acquire(game, holder)` (concurrent acquires share one launch), `attach(game)`/`release(game, holder)` (the browse holder's grace timer is configurable, default 5 min; attach cancels it), `stop(game)`, `restart(game)`, `status(game)`, the `orphaned` detection for an ECS helper with no registry entry, and the `failed` state (launch failure or a session task that disappeared, with the ECS stop reason). Each entry holds the launch's volume layout.
- [x] 3.3 Registry-launched sessions always use `buildTlsContainerSettings`. Readiness = task RUNNING, public IP present, and a successful backend login over the pinned connection. Surface the stop reason on early exit.
- [x] 3.4 On connect failure, re-detect the operator IP. If it changed, authorize the new `/32`, re-tag the helper task's `OperatorIp` with the new address (new `EcsService.tagTask`), revoke the orphaned rules through the existing reference-counted revoke, and retry once.
- [x] 3.5 Make `FolderUploadService` acquire/release a registry session (holder = run id) instead of `startForUpload` + `stop`. Replace the `helper-open` refusal with "reuse if registry-held, Restart if orphaned". Keep upload tags on helpers the upload launched. A forced session stop cancels the upload run.
- [x] 3.6 Make `sweepStrayHelpers` skip helpers owned by a registry session as well as active runs.
- [x] 3.7 Add a `before-quit` hook that stops registry-owned helpers with a bounded timeout, without blocking quit indefinitely, and without delaying quit when no helper is owned.
- [x] 3.8 Add unit tests: refcount, concurrent acquire, grace expiry and cancel-on-attach, stop with an active upload, quit, orphan, failed, IP re-authorization with re-tag, sweep exclusion. Add integration-tier wiring tests in the in-process Nest container.
- [x] 3.9 Docs: `docs/docs/components/management-app.md` (registry, TLS for all helper sessions) and `docs/docs/architecture.md` (helper transport, secrets boundary), via the `write-docs` skill.

## 4. PR 4 — `feat(app)`: volumeFiles IPC surface and preload API

- [x] 4.1 Add shared request/result/event types for `volumeFiles` in the `@hyveon/shared/volumeFiles` subpath, not the barrel. Requests carry `{ game, volume, path }`; the session status lists volumes (name, container path, mounted). They must contain no credential, token, IP or URL fields.
- [x] 4.2 Extract `NativeDialogService` (open file(s)/directory, save) from the private dialog code in `FolderScanService` and `DiagnosticsController` before adding a third consumer; name the extraction in the PR body.
- [x] 4.3 Add `VolumeFilesService`: session start/attach/detach/stop/restart/status through the registry, and list/mkdir/rename/delete/readText/writeText through the backend. Validate every path and that the volume is mounted. Refuse mutations with `server-running` while the game's server task is STARTING/RUNNING, and with `server-check-failed` when `findRunningTaskOrThrow` errors (fail closed). Enforce the 1 MiB/UTF-8 text limits and the mtime conflict check. Normalize and log errors per `.claude/rules/logging.md`.
- [x] 4.4 Implement downloads: a native save dialog, streaming to disk with progress events and cancel, deletion of the partial file on cancel/failure, Windows-reserved local filename sanitization, and folder archive only when the backend supports it.
- [x] 4.5 Implement `uploadFiles` (dialog, or paths from preload drag-and-drop) through the backend without overwriting, and `uploadFolder` delegating to the folder-upload flow with `selectedVolume.container_path + currentDir` as its destination and `persistSelection: false` (new `FolderUploadService.startUpload` option) so the game card's saved selection is untouched.
- [x] 4.6 Add `VolumeFilesController` with `@MessagePattern` handlers (including `volumeFiles.session.attach|detach`), each logging on entry with safe identifiers only, and an electron-bootstrap guard per the existing controller pattern.
- [x] 4.7 Add the preload `window.hyveon.volumeFiles` API and event subscriptions, with `uploadDropped(game, volume, dir, files)` resolving `webUtils.getPathForFile` inside the preload so renderer code never handles local path strings, and wire everything through the `__test.mock` seam.
- [x] 4.8 Add tests: service unit tests (validation, unknown volume, read-only refusal, fail-closed refusal, text limits, conflict, download partial-file cleanup, no secret fields in any result), controller tests, and a preload bridge test.
- [x] 4.9 Docs: `docs/docs/components/management-app.md` IPC channel table.

## 5. PR 5 — `feat(web)`: in-app file browser page replaces the external link

- [x] 5.1 Add the hooks: session state via the shared `PollingProvider` while starting (until ready, not merely RUNNING), attach on mount and detach on unmount; the listing for the selected volume and current path, operations, and download/upload progress.
- [x] 5.2 Add the `/games/:name/files` page with these components:
  - session bar (state, elapsed, auto-stop countdown with the 10-minute warning, Start/Stop/Restart, failure reason);
  - volume picker (name, container path, unavailable-until-apply state);
  - breadcrumb;
  - sortable file table;
  - action bar;
  - delete confirm (folder wording);
  - rename/new-folder dialogs with validation;
  - text editor;
  - drag-and-drop zone.

  Reuse existing `ui/` primitives, keep each component under the size rule, and disable mutating actions while the server runs or its state can't be confirmed (with Retry).
- [x] 5.3 Make the dashboard card Files action navigate and start the session, and add a Files link on the game detail page.
- [x] 5.4 Delete `FileManagerModal`, `useFileManager`, the legacy `files.list|start|stop` channels/controller/preload API, `FileMgrResult.credentials`/`FileMgrStatus.url`, and `FileManagerService.start()`/`getStatus()` once unused. Switch the folder-upload card's "stop the open session and retry" action from `api.filesMgrStop` to `volumeFiles.session.stop`.
- [x] 5.5 Add tests:
  - jsdom hook tests;
  - a routed-page test (navigate, switch volume, unavailable volume, sort, disabled-while-running, server-check-failed with Retry, delete confirm, editor conflict, orphaned → Restart);
  - a Playwright chromium spec through the IPC mock;
  - one Playwright electron smoke test (route renders, Start calls `volumeFiles.session.start`);
  - assert that no IPC payload reaching the renderer carries credential, IP or URL fields.
- [x] 5.6 Docs: `docs/docs/app/dashboard.md` and `docs/docs/app/games.md` (new page, volume picker, session behaviour, read-only and fail-closed rules), plus screenshots if the docs-screenshot capture covers these pages, via the `write-docs` skill.

## 6. Close-out

- [ ] 6.1 After PR 2 is released, the operator runs plan + apply once from the Infrastructure page to record `efsVolumeAccessPoints` (expected: output change only, empty resource diff). `[~]`-eligible if not run this cycle; record in verify.md.
- [ ] 6.2 Manual dogfood on a real stack (`[~]`-eligible if not run, recorded in verify.md): start a session from Files, switch volumes, navigate, upload a folder into a second volume and confirm it lands there, download a file and a folder, rename, delete, edit `options.json`, confirm the read-only state while the server runs, and confirm the helper stops after leaving the page and on quit.
- [ ] 6.3 `/opsx:verify`, then `/opsx:sync` or `/opsx:archive` so `openspec/specs/` contains `game-volume-file-browser` and the updated `game-volume-folder-upload`.
- [ ] 6.4 Open a follow-up issue for replacing the archived FileBrowser backend (Open Question 3), unless the operator chose to fold it in.
