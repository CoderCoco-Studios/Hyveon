# Arrow: app-update-and-release

How a new Hyveon version is cut, packaged, published as a draft GitHub Release, and offered to the operator to check, download and install from Settings.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Implemented end to end (release workflow → GitHub release feed → electron-updater in the main process).

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/app-update-and-release/app-update-and-release-design.md`

### EARS
- `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md` (93 specs)

### Tests
- `app/packages/desktop-main/src/updater.test.ts`
- `app/packages/desktop-main/src/updater-fallback.test.ts`
- `app/test/packaging-manifest-pins.test.ts`

### Code

**desktop-main**
- `app/packages/desktop-main/src/updater.ts`
- `app/packages/desktop-main/src/updater-fallback.ts`

**shared**
- `app/packages/shared/src/autoUpdateSetting.ts`

**Release / packaging (outside `app/packages`)**
- `.github/workflows/release.yml`
- `.github/workflows/package.yml`
- `.github/actions/publish-release/action.yml`
- `.github/actions/build-package/action.yml`
- `cliff.toml`
- `electron-builder.yml`

### Cited from other leaves
- `app/packages/desktop-main/src/controllers/iac-settings.controller.ts` (`deployment-config`): hosts the five `iac.settings.autoUpdate.{get,update,check,download,install}` channels (`:104-120`, `:217-320`) until they move to a controller this leaf owns (Work Required).
- `app/packages/desktop-main/src/controllers/iac-settings.controller.test.ts` (`deployment-config`): `getAutoUpdate` / `updateAutoUpdate` / `checkAutoUpdate` tests (`:258-355`).
- `app/packages/desktop-main/src/services/ElectronStoreService.ts` (`operator-app/wizard-and-bootstrap`): `enableAutoUpdate?: boolean` in the store schema (`:196-203`).
- `app/packages/desktop-main/src/electron-entry.ts` (`operator-app/desktop-shell`): calls `initUpdater` after Nest bootstrap (`:217-223`).
- `app/packages/web/src/pages/settings.page.tsx` and `settings.page.test.tsx` (`operator-app/desktop-shell`): Updates rows, toggle, Check / Download & Install / Restart & Install, "Download manually" link (`:79`, `:142-245`, `:304-350`).
- `app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts`, `app/packages/desktop-main/src/ipc-main-bridge.ts` (`operator-app/ipc-bridge`): settings bridge methods (`preload.ts:156-160`, `:294-310`, `:635-640`), `SELF_BRIDGED_PATTERNS` entry for the download stream (`ipc-main-bridge.ts:36`).
- `app/packages/desktop-main/src/app-version.ts` (`operator-app/diagnostics`): app version shown beside update status.
- `app/packages/shared/src/pulumiVersion.ts` (`iac/engine`): `PULUMI_ENGINE_VERSION`, asserted by `packaging-manifest-pins.test.ts:92-99`.
- `electron.vite.config.ts` (`operator-app/desktop-shell`): `electron-updater` in `rollupOptions.external` (`:104-111`), which is why `electron-builder.yml` must list it.
- Root `package.json` (unassigned): `version` (the version the release bumps), `desktop:package` script with `--publish never` (`:48`), `electron-updater` runtime dependency (`:21`).
- `docs/docs/install.md`, `docs/docs/code-signing-roadmap.md`, `README.md` (index `unmapped.docs`): the documents `APP-UPDATE-DOCS-001` to `APP-UPDATE-DOCS-005` specify.

## Architecture

**Purpose:** Produce and consume one artifact, the GitHub release feed. The producer side is a manually dispatched workflow that bumps the root version from Conventional Commits, builds installers on three OSes, and creates a draft release carrying the electron-updater feed files. The consumer side is the main-process updater: an opt-in boot-time check, plus operator-initiated check, download and restart-to-install from Settings.

**Key Components:**
1. `initUpdater(store)` (`updater.ts:78-108`): boot-time check; no-op outside Electron (`:79`) and when `enableAutoUpdate` is falsy (`:81-84`); `electron-updater` is only imported after both gates pass, and events are logged only.
2. `loadAutoUpdater()` (`updater.ts:23-29`): dynamic import via `.default`, pins `autoDownload` and `autoInstallOnAppQuit` to `false` on every load.
3. `checkWithFallback()` (`updater.ts:42-63`): primary GitHub check; on failure retries once against a generic feed and always restores `PRIMARY_FEED` in `finally` (`:58-61`); rethrows the original error.
4. `checkForUpdatesNow()` / `downloadUpdateNow()` / `installDownloadedUpdate()` (`updater.ts:128-175`, `:197-242`, `:251-265`): operator actions, independent of the flag; download re-checks once when no available update is cached (tracked in `updateState`); install calls `quitAndInstall(false, true)` (`:258`).
5. `updater-fallback.ts`: `pickFallbackRelease` (`:49-58`) chooses the newest non-draft, non-prerelease release carrying the platform feed file; `resolveFallbackFeedUrl` queries the GitHub releases API page by page (100 per page, 10 s timeout per request).
6. `autoUpdateSetting.ts`: IPC payload and result unions for the five `iac.settings.autoUpdate.*` channels plus `UpdateDownloadProgress` (`:12-92`).
7. `.github/workflows/release.yml`: `release` job (`:40-317`: GitHub App token, range resolution, git-cliff changelog and bump, Claude summary, bump commit + annotated tag, or replay-mode notes rewrite), `package` matrix on the tag (`:322-370`), `publish` job (`:372-386`).
8. `.github/actions/publish-release/action.yml`: downloads `pkg-*` and `release-notes` artifacts, creates the draft release (`:24-32`), then verifies all three `latest*.yml` feeds and `exe`/`dmg`/`zip`/`AppImage` assets (`:37-61`).
9. `.github/workflows/package.yml` + `.github/actions/build-package/action.yml`: PR / merge-queue packaging gate using the same composite build steps as the release run.
10. `cliff.toml`: changelog template with fixed group order, `chore(release):` skip (`:59`), bump rules (`:69-76`).
11. `electron-builder.yml`: `publish: github` metadata only (`:10-18`), hand-maintained runtime `files` closure (`:20-216`), `extraResources` (`:218-242`), mac `dmg` + `zip` (zip required by MacUpdater, `:253-263`), `hardenedRuntime: false` (`:255`).
12. `app/test/packaging-manifest-pins.test.ts`: guards that root runtime pins match `desktop-main` and `infra`, and that `PULUMI_ENGINE_VERSION` equals the root `@pulumi/pulumi` pin (`:61-100`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Boot-time update check | `APP-UPDATE-BOOT-001` to `APP-UPDATE-BOOT-006` | 6 | 0 | 0 |
| enableAutoUpdate flag | `APP-UPDATE-FLAG-001` to `APP-UPDATE-FLAG-007` | 7 | 0 | 0 |
| Manual update check | `APP-UPDATE-CHECK-001` to `APP-UPDATE-CHECK-007` | 7 | 0 | 0 |
| Update feed fallback | `APP-UPDATE-FALL-001` to `APP-UPDATE-FALL-007` | 7 | 0 | 0 |
| Download and install | `APP-UPDATE-DL-001` to `APP-UPDATE-DL-009` | 9 | 0 | 0 |
| IPC channel contract | `APP-UPDATE-IPC-001` to `APP-UPDATE-IPC-009` | 9 | 0 | 0 |
| Settings page Updates section | `APP-UPDATE-UI-001` to `APP-UPDATE-UI-009` | 9 | 0 | 0 |
| Packaging and feed metadata | `APP-UPDATE-PKG-001` to `APP-UPDATE-PKG-008` | 6 | 0 | 2 |
| Release workflow: trigger and range | `APP-UPDATE-REL-001` to `APP-UPDATE-REL-006` | 6 | 0 | 0 |
| Release workflow: version bump and tag | `APP-UPDATE-BUMP-001` to `APP-UPDATE-BUMP-010` | 10 | 0 | 0 |
| Release workflow: notes | `APP-UPDATE-NOTES-001` to `APP-UPDATE-NOTES-004` | 4 | 0 | 0 |
| Release workflow: draft publication and replay | `APP-UPDATE-DRAFT-001` to `APP-UPDATE-DRAFT-006` | 6 | 0 | 0 |
| Install and code-signing documentation | `APP-UPDATE-DOCS-001` to `APP-UPDATE-DOCS-005` | 5 | 0 | 0 |

**Summary:** 91 of 93 active specs implemented; 0 deferred; 2 gaps.

## Key Findings

1. **"No update-related network calls" cannot hold when the flag is off**: a disabled updater cannot produce no update-related network calls for a full session while the manual check runs regardless of the flag. Code follows the latter: `checkForUpdatesNow` (`updater.ts:113-114`, `:128`) and its fallback GitHub API fetch (`updater-fallback.ts:69-72`) never read `enableAutoUpdate`. The gate really covers only the boot-time check (`updater.ts:81`); `APP-UPDATE-BOOT-004` states the narrowed rule.
2. **Install requires a download in this process**: `installDownloadedUpdate` returns `{ ok: false, message: 'No update has been downloaded yet.' }` unless a download finished (`updateState.downloaded`), matching the `UpdateInstallResult` contract in `autoUpdateSetting.ts` (`APP-UPDATE-DL-009`).
3. **Download re-checks from tracked state**: `downloadUpdateNow` re-runs the check once when `updateState.checkCached` is false and returns `{ ok: false }` if that check finds nothing; it never reads `electron-updater`'s rejection text (`APP-UPDATE-DL-005`).
4. **The release repo identity has one TypeScript source**: `RELEASE_REPO` in `@hyveon/shared` feeds `PRIMARY_FEED`, the fallback API and download URLs, and the Settings "Download manually" link. `electron-builder.yml`'s `publish` block is the one literal copy, held equal by `packaging-manifest-pins.test.ts` (`APP-UPDATE-PKG-004` stays open: derivation would need an `electron-builder` JS config).
5. **A failed verification deletes the draft**: the draft is created before asset verification (the assets are its attachments), and a final `if: failure()` step in `publish-release/action.yml` deletes it by release id, so no draft lacking assets remains (`APP-UPDATE-DRAFT-004`).
6. **Explicit `to` is rejected in bump mode**: `release.yml:101-107` fails unless `to` resolves to main's tip, and points operators at replay mode instead. The rule is deliberate (the tag must describe the changelog's commit) and is stated in `APP-UPDATE-REL-004`.
7. **AI-failure release body is a placeholder, not the bare changelog**: `release.yml:205-226` always writes the AI summary or a `_AI summary unavailable._` placeholder, with the raw changelog inside a collapsed `<details>` block in both cases (`APP-UPDATE-NOTES-004`).
8. **Only the root manifest is versioned**: `npm version ... --workspaces=false` (`release.yml:272`) bumps root `package.json` (now `0.9.1`) while `app/package.json:3` and `app/packages/desktop-main/package.json:3` stay at `1.0.0`. The bump commit also stages `package-lock.json` (`release.yml:273`), so the bump commit is not limited to the version change (`APP-UPDATE-BUMP-006`).
9. **Package matrix is written in two workflows**: `package.yml` and `release.yml` carry the same matrix; `app/test/ci-workflows.test.ts` fails when they differ (`APP-UPDATE-PKG-005` stays open pending a decision on a single shared definition). Build steps are shared via `build-package`.
10. **Native binding follows the lockfile**: `build-package` reinstalls `@tailwindcss/oxide` at the version `package-lock.json` resolves (`APP-UPDATE-PKG-006`).
11. **Hand-maintained packaged runtime closure, guarded**: `electron-builder.yml` lists the `node_modules` globs for the externalized `@pulumi/*`, `class-validator`, `class-transformer` and `electron-updater`; `app/test/packaging-files-closure.test.ts` walks their runtime closure and fails on any hoisted package no glob covers (`APP-UPDATE-PKG-008`).
12. **Fallback considers every release**: `resolveFallbackFeedUrl` pages the releases API 100 at a time until a short page (`APP-UPDATE-FALL-007`).
13. **IPC channels live under another leaf's controller and namespace**: all five auto-update channels are on `IacSettingsController` under `iac.settings.*` (`iac-settings.controller.ts:228-320`), though `enableAutoUpdate` is a local electron-store flag unrelated to `DeploymentConfig` (`autoUpdateSetting.ts:5-9` says so explicitly). Flagged in final-clustering §4 as a misplaced namespace. The intended structure moves the five channels to a controller this leaf owns and keeps their `iac.settings.autoUpdate.*` names (`app-update-and-release-design.md`, Decisions & Alternatives).
14. **Task-history narrative in a packaging comment**: `electron-builder.yml:239-240` ("A later group's GuidedIamService calls it") references plan-group history, which the repo's comment rules disallow.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md`; items with no matching gap spec carry none.

### Must Fix
None.

### Should Fix
1. Decide how to derive the `electron-builder.yml` `publish` block from `RELEASE_REPO` (Finding 4). (specs: `APP-UPDATE-PKG-004`)
2. Decide whether the packaging matrix becomes one shared definition or the drift test is the intended guard (Finding 9). (specs: `APP-UPDATE-PKG-005`)

### Nice to Have
8. Move the five `iac.settings.autoUpdate.*` channels out of `deployment-config`'s `iac-settings.controller.ts` into a controller this leaf owns, keeping the channel names (Finding 13). Tracked with the matching item in `docs/arrows/deployment-config.md`.
9. Decide whether workspace manifests should track the released version (Finding 8).
11. Drop the plan-history wording in `electron-builder.yml:239-240` (Finding 14).
