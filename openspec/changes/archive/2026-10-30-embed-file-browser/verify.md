# Verification Report

> This file is produced by the `openspec-verify-change` skill after apply completes, to confirm the implementation is consistent with specs / design / tasks. A failed check must go back to the relevant artifact for a fix, then verify re-runs.

**Change**: `embed-file-browser`
**Verified at**: `2026-10-30 11:55`
**Verifier**: Claude (PR 6 close-out session). Evidence comes from one read-only requirement-to-code mapping pass over both delta specs and design D1–D13, and from the full pre-PR gate on the stack head.

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result**:

```text
Pre-archive: 47/47 items valid (changes 11/11, specs 36/36, 0 failed)
Post-archive: 47/47 items valid (changes 10/10, specs 37/37, 0 failed)
```

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] All `- [ ]` have become `- [x]`. 42/44 are `[x]`; 6.1 and 6.2 are `[~]` (deferred manual checks).

**Incomplete tasks**:

| Task | Reason incomplete | Blocks archive? |
|---|---|---|
| 6.1 Infra plan + apply to record `efsVolumeAccessPoints` | Needs the operator's live AWS stack after the stack is released. Not run this cycle. | No. Until the apply runs, the app falls back to first-volume browsing and refuses uploads (design D12/D13), and the automated equivalents are in §7. |
| 6.2 Manual dogfood on a real stack | Needs a live helper on a real stack. Not run this cycle. | No. See §7 for the automated equivalents and the two real gaps. |

---

## 3. Delta Spec Sync State

| Capability | Sync status | Notes |
|---|---|---|
| game-volume-file-browser | ✓ synced | New capability: 10 requirements and 39 scenarios created at `openspec/specs/game-volume-file-browser/spec.md`, with a Purpose section |
| game-volume-folder-upload | ✓ synced | 2 MODIFIED requirements ("Upload goes directly into the mounted volume", "Helper sessions are tagged and stray ones are cleaned up") replaced in place; the other 7 requirements are untouched |

`openspec archive` refused the automatic merge. The base scenario "Helper already open for this game" (ask the operator to stop an open session first) is absent from the MODIFIED block, and the CLI won't drop a scenario. Dropping it is intentional: the proposal ("Helper session ownership") removes that refusal, and the delta replaces it with "Application-held session already open for this game" and "Helper running without an application session". The sync was therefore done as an agent-driven merge (`/opsx:archive` → inline `/opsx:sync`), and the change was archived with `--skip-specs`.

---

## 4. Design / Specs Coherence Spot Check

Every `### Requirement:` and `#### Scenario:` in both deltas maps to implementation evidence and to at least one covering test (unit, jsdom routed-page, Playwright chromium/electron, or tier-2 integration). No requirement is unimplemented, and no CRITICAL finding was raised.

| Sample item | design description | specs mapping | Gap |
|---|---|---|---|
| D2 pinned TLS for browse | `buildTlsContainerSettings` on every launch, fingerprint pinned | "Encrypted, pinned, operator-only transport" + Impersonated helper | none |
| D3 registry | one session per game, holders, grace, orphan → Restart | "One application-owned helper session per game" | holder model drifted (reconciled, see below) |
| D4 backend interface + pin | `VolumeFileBackend`, `v2.63.23@sha256:a469…` | "Replaceable file backend" + Pinned helper image | none |
| D7 fail-closed guard | `findRunningTaskOrThrow` → `server-check-failed` | "Read-only while the game server is running" + "Server state cannot be confirmed" (both specs) | wrapper wording drifted (reconciled) |
| D8 text edit | ≤ 1 MiB UTF-8, mtime conflict | "Small text file view and edit" | none (`MAX_TEXT_EDIT_BYTES = 1_048_576`) |
| D9 session states | 7 states, poll until ready | "Session readiness and state reporting" | none |
| D12/D13 multi-volume + #672 fix | layout per applied volume, fallback refuses uploads | "Choosing a volume", "Upload to a second volume", "Stack applied before per-volume access points were exported" | none |

**Drift reconciled before archive** (non-blocking; the spec wins over the design, and the change artifacts were edited so the archived copy matches the shipped code):

1. **"Start session" vs "Start".** The page button reads `Start` (`app/packages/web/src/components/volume-files/session-bar.component.tsx:100-103`). Changed: spec scenario "Opening the page directly" (`specs/game-volume-file-browser/spec.md:12`), design Open Question 1 (`design.md:5`), D3 orphan action **Restart session** → **Restart** (`design.md:106`; the button is `Restart`, `session-bar.component.tsx:110-113`), and proposal "Helper session ownership" (`proposal.md:21`).
2. **Unreachable → "Restart action".**
   - The spec scenario "Operator IP changes mid-session" and design Risks promised a Restart action for an unreachable helper. The session bar offers Restart only for `orphaned`. A running-but-unreachable session shows Stop, and a helper that has exited reports `failed` with Start, which the spec scenario "Helper disappears during a session" already says.
   - The operator chose to make the docs match the behaviour and to fix the message text. Commit `e5adbecd` on PR 4 (`embed-file-browser-4-ipc`) changes the `unreachable`/`auth`/`pin-mismatch` messages from "Restart the session." to "Stop and start the session." (`app/packages/desktop-main/src/services/volumeFiles/volumeFileErrors.ts:18-20`). Commit `6e3fd043` on PR 5 aligns the page-test mock.
   - Doc edits: `specs/game-volume-file-browser/spec.md:54`, and `design.md:197` (Risks, IP-change row).
3. **D7 "catch-and-log wrapper".**
   - `findRunningTask` catches and returns `null` without logging (`app/packages/desktop-main/src/services/EcsService.ts:281-287`).
   - The `logger.error('Failed to find running task')` happens inside `findRunningTaskOrThrow` before it rethrows (`EcsService.ts:263-266`).
   - Changed to "swallowing wrapper" in `design.md:144` (D7) and `tasks.md` 2.5.
4. **Holder model.**
   - D3 said `holders: Set<'browse'|uploadRunId>`. The code uses `HelperHolder = 'browse' | 'upload:<id>' | 'download:<id>'` (`app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts:17-20`). Folder-upload runs hold `upload:<runId>` (`FolderUploadService.ts:349`), and page transfers hold `upload:xfer-<id>` / `download:xfer-<id>` (`volumeFiles/transfers.ts:167`).
   - `games.start` is refused while any `upload:` holder remains (`app/packages/desktop-main/src/controllers/games.controller.ts:105-108`, test `games.controller.test.ts:243`). This refusal was undocumented.
   - Stop confirms while an upload or a download is running (`session-bar.component.tsx:106`, commit `12c271c5`), and `stop` aborts page transfers through `onBeforeStop` (`VolumeFilesService.ts:89`).
   - Changes:
     - `design.md:97-98`: the holder type, the `games.start` refusal (in-app only; the Discord `/server-start` Lambda can't see the registry), and the fact that downloads don't block a start.
     - `design.md:104`: stop cancels page transfers.
     - spec requirement text and "Leaving the page" now say "upload or download" (`specs/game-volume-file-browser/spec.md:57, 64`).
     - The scenario "Stop while an upload holds the session" became "Stop while a transfer holds the session" (`spec.md:71-73`).
     - New scenario "Server start while an upload holds the session" (`spec.md:75-77`).
     - folder-upload delta: "no browse page, other upload or download" (`specs/game-volume-folder-upload/spec.md:4`).

5. **Unmounted-volume upload → "Restart the file manager session".** The independent close-out review found the same mismatch as item 2. A folder upload into a running Files session whose layout predates the infra apply failed with "Restart the file manager session to upload into '<volume>'.", but in that state the session bar shows only Stop. The operator chose to fix it in the owning PR. Commit `3ee2e6af` on PR 3 (`embed-file-browser-3-registry`) changes it to "Stop and start the file manager session…" (`app/packages/desktop-main/src/services/FolderUploadService.ts`, `resolveItems`), together with its two test assertions and the quote in `docs/docs/components/management-app.md`. PRs 4 and 5 were restacked onto it. The orphaned-helper message "Restart it, then retry." (`FolderUploadService.ts`) is correct as written, because Files offers Restart for `orphaned`.

`brainstorm.md` keeps its original "Start session" / "Restart session" wording as the historical design record.

**Suggestions not applied** (no behaviour impact): D5 could name the push channels `volumeFiles.session` / `volumeFiles.transfer` (`app/packages/desktop-preload/src/preload.ts:147-148`).

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree (`git status --porcelain` empty before the close-out edits)
- [x] All relevant implementation commits exist in local history

**Commit range**: `2822efd1..6e3fd043` (76 commits across PRs #694, #695, #696, #698 and #699; 152 files, +13587 / −2139).

**Gate on `4fb46597`** (the PR 5 head before the restack, not on any pushed branch now; its tree equals `6e3fd043`'s minus the three message-text commits `3ee2e6af`, `e5adbecd` and `6e3fd043`):
- `npm run app:lint`: exit 0 (3 pre-existing warnings).
- `npm run app:typecheck`: exit 0.
- `npm run app:test`: exit 0 (229 files, 4559 passed, 1 todo).

The message-text commits were re-tested in isolation: `desktop-main/src/services/volumeFiles` passed 230/230, `volume-files.page.test.tsx` passed 52/52, and `desktop-main/src/services/FolderUpload*` passed 123/123. The full gate was re-run on the PR 6 head before opening the PR (see the PR body).

---

## 6. Front-Door Routing Leak Detector

- [x] No files, or any existing files are legitimate leftovers from before the schema was installed

| File | Produced this cycle? | Content already captured in the change? | Suggested action |
|---|---|---|---|
| docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md | No. Committed 2026-05-12, months before this change | N/A (unrelated design) | Leave in place; pre-existing WARNING, non-blocking |

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

| Deferred dogfood (plan §) | Equivalent automated test | Coverage assessment | Real gap? |
|---|---|---|---|
| 6.1 Infra plan + apply records `efsVolumeAccessPoints` (output change only, empty resource diff); plan Close-out row 1 | `infra/src/program.test.ts` (two-volume output), `desktop-main/src/services/PulumiService.test.ts` (projection + `{}` fallback), `volumeFiles/helperVolumeLayout.test.ts` (naming + first-volume fallback), `FolderUploadService.test.ts` (`usedFallback` refusal) | Output shape, projection and fallback behaviour are covered. The live diff against a real Pulumi state, and whether it is empty, isn't. | Partial. That the live plan is output-only is the operator's check. |
| 6.2 Start a session from Files, switch volumes, navigate | `web/src/pages/volume-files.page.test.tsx` (autoStart, volume switch, breadcrumb, sort), `web/e2e/specs/volume-files.spec.ts`, `web/e2e/specs/volume-files-electron.spec.ts` (route renders, Start calls `volumeFiles.session.start`) | Covered against the IPC mock and the fake helper | No |
| 6.2 Upload a folder into a second volume and confirm it lands there | `FolderUploadService.test.ts` (second-volume destination), `FolderUpload.integration.test.ts` against `fake-filebrowser-server` over TLS | Covered against the fake helper | No (the real EFS mount is the dogfood residue) |
| 6.2 Download a file and a folder | `volumeFiles/transfers.test.ts`, `VolumeFilesService.test.ts` (partial-file cleanup, zip only with archive support) | Covered | No |
| 6.2 Rename, delete, edit `options.json` | `VolumeFilesService.test.ts` (conflict, mtime, 1 MiB/UTF-8), `volume-files.page.test.tsx` (delete confirm, editor conflict) | Covered | No |
| 6.2 Read-only while the server runs | `VolumeFilesService.test.ts` (`server-running`, `server-check-failed`), `volume-files.page.test.tsx` (disabled + Retry), `web/e2e/specs/volume-files.spec.ts` | Covered | No |
| 6.2 Helper stops 5 min after leaving the page | `volumeFiles/HelperSessionRegistry.test.ts` (grace expiry, cancel-on-attach) | Covered with fake timers | No |
| 6.2 Helper stops on quit | `desktop-main/src/helper-quit-hook.test.ts` (no-delay when unowned, stop-then-quit, 5 s timeout, rejection) | Covered at the hook level | No |
| 6.2 Stop confirmation while a download is running | `web/src/components/volume-files/session-bar.component.test.tsx`, `volume-files.page.test.tsx` (commit `12c271c5`) | Covered | No |
| 6.2 Drag-and-drop from the OS via `webUtils.getPathForFile` in the sandboxed preload | `desktop-preload/src/preload.test.ts` (mocked `webUtils`), `volume-files.page.test.tsx` (drop zone) | The chromium e2e uses an in-page fake and the electron smoke test only renders and clicks Start. Nothing exercises a real OS drop resolving through the sandboxed preload. | **Yes.** Recorded in retrospective §2. The operator checks it during dogfood. |
| 6.2 `electron-updater` `quitAndInstall` while the app owns a helper (quit hook delays ≤ 5 s; Squirrel.Mac unverified) | `helper-quit-hook.test.ts`, `desktop-main/src/updater.test.ts` (separately) | Nothing tests the updater's quit path with the hook armed. Squirrel.Mac's handling of a delayed `before-quit` is unverified. | **Yes.** Recorded in retrospective §2. The operator checks it during dogfood. |

**Operator checklist still owed** (6.1/6.2):

1. After the stack merges and ships, open Infrastructure → Plan. Confirm the only change is the `efsVolumeAccessPoints` output, with an empty resource diff. Then Apply.
2. On a real stack with a two-volume game:
   - Dashboard → Files starts a session. Switch volumes and navigate.
   - Upload a folder into the second volume and confirm it lands there, not in the first.
   - Download a file and a folder.
   - Rename, delete, and edit `options.json`.
   - Start the server and confirm the page goes read-only.
   - Leave the page and confirm the helper stops after about 5 min.
   - Quit with a session open and confirm the helper stops.
3. Drag files from the OS file manager onto the listing. Confirm they upload into the current directory: the real `webUtils.getPathForFile` path in the sandboxed preload.
4. Start a download, click Stop, and confirm the dialog warns before it cancels.
5. With a helper session open, trigger an update install (`quitAndInstall`). Quit should be delayed by at most about 5 s while the helper stops, and the update should still install. Squirrel.Mac is unverified, so check on macOS if one is available.

---

## Follow-ups

- 6.4: [#700](https://github.com/CoderCoco-Studios/Hyveon/issues/700) replaces the archived FileBrowser helper backend (design Open Question 3; candidates are Lambda-on-EFS, a minimal purpose-built helper image, or a maintained fork).

---

## Overall Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS: no CRITICAL findings. The doc drift is reconciled. Two deferred manual checks (6.1, 6.2) are owed by the operator, and two of them have no automated equivalent (real drag-and-drop through the sandboxed preload, and `quitAndInstall` with an owned helper).
- [ ] ❌ FAIL

**Next step**: done. retrospective.md was written, and the change was archived with `openspec archive embed-file-browser -y --skip-specs` after the inline spec sync (§3). PR 6 opens on top of the stack.
