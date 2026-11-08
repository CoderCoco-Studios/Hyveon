# App Update and Release Specs

EARS requirements for prefix `APP-UPDATE`; design in [app-update-and-release-design.md](./app-update-and-release-design.md).

## Boot-time update check

- [x] **APP-UPDATE-BOOT-001**: When the desktop-main updater's `initUpdater` runs outside a real Electron main process (`process.versions.electron` undefined), the updater shall return without importing `electron-updater` or making any network request.
- [x] **APP-UPDATE-BOOT-002**: When the packaged app boots and the `enableAutoUpdate` electron-store flag is unset or `false`, `initUpdater` shall log a single "update checks disabled" line and return without importing `electron-updater` or calling `checkForUpdates`.
- [x] **APP-UPDATE-BOOT-003**: When the packaged app boots and `enableAutoUpdate` is `true`, `initUpdater` shall run one update check against the GitHub Releases feed (with the feed fallback of APP-UPDATE-FALL-001) and log `error`, `update-available`, `update-not-available` and `update-downloaded` events through the main-process logger.
- [x] **APP-UPDATE-BOOT-004**: While `enableAutoUpdate` is `false`, the updater shall perform no update-feed or GitHub releases API request that the operator did not initiate from the Settings page, and shall emit no update-check events beyond the single boot-time disabled log line.
- [x] **APP-UPDATE-BOOT-005**: If the boot-time update check rejects, then `initUpdater` shall swallow the rejection after its `error` listener has logged it, so no unhandled rejection reaches the Electron main process. (observed)
- [x] **APP-UPDATE-BOOT-006**: Every time desktop-main loads `electron-updater` (boot-time check, manual check, download or install), the updater shall set `autoDownload` and `autoInstallOnAppQuit` to `false` before use.

## enableAutoUpdate flag

- [x] **APP-UPDATE-FLAG-001**: The electron-store `AppStoreSchema` shall declare an optional boolean `enableAutoUpdate`, readable and writable through `ElectronStoreService`'s typed `get`/`set` in both the real electron-store backing and the in-memory backing used outside Electron.
- [x] **APP-UPDATE-FLAG-002**: When `enableAutoUpdate` has never been persisted, both the boot-time updater and the `iac.settings.autoUpdate.get` channel shall treat it as `false`.
- [x] **APP-UPDATE-FLAG-003**: When the renderer invokes `iac.settings.autoUpdate.get`, desktop-main shall return `{ ok: true, enableAutoUpdate, appVersion }`, with `appVersion` set to the running app version or `'unknown'` outside Electron.
- [x] **APP-UPDATE-FLAG-004**: If reading `enableAutoUpdate` from the store throws during `iac.settings.autoUpdate.get`, then desktop-main shall log the error and return `{ ok: false, code: 'error', message }` without rethrowing. (observed)
- [x] **APP-UPDATE-FLAG-005**: When the renderer invokes `iac.settings.autoUpdate.update` with a boolean `enableAutoUpdate`, desktop-main shall persist it via `ElectronStoreService` and return `{ ok: true, enableAutoUpdate }` echoing the value now in effect.
- [x] **APP-UPDATE-FLAG-006**: If `iac.settings.autoUpdate.update` receives a non-boolean `enableAutoUpdate`, no settings store is available, or the store write throws, then desktop-main shall return `{ ok: false, code: 'error', message }` and leave the stored value unchanged. (observed)
- [x] **APP-UPDATE-FLAG-007**: When `enableAutoUpdate` is changed while the app is running, desktop-main shall not trigger an update check; the new value shall take effect only at the next app start.

## Manual update check

- [x] **APP-UPDATE-CHECK-001**: When the operator triggers a manual update check, desktop-main shall run the check regardless of the `enableAutoUpdate` flag's value.
- [x] **APP-UPDATE-CHECK-002**: When a manual update check finds the running version current, desktop-main shall return `{ ok: true, updateAvailable: false }` and shall not download or install anything.
- [x] **APP-UPDATE-CHECK-003**: When a manual update check finds a newer version, desktop-main shall return `{ ok: true, updateAvailable: true, version }` and shall not download or install anything.
- [x] **APP-UPDATE-CHECK-004**: If a manual update check fails after the feed fallback, then desktop-main shall log the failure and return `{ ok: false, message }` without letting an exception escape to the IPC caller.
- [x] **APP-UPDATE-CHECK-005**: When a manual update check is requested outside a real Electron main process, desktop-main shall return `{ ok: false }` with an "only available in the packaged app" message without importing `electron-updater` or making any network call.
- [x] **APP-UPDATE-CHECK-006**: If `checkForUpdates` resolves `null` during a manual check (updater disabled for this build), then desktop-main shall return `{ ok: false }` with an "Update checks are disabled for this build." message. (observed)
- [x] **APP-UPDATE-CHECK-007**: When a manual update check settles, desktop-main shall remove every listener the check attached to the `autoUpdater` singleton. (observed)

## Update feed fallback

- [x] **APP-UPDATE-FALL-001**: If a boot-time, manual or pre-download update check's `checkForUpdates` call rejects, then the updater shall look up the newest GitHub release that is neither a draft nor a prerelease and carries the current platform's feed file (`latest.yml` on win32, `latest-mac.yml` on darwin, `latest-linux.yml` on linux), point the generic provider at that release's download URL, and retry the check exactly once.
- [x] **APP-UPDATE-FALL-002**: When choosing the update-feed fallback release, the updater shall pick the eligible release with the greatest `published_at`, treating a missing or unparseable `published_at` as oldest and keeping the earlier entry on ties.
- [x] **APP-UPDATE-FALL-003**: If no eligible fallback release exists, the releases lookup returns non-2xx or a non-array body, the lookup throws or exceeds its 10 s timeout, or the fallback retry fails, then the updater shall surface the original primary check error.
- [x] **APP-UPDATE-FALL-004**: After an update-feed fallback retry succeeds or fails, the updater shall restore the primary `github` feed (`CoderCoco-Studios/Hyveon`) on the `autoUpdater` singleton.
- [x] **APP-UPDATE-FALL-005**: The update-feed fallback shall never download or install an update.
- [x] **APP-UPDATE-FALL-006**: When a manual check's primary attempt emits an `error` event and the fallback retry then succeeds, desktop-main shall resolve the manual check with the retry's availability result, not with the primary error.
- [x] **APP-UPDATE-FALL-007**: When looking up an update-feed fallback release, the updater shall consider every published release rather than only the newest page, so an eligible older release is found even when the most recent releases all lack the platform feed file. (observed)

## Download and install

- [x] **APP-UPDATE-DL-001**: The desktop app shall download or install an update only through the operator-initiated `iac.settings.autoUpdate.download` and `iac.settings.autoUpdate.install` actions; the boot-time check and the manual check shall remain detect-only.
- [x] **APP-UPDATE-DL-002**: While an operator-initiated update download is in progress, desktop-main shall forward every `download-progress` event as `{ percent, transferred, total, bytesPerSecond }`.
- [x] **APP-UPDATE-DL-003**: When an operator-initiated update download completes, desktop-main shall return `{ ok: true, version }` with the version reported by `update-downloaded`, without restarting the app.
- [x] **APP-UPDATE-DL-004**: If an operator-initiated update download is requested while `electron-updater` has no cached check result in this process, then desktop-main shall re-run the update check (with fallback) once and retry the download before reporting failure.
- [x] **APP-UPDATE-DL-005**: When deciding whether an operator-initiated download lacks a cached check result, desktop-main shall detect that condition from updater state rather than from `electron-updater`'s rejection message text. (observed)
- [x] **APP-UPDATE-DL-006**: If an operator-initiated update download fails, then desktop-main shall log the failure and return `{ ok: false, message }`, and shall remove its `download-progress`, `update-downloaded` and `error` listeners whether the download succeeded or failed.
- [x] **APP-UPDATE-DL-007**: When an operator-initiated update download or install is requested outside a real Electron main process, desktop-main shall return `{ ok: false }` with an "only available in the packaged app" message without touching `electron-updater`.
- [x] **APP-UPDATE-DL-008**: When the operator requests install of a downloaded update, desktop-main shall call `quitAndInstall(false, true)` so the app quits, runs the installer and relaunches, and shall return `{ ok: true }`.
- [x] **APP-UPDATE-DL-009**: If the operator requests install when no update has been downloaded in this process, then desktop-main shall return `{ ok: false, message }` instead of calling `quitAndInstall`. (observed: promised by the `UpdateInstallResult` doc, `app/packages/shared/src/autoUpdateSetting.ts:86-91`)

## IPC channel contract

- [x] **APP-UPDATE-IPC-001**: Desktop-main shall expose the update surface only as the five Electron IPC channels `iac.settings.autoUpdate.get`, `.update`, `.check`, `.download` and `.install`, with no HTTP transport. (observed; CLAUDE.md invariant "The desktop app has no HTTP transport")
- [x] **APP-UPDATE-IPC-002**: When any of the five `iac.settings.autoUpdate.*` handlers is invoked, it shall first log `IacSettingsController: <pattern> invoked` at debug level with no payload contents. (observed; `.claude/rules/logging.md`)
- [x] **APP-UPDATE-IPC-003**: When the renderer invokes `iac.settings.autoUpdate.check`, desktop-main shall return the manual check's `ManualUpdateCheckResult` (no update, update available with version, or error).
- [x] **APP-UPDATE-IPC-004**: When the renderer invokes `iac.settings.autoUpdate.download` in a real Electron main process, desktop-main shall immediately return `{ started: true, streamId }`, push each progress sample tagged with that `streamId` on `iac.settings.autoUpdate.download.chunk`, and send exactly one terminal message on `iac.settings.autoUpdate.download.end` carrying `version` on success or `error` on failure.
- [x] **APP-UPDATE-IPC-005**: Desktop-main shall register `iac.settings.autoUpdate.download` as a self-bridged `ipcMain.handle` channel (listed in `SELF_BRIDGED_PATTERNS`) so the handler receives the invoking `WebContents`, and shall skip that registration outside Electron. (observed)
- [x] **APP-UPDATE-IPC-006**: If the invoking renderer's `WebContents` is destroyed during an update download, then desktop-main shall stop sending chunk and end messages for that stream. (observed)
- [x] **APP-UPDATE-IPC-007**: When the renderer invokes `iac.settings.autoUpdate.install`, desktop-main shall return the install step's `UpdateInstallResult`.
- [x] **APP-UPDATE-IPC-008**: The preload bridge shall surface the update download as an async iterable of `UpdateDownloadProgress` that completes on a successful end message and throws with the end message's `error` on failure. (observed)
- [x] **APP-UPDATE-IPC-009**: The `iac.settings.autoUpdate.download.chunk` and `.download.end` channel names shall be declared in one shared place consumed by both desktop-main and preload. (observed)

## Settings page Updates section

- [x] **APP-UPDATE-UI-001**: When the operator opens the Settings page, the Updates section shall show the running app version (`v<version>`, or `Unknown` outside Electron) and an "Automatic updates" toggle reflecting the current `enableAutoUpdate` value.
- [x] **APP-UPDATE-UI-002**: When the operator flips the Settings page "Automatic updates" toggle and the write succeeds, the page shall display the confirmed value; if the write fails or rejects, then the page shall keep the last confirmed value and show a "Failed to save" message.
- [x] **APP-UPDATE-UI-003**: The Settings page Updates section shall offer a "Check for Updates" control that, when activated, shows the result inline as checking, up to date (with the running version when known), update available with version, or the error message.
- [x] **APP-UPDATE-UI-004**: If the Settings page's manual-check IPC call rejects, then the page shall show "Unable to reach the update service." as a failed check.
- [x] **APP-UPDATE-UI-005**: When a Settings page manual check reports `updateAvailable: true`, the Updates row shall show a "Download & Install" button beside "Check for Updates", and shall not show it before a check, when up to date, or after a failed check.
- [x] **APP-UPDATE-UI-006**: While a Settings page update download is in progress, the Updates row shall show `Downloading v<version>… <percent>%` updated as progress arrives, with "Download & Install" and "Check for Updates" both disabled.
- [x] **APP-UPDATE-UI-007**: When a Settings page update download completes, the Updates row shall show `v<version> downloaded. Restart to install.` and replace "Download & Install" with a "Restart & Install" button that invokes `iac.settings.autoUpdate.install`.
- [x] **APP-UPDATE-UI-008**: If a Settings page manual check, update download or update install fails (including a rejected IPC call), then the Updates row shall show the error text with a "Download manually" link to `https://github.com/CoderCoco-Studios/Hyveon/releases` opening in a new window, and after a failed download or install shall offer "Download & Install" again as a retry.
- [x] **APP-UPDATE-UI-009**: While a Settings page manual check has succeeded or an update download is in progress or completed, the Updates row shall not show the "Download manually" link.

## Packaging and feed metadata

- [x] **APP-UPDATE-PKG-001**: `electron-builder.yml` shall declare `publish: github` for `CoderCoco-Studios/Hyveon` so every packaged target embeds electron-updater's `app-update.yml` feed metadata.
- [x] **APP-UPDATE-PKG-002**: The `desktop:package` script shall run electron-builder with `--publish never`, so neither the PR / merge-queue Package workflow nor the release workflow's package job lets electron-builder publish to GitHub Releases.
- [x] **APP-UPDATE-PKG-003**: Each packaging run shall upload its platform's electron-updater feed and installer assets: `latest-linux.yml` with the AppImage, `latest-mac.yml` with both the `dmg` and the `zip` that MacUpdater requires, `latest.yml` with the NSIS `exe`, and every `*.blockmap`. (observed)
- [ ] **APP-UPDATE-PKG-004**: The release repository identity (`CoderCoco-Studios/Hyveon`) shall be declared in one source that electron-builder's `publish` block, the updater's primary and fallback feeds, and the Settings page "Download manually" link all derive from. (observed) (gap: the updater feeds and the Settings link derive from `RELEASE_REPO` in `@hyveon/shared`; the `publish` block in `electron-builder.yml` is still a literal copy, held equal by `packaging-manifest-pins.test.ts` rather than derived)
- [ ] **APP-UPDATE-PKG-005**: The PR / merge-queue Package workflow and the release workflow's package job shall build from one shared platform matrix definition, so their artifact globs cannot drift. (observed) (gap: the matrix is still written in both `.github/workflows/package.yml` and `.github/workflows/release.yml`; `app/test/ci-workflows.test.ts` fails when they differ, but there is no single shared definition)
- [x] **APP-UPDATE-PKG-006**: When `build-package` reinstalls the runner's `@tailwindcss/oxide` native binding, it shall install the version the lockfile resolves. (observed)
- [x] **APP-UPDATE-PKG-007**: The packaging manifest test shall fail when a root runtime dependency pin differs from `@hyveon/desktop-main`'s, when the root Pulumi pins differ from `@hyveon/infra`'s, or when `PULUMI_ENGINE_VERSION` differs from the root `@pulumi/pulumi` pin. (observed)
- [x] **APP-UPDATE-PKG-008**: A check shall fail when the `electron-builder.yml` `files` list omits a runtime dependency of the packages externalized from the main bundle (`@pulumi/*`, `class-validator`, `class-transformer`, `electron-updater`). (observed)

## Release workflow: trigger and range

- [x] **APP-UPDATE-REL-001**: The release workflow shall run only on manual `workflow_dispatch`, accepting optional `from`, `to`, `bump` (`auto|major|minor|patch`, default `auto`), `skip_bump` and `tag` inputs.
- [x] **APP-UPDATE-REL-002**: When the release workflow runs in bump mode with no `from` input, it shall compute the changelog and bump over the range from the newest `v*` tag reachable from `to^` to `to`, with `to` defaulting to main's tip.
- [x] **APP-UPDATE-REL-003**: When the release workflow runs with an explicit `from` input, it shall compute the changelog and bump only over `from..to`, ignoring existing tags.
- [x] **APP-UPDATE-REL-004**: If the release workflow runs in bump mode and the resolved `to` commit is not main's current tip, then it shall fail before generating a changelog, directing the operator to replay mode. (observed; the workflow deliberately accepts no arbitrary `to` in bump mode)
- [x] **APP-UPDATE-REL-005**: When the release workflow runs with no `from` input and no `v*` tag is reachable, it shall compute the changelog over the full history up to `to`, including the root commit.
- [x] **APP-UPDATE-REL-006**: If the release workflow runs with `skip_bump` true and no `tag`, then it shall fail in its first step before any changelog generation or release publication.

## Release workflow: version bump and tag

- [x] **APP-UPDATE-BUMP-001**: When the release workflow's bump strategy is `auto` and the range contains a commit marked breaking (`!` before the colon or a `BREAKING CHANGE:` footer), git-cliff shall compute a major bump.
- [x] **APP-UPDATE-BUMP-002**: When the release workflow's bump strategy is `auto` and the range contains `feat` commits and no breaking markers, git-cliff shall compute a minor bump.
- [x] **APP-UPDATE-BUMP-003**: When the release workflow's bump strategy is `auto` and the range contains only non-`feat`, non-breaking Conventional Commits, git-cliff shall compute a patch bump.
- [x] **APP-UPDATE-BUMP-004**: When the release workflow receives an explicit `bump` of `major`, `minor` or `patch`, it shall use that bump instead of the computed one.
- [x] **APP-UPDATE-BUMP-005**: When no `v*` tag exists yet, the release workflow's bump computation shall produce `v0.1.0` as the first tag. (observed)
- [x] **APP-UPDATE-BUMP-006**: When a bump-mode release run computes a version different from the root `package.json`, it shall set only the root manifest's version (`--workspaces=false`), commit `package.json` and `package-lock.json` as `chore(release): <tag>`, push to protected `main`, and push an annotated tag of the same name, all as the release GitHub App's bot identity rather than `GITHUB_TOKEN`.
- [x] **APP-UPDATE-BUMP-007**: If the computed version already equals the root `package.json` version, or the tag already exists on origin, then the release workflow shall skip that commit or tag step instead of failing. (observed)
- [x] **APP-UPDATE-BUMP-008**: The release workflow shall check out with `persist-credentials: false` and supply the GitHub App token only as a request-scoped header on the bump and tag pushes, so the token is never on disk during the AI summary step. (observed)
- [x] **APP-UPDATE-BUMP-009**: The release changelog shall omit `chore(release):` commits. (observed)
- [x] **APP-UPDATE-BUMP-010**: When a bump-mode release run pushes a tag, the same workflow run shall build and package that tag on Linux, macOS and Windows rather than relying on a separate tag-triggered run.

## Release workflow: notes

- [x] **APP-UPDATE-NOTES-001**: The release workflow shall render the changelog with git-cliff groups in the fixed order Features, Bug Fixes, Refactoring, Documentation, Tests, Chores, Performance, Build System, Continuous Integration, Style, Other. (observed)
- [x] **APP-UPDATE-NOTES-002**: The release workflow shall generate a user-facing summary with `anthropics/claude-code-action` restricted to `Read,Write` tools and prompted to stay grounded strictly in the changelog's facts.
- [x] **APP-UPDATE-NOTES-003**: When the release workflow's AI summary step succeeds and writes a non-empty file, the release body shall be that summary followed by the full raw changelog in a collapsed `<details>` block.
- [x] **APP-UPDATE-NOTES-004**: If the release workflow's AI summary step fails, times out or writes nothing, then the release body shall be the placeholder `_AI summary unavailable._` followed by the full raw changelog in a collapsed `<details>` block, and the run shall continue.

## Release workflow: draft publication and replay

- [x] **APP-UPDATE-DRAFT-001**: When a bump-mode release run's package jobs have all succeeded, the release workflow shall create a draft GitHub Release for the new tag carrying the release notes and every downloaded installer and feed asset, never a published release.
- [x] **APP-UPDATE-DRAFT-002**: While a bump-mode release run is still building installers, no GitHub Release (draft or published) shall exist for the new tag.
- [x] **APP-UPDATE-DRAFT-003**: When a draft release has been created, the release workflow shall fail if any of `latest.yml`, `latest-mac.yml`, `latest-linux.yml` or an `exe`, `dmg`, `zip` or `AppImage` asset is missing. (observed)
- [x] **APP-UPDATE-DRAFT-004**: If the release workflow's asset verification fails, then no draft release missing those assets shall remain for the tag.
- [x] **APP-UPDATE-DRAFT-005**: When the release workflow runs in replay mode for an existing tag, it shall regenerate the changelog and AI summary for the range ending at that tag and rewrite only that release's body, without bumping, committing, tagging, packaging or changing the release's draft/published state.
- [x] **APP-UPDATE-DRAFT-006**: If the release workflow runs in replay mode and no GitHub Release exists for the supplied tag, then it shall fail without creating one. (observed)

## Install and code-signing documentation

- [x] **APP-UPDATE-DOCS-001**: The docs site shall include `docs/docs/install.md` stating that builds are unsigned and why OS warnings appear, and giving per-OS steps: macOS via System Settings → Privacy & Security → "Open Anyway" (right-click → Open only on macOS 14 and earlier), Windows via SmartScreen "More info → Run anyway", and Linux via `chmod +x` on the AppImage.
- [x] **APP-UPDATE-DOCS-002**: The install page shall link to the project's GitHub Releases page as the source of the `.exe`, `.dmg` and `.AppImage` artifacts.
- [x] **APP-UPDATE-DOCS-003**: The repository `README.md` shall carry an Install link near the top that resolves to the published install page.
- [x] **APP-UPDATE-DOCS-004**: The docs site shall include `docs/docs/code-signing-roadmap.md` covering Apple Developer Program enrollment (~$99/yr) with notarization, Azure Trusted Signing (~$10/month), cost and ownership notes, current blockers, and how to enable auto-update by default once signing lands.
- [x] **APP-UPDATE-DOCS-005**: The code-signing roadmap shall state that `mac.hardenedRuntime: false` in `electron-builder.yml` is intentional and must stay until macOS signing lands.
