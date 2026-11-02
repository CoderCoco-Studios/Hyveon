---
parent: operator-app
prefix: APP-UPDATE
---

# App Update and Release

## Context and Design Philosophy

Hyveon ships as one Electron installer per OS, so a "release" is a version of the desktop app, not of any single workspace package. This leaf owns both ends of the one artifact that connects maintainers to operators: the GitHub release feed (installers plus electron-updater's `latest*.yml` manifests and `*.blockmap` files).

The producer side is a manually dispatched GitHub Actions workflow (`.github/workflows/release.yml:1-35`) that computes the next semver from Conventional Commits, bumps the root `package.json`, tags, builds installers on three OSes, and creates a **draft** release a human must publish (`.github/actions/publish-release/action.yml:24-32`). The consumer side is the main-process updater (`app/packages/desktop-main/src/updater.ts`): an opt-in boot-time check gated by the local `enableAutoUpdate` electron-store flag, plus operator-initiated check, download and restart-to-install actions surfaced on the Settings page.

Guiding principles visible in the code:

- **Nothing downloads or installs on its own.** `autoDownload` and `autoInstallOnAppQuit` are pinned to `false` every time `electron-updater` is loaded (`updater.ts:26-27`); only `downloadUpdateNow` and `installDownloadedUpdate` (`updater.ts:197-265`) touch the installer, and both are reached only from operator clicks.
- **Default launch is silent.** `initUpdater` returns before importing `electron-updater` when not in Electron (`updater.ts:79`) or when `enableAutoUpdate` is falsy (`updater.ts:81-84`), so a default install makes zero boot-time feed requests.
- **Humans gate both ends of a release.** The workflow is `workflow_dispatch` only (`release.yml:3-4`) and the release is created as a draft (`publish-release/action.yml:32`).
- **electron-builder never publishes.** `publish: github` in `electron-builder.yml:15-18` exists only to embed `app-update.yml` feed metadata; `desktop:package` always runs with `--publish never` (root `package.json:48`, comment at `electron-builder.yml:10-14`).

What this leaf deliberately does not own:

- The Settings page file and its `ManualCheckState` machine live in `operator-app/desktop-shell` (`app/packages/web/src/pages/settings.page.tsx:64-76`). The Updates rows' behaviour is specified here (`APP-UPDATE-UI-*`) even though their code sits in that file, under the project's spec-ownership rule (`docs/high-level-design.md`, "Spec ownership across segments").
- The preload bridge and the generic `ipcMain` bridge live in `operator-app/ipc-bridge`; this leaf relies on the `SELF_BRIDGED_PATTERNS` entry for the download stream (`app/packages/desktop-main/src/ipc-main-bridge.ts:27`).
- `iac-settings.controller.ts` belongs to `deployment-config`. The five auto-update IPC handlers on its `IacSettingsController` (`app/packages/desktop-main/src/controllers/iac-settings.controller.ts:228-320`) are this leaf's channels, since `enableAutoUpdate` is not a `DeploymentConfig` field (`app/packages/shared/src/autoUpdateSetting.ts:1-9`); they move to a controller this leaf owns, keeping their `iac.settings.autoUpdate.*` names (Decisions & Alternatives, "Placement of the update channels").
- The electron-store schema (`ElectronStoreService.ts:203`) belongs to `operator-app/wizard-and-bootstrap`; the boot sequence that calls `initUpdater` (`electron-entry.ts:217-223`) belongs to `operator-app/desktop-shell`; `PULUMI_ENGINE_VERSION` belongs to `iac/engine`.

CLAUDE.md invariants that apply here: the desktop app has no HTTP transport (update channels are Electron IPC only), every `@MessagePattern` handler logs on entry (`iac-settings.controller.ts:230`, `:252`, `:278`, `:293`, `:318`), and `@hyveon/shared`'s barrel stays free of new AWS SDK imports (`autoUpdateSetting.ts` is pure types).

## Release Production Pipeline

`release.yml` has three jobs. Only the first runs in replay mode.

| Job | Lines | Responsibility |
|---|---|---|
| `release` | `release.yml:40-317` | Validate inputs, mint a GitHub App token, resolve the commit range, render the changelog, compute the bump, write the AI summary, push the bump commit and annotated tag (bump mode) or rewrite an existing release body (replay mode) |
| `package` | `release.yml:322-370` | Three-OS matrix that checks out the **tag** (`:363`) and runs the shared `setup-app` + `build-package` composite actions |
| `publish` | `release.yml:372-386` | Runs `publish-release`, which downloads `pkg-*` and `release-notes`, creates the draft, then verifies assets |

### Inputs and range resolution

Inputs are `from`, `to`, `bump` (`auto|major|minor|patch`), `skip_bump` and `tag` (`release.yml:5-34`). Replay mode without `tag` fails immediately (`release.yml:54-57`). In replay mode `to` is the supplied tag (`:88-89`); otherwise `to` defaults to `HEAD` and is resolved to a SHA (`:91-99`). In bump mode the resolved `to` must equal main's tip or the job fails, pointing the operator at replay mode instead (`release.yml:101-107`). `from` defaults to the newest `v*` tag reachable from `to^` (`:109-112`); with no prior tag the range is `to` alone so the root commit is included (`:114-123`).

This is stricter than accepting an arbitrary `from`/`to` in bump mode (APP-UPDATE-REL-003, APP-UPDATE-REL-004). The rule exists so the pushed tag always describes the commit the changelog was built against (error text at `release.yml:104`).

### Changelog, bump and summary

`git-cliff@2.13.1` is run through `npx` three times: rendered changelog, `--context` JSON (`release.yml:137-138`), and `--bumped-version` with an optional `--bump` override (`:154-161`). `cliff.toml` renders groups in a fixed order (`cliff.toml:13-28`), skips `chore(release):` commits so bump commits never appear in later changelogs (`:59`), treats `!` and `BREAKING CHANGE:` as breaking (`:64-67`), bumps minor on features and major on breaking changes (`:69-71`), and seeds the first tag as `v0.1.0` (`:76`).

The AI summary step runs `anthropics/claude-code-action@v1` with `continue-on-error: true`, `Read,Write` tools only, and model `claude-sonnet-5-5` (`release.yml:175-197`). The body is always the summary (or the literal `_AI summary unavailable._` when the step failed or wrote nothing) followed by the raw changelog in a collapsed `<details>` block (`release.yml:199-226`). On failure the body is therefore the placeholder plus the changelog rather than the bare changelog (APP-UPDATE-NOTES-004). The model is pinned in the action's `claude_args`, so a model change is a workflow edit, not a configuration change.

### Bump commit and tag

The commit identity is the GitHub App's bot user (`release.yml:230-240`). Checkout runs with `persist-credentials: false` (`:71`), and the App token is supplied per-push through a request-scoped `http.extraheader` so the AI step never had the token on disk (`release.yml:253-259`). `npm version "$TARGET_VERSION" --no-git-tag-version --workspaces=false` bumps only the root manifest (`:272`); the commit stages both `package.json` and `package-lock.json` (`:273`). Both steps are idempotent: an unchanged version skips the commit (`:263-270`) and an existing remote tag skips tag creation (`:278-283`). As a result, root `package.json:3` is `0.9.1` while workspace manifests (`app/package.json:3`, `desktop-main/package.json:3`) stay at `1.0.0`.

### Packaging and draft publication

`build-package` reinstalls `@tailwindcss/oxide@4.3.0` without saving to fetch the runner's native binding (`.github/actions/build-package/action.yml:13-19`), then runs `app:build` and `desktop:package` and uploads the matrix's glob (`:21-34`). The matrix globs carry the feed files the updater needs: `latest-linux.yml` (`release.yml:333-336`), `latest-mac.yml` plus a `zip` because MacUpdater ignores `dmg` (`:339-346`), and `latest.yml` (`:349-353`). The same matrix is repeated in `package.yml`, held together by the comment at `release.yml:319-321`; `package.yml` itself runs on `pull_request` and `merge_group` (`package.yml:3-6`) as a packaging gate.

`publish-release` creates the draft first (`publish-release/action.yml:24-32`) and verifies the three feeds plus `exe`/`dmg`/`zip`/`AppImage` afterwards (`:37-61`). The comment at `:22-23` claims "a draft that exists always has all its assets"; that holds only because the job needs every `package` leg to succeed, and a failed verification still leaves the incomplete draft behind.

Replay mode skips `package` and `publish` (`release.yml:324`) and PATCHes the existing release's body through `gh api`, failing if no release has that tag (`release.yml:299-317`). Replay is a direct PATCH of the existing release, not an upsert by tag, and packaging runs inside `release.yml` rather than through `package.yml`'s tag trigger (`release.yml:319-321`).

### Packaged runtime closure

Because `electron-updater`, `@pulumi/*`, `class-validator` and `class-transformer` are externalized from the main bundle (`electron.vite.config.ts:104-111`), `electron-builder.yml:20-216` hand-lists their transitive runtime `node_modules` globs, with an explicit warning that new transitive deps are not picked up automatically (`:45-47`). `app/test/packaging-manifest-pins.test.ts:61-100` guards that root runtime pins match `desktop-main`/`infra` and that `PULUMI_ENGINE_VERSION` equals the root `@pulumi/pulumi` pin; nothing guards the `files` list itself. `extraResources` ships the icon, six Lambda bundles and the IAM bootstrap template (`electron-builder.yml:218-242`). macOS builds are unsigned with `hardenedRuntime: false` (`electron-builder.yml:255`), which `docs/docs/code-signing-roadmap.md:29-38` documents.

## Updater Runtime

### Shared helpers

`loadAutoUpdater()` imports `electron-updater` dynamically through `.default` because `autoUpdater` is a getter-defined CJS export that a named dynamic import resolves to `undefined` (`updater.ts:23-29`). It runs on every entry point, so the two `false` pins are reapplied each time.

`checkWithFallback()` calls `checkForUpdates()`; on rejection it asks `resolveFallbackFeedUrl(process.platform)` for a generic-provider URL, retries once against it, and always restores `PRIMARY_FEED` in `finally` because `setFeedURL` mutates the process-wide singleton (`updater.ts:42-63`). The original primary error is rethrown when no fallback exists or the retry fails (`:47`, `:57`).

`resolveFallbackFeedUrl` fetches the 10 newest releases unauthenticated with a 10 s timeout (`updater-fallback.ts:10-12`, `:69-72`), returns `null` on non-2xx, non-array bodies or any exception (`:73-84`), and maps the chosen release to `https://github.com/<repo>/releases/download/<tag>` (`:80`). `pickFallbackRelease` skips drafts, prereleases and releases lacking the platform feed (`latest.yml` / `latest-mac.yml` / `latest-linux.yml`, `:15-19`), then keeps the greatest `published_at`, treating missing or invalid dates as oldest and keeping the earlier entry on ties (`updater-fallback.ts:31-58`).

### Entry points

| Function | Gate | Behaviour | Result |
|---|---|---|---|
| `initUpdater(store)` (`updater.ts:78-108`) | Electron and `enableAutoUpdate` | Attaches four persistent logging listeners (`:88-101`), runs `checkWithFallback`, swallows the rejection (`:103-107`) | `void`; events are logged only |
| `checkForUpdatesNow()` (`updater.ts:128-175`) | Electron only; ignores the flag | Resolves from the first `update-available` / `update-not-available` event; a no-op `error` listener swallows events so the fallback can rescue a failed primary (`:151-153`); `null` from the check means the updater is disabled for this build (`:161-166`) | `ManualUpdateCheckResult` |
| `downloadUpdateNow(onProgress)` (`updater.ts:197-242`) | Electron only | Forwards `download-progress`, records the `update-downloaded` version, retries once after a re-check when the rejection message equals `'Please check update first'` (`:178`, `:224-228`), removes listeners in `finally` | `UpdateDownloadResult` |
| `installDownloadedUpdate()` (`updater.ts:251-265`) | Electron only | Calls `quitAndInstall(false, true)` (not silent, relaunch after) and returns `{ ok: true }` | `UpdateInstallResult` |

`electron-entry.ts:217-223` fires `initUpdater` without awaiting it and adds its own `.catch` as a second guarantee against an unhandled rejection; a failed `import('electron-updater')` inside `initUpdater` is not caught by `initUpdater` itself and relies on that outer catch.

Closing the Settings page mid-download does not cancel it: the main process keeps downloading and only progress consumption stops. An install-failure retry re-downloads, with `electron-updater` serving the cached file when present. An unsigned macOS build can fail the download with a code-signature error; that surfaces as an ordinary failure with the "Download manually" link and gets no special handling.

Two behaviours are worth stating plainly. First, `installDownloadedUpdate` does not check that a download completed, although `autoUpdateSetting.ts:86-91` (`UpdateInstallResult` doc) lists "no update has been downloaded" as an `ok: false` case; the Settings page only offers "Restart & Install" after a completed download (`settings.page.tsx:66`, `:227`), which masks the gap. What `electron-updater` does when nothing is downloaded is `[unverified]`. Second, when `enableAutoUpdate` is on, `initUpdater`'s persistent `error` listener (`updater.ts:88-92`) stays attached for the process lifetime, so manual-check and download failures are also logged as "[updater] update check failed" alongside their own log lines `[inferred]` from listener lifetime.

### The flag's scope

`enableAutoUpdate` is an optional boolean in the electron-store schema (`ElectronStoreService.ts:203`), read as `false` when unset (`iac-settings.controller.ts:234`). Writing it has no effect until the next launch because `initUpdater` runs once at boot (`iac-settings.controller.ts:244-249`).

The flag cannot mean "no update-related network calls for a full session", because an on-demand check runs independent of it: `checkForUpdatesNow` and its fallback `fetch` never read the flag, so the gate covers only the boot-time check (`updater.ts:81`). The flag therefore means "no automatic network activity" (APP-UPDATE-BOOT-004).

## IPC Channel Contract

All five channels are handled by `IacSettingsController` until they move to a controller owned by this leaf, with the channel names below unchanged; payload and result types live in `app/packages/shared/src/autoUpdateSetting.ts`.

| Channel | Kind | Payload | Result | Handler |
|---|---|---|---|---|
| `iac.settings.autoUpdate.get` | invoke | none | `AutoUpdateSettingGetResult`: `{ ok, enableAutoUpdate, appVersion }` or `{ ok: false, code: 'error', message }` (`autoUpdateSetting.ts:12-28`) | `iac-settings.controller.ts:228-242` |
| `iac.settings.autoUpdate.update` | invoke | `{ enableAutoUpdate: boolean }` | `AutoUpdateSettingWriteResult`; rejects non-boolean and missing store (`iac-settings.controller.ts:254-260`) | `iac-settings.controller.ts:250-268` |
| `iac.settings.autoUpdate.check` | invoke | none | `ManualUpdateCheckResult` (`autoUpdateSetting.ts:58-61`) | `iac-settings.controller.ts:276-280` |
| `iac.settings.autoUpdate.download` | self-bridged stream | none | Ack `{ started: true, streamId }`; progress on `.download.chunk`; one terminal message on `.download.end` with `version` or `error` | `iac-settings.controller.ts:291-310`, bridge registered in `onModuleInit` (`:104-120`) |
| `iac.settings.autoUpdate.install` | invoke | none | `UpdateInstallResult` | `iac-settings.controller.ts:316-320` |

The download handler is self-bridged because it needs the `IpcMainInvokeEvent` sender, which Nest's RPC context drops for `@MessagePattern` handlers (`iac-settings.controller.ts:104-110`). It starts `downloadUpdateNow` without awaiting, sends nothing once the sender is destroyed (`:298`, `:302`), and returns the ack immediately (`:309`). The chunk and end channel names are declared twice, once in the controller (`iac-settings.controller.ts:35-38`) and once in preload (`app/packages/desktop-preload/src/preload.ts:156-160`). The progress sample mirrors four `ProgressInfo` fields (`autoUpdateSetting.ts:68-77`, `updater.ts:205-212`).

The renderer's "Download manually" link points at `RELEASES_URL` (`settings.page.tsx:79`). The release repository `CoderCoco-Studios/Hyveon` is therefore written in four places: `electron-builder.yml:16-18`, `updater-fallback.ts:5`, `updater-fallback.ts:8` and `settings.page.tsx:79`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Changelog and bump engine | `git-cliff@2.13.1` via `npx`, config in `cliff.toml` | `release-please`, `semantic-release`, `conventional-changelog-cli`, `orhun/git-cliff-action` | Only git-cliff supports explicit ranges and a changelog-only replay without inventing a tag. `release-please` and `semantic-release` are push-driven state machines (a release PR, or a next version computed from full history); `conventional-changelog-cli` primitives were the fallback and proved unnecessary. The action is a thin wrapper around the same CLI flags and adds argument-string marshalling in a workflow that already runs Node. The auto-bump heuristic can disagree with intent (a `fix` that is really breaking, with no footer), so the `bump` input always allows an explicit override |
| What gets versioned | Root `package.json` only, `--workspaces=false` (`release.yml:272`) | Per-workspace versioning | All packages ship in one installer, so only the root version is externally meaningful. git-cliff computes the version string but does not write `package.json`, so the workflow applies it with `npm version --no-git-tag-version`, and `--workspaces=false` stops that cascading into workspace manifests |
| Push identity on protected `main` | GitHub App installation token with ruleset bypass (`release.yml:59-64`) | `GITHUB_TOKEN`, personal PAT, auto-merge version-bump PR | `GITHUB_TOKEN` pushes do not trigger other workflows (a platform restriction), so a tag pushed with it would wake nothing downstream. A personal PAT ties the release identity to a human, has broad default scope and no predictable expiry. The App token is short-lived (1 h) and repo-scoped, and its pushes trigger downstream workflows. An auto-merge version-bump PR adds a full CI cycle and a second workflow to find the squashed SHA without removing any risk the direct push carries: the main ruleset already permits bypass actors and requires zero approving reviews, so it avoids no deadlock. A bypass actor is still a hole in "no direct pushes to main"; it is bounded by limiting the App to Contents read/write, by invocation only through `workflow_dispatch` (which itself requires repo write), and by every push being attributable to the bot in the audit log |
| AI summary mechanism | `anthropics/claude-code-action` with OAuth token, `Read,Write` tools only, `continue-on-error` | Hand-rolled Messages API script | A direct API script bills a metered `ANTHROPIC_API_KEY`, whereas `claude_code_oauth_token` bills a Claude subscription; that outweighed the heavier harness. The action is given only `Read` and `Write`, so it behaves as a scoped file-in, file-out summarizer that cannot touch git state. A summary that invents features is bounded by a prompt constraint to the changelog's facts (APP-UPDATE-NOTES-002) and by a human reviewing the draft before it is published |
| Release visibility | Draft only, created after all platform builds (`publish-release/action.yml:22-32`) | Auto-publish | A human must approve before a release is public: no release becomes visible without a separate explicit human action |
| Replay tag trust | Replay trusts the operator-supplied `tag` and does not re-validate that the tag's range matches what was originally released | Re-validating the range | Replay is an explicit corrective action by an operator who knows which release they are regenerating, and `workflow_dispatch` already requires repo write |
| Where packaging runs for a release | `package` matrix inside `release.yml`, steps shared via composite actions | Reusable workflow; `package.yml` tag-triggered publish (the original design) | Avoids a skipped doc-only filter job in release runs (`release.yml:319-321`); the matrix duplication is the cost |
| Bump-mode `to` | Must equal main's tip (`release.yml:101-107`) | Any ref | The tag must describe the commit the changelog was built against (`release.yml:104`) |
| Who publishes installers | `softprops/action-gh-release`; electron-builder runs `--publish never` | electron-builder `--publish always` | Keeps one publishing path even though `GH_TOKEN` is present in CI (`electron-builder.yml:10-14`) |
| Boot-time update check | Opt-in via `enableAutoUpdate`, default off, lazy import (`updater.ts:65-84`) | Always-on check | First launch must produce zero update-feed traffic (APP-UPDATE-BOOT-001, APP-UPDATE-BOOT-002; doc comment `updater.ts:67-77`) |
| Download and install | Explicit operator actions only; `autoDownload` / `autoInstallOnAppQuit` pinned `false` (`updater.ts:26-27`) | electron-updater defaults (both `true`) | A detected update must never download or install itself; the only code paths that call `downloadUpdate()` or `quitAndInstall()` are the two operator-driven handlers, and a downloaded-but-not-installed update is simply discarded at quit (APP-UPDATE-DL-001) |
| Recovering from a release without a feed | One retry against the newest feed-bearing release via the generic provider, original error surfaced on failure (`updater.ts:42-63`) | Fail outright; authenticated API lookup | A release shipped without `latest.yml` otherwise 404s every check, and the GitHub provider resolves only the latest published release: v0.7.0 shipped with no assets. Clients older than v0.7.3 predate this recovery and need one manual update. Unauthenticated 60 req/hr suffices because the lookup runs only on failure. The newest eligible release is chosen by `published_at` rather than array position, and pagination is deliberately absent (`per_page=10`; see APP-UPDATE-FALL-007). A failed manual check is decided by the rejection of the check-with-fallback call, not the first `error` event, so the primary failure's event cannot resolve before the retry |
| Download progress transport | Self-bridged side-channel stream with `streamId` ack (`iac-settings.controller.ts:291-310`) | Plain invoke with no progress; polling | Reuses the existing `iac.stack.initialize` side-channel stream pattern: preload wraps the chunk and end pushes in a buffered stream handle, and a failed download arrives as the end message's `error`, so the renderer's `for await` throws. The handler needs the `IpcMainInvokeEvent` sender, hence self-bridging |
| Missing cached check before download | Re-check once when the rejection text is `'Please check update first'` (`updater.ts:224-228`) | Track check state in the app | `electron-updater` caches the check's update info on its singleton and rejects a download without it, so the retry avoids a dead end when the app restarted between check and click; matching by message text rather than state is `[inferred]` to be the simplest available signal |
| Placement of the update channels | A controller owned by this leaf, separate from `deployment-config`'s `IacSettingsController`, keeping the `iac.settings.autoUpdate.*` channel names; the channels are hosted on `IacSettingsController` until they move | Whole of `iac-settings.controller.ts` owned by `deployment-config`, hosting the channels on this leaf's behalf; whole of `iac-settings.controller.ts` owned by this leaf | Every controller belongs to the leaf whose behaviour it serves (`ipc-bridge-design.md`, "What it deliberately does not own"). `enableAutoUpdate` is a local electron-store flag, not a `DeploymentConfig` field (`autoUpdateSetting.ts:1-9`), so the channels are not `deployment-config`'s; `iac.settings.get`, `iac.settings.update` and `iac.settings.engineVersion` are not this leaf's behaviour |
| Spec home for the Updates rows | `APP-UPDATE-UI-*` in this leaf, with the code in `desktop-shell`'s `settings.page.tsx` | Specs in `desktop-shell`, the leaf that owns the file | An EARS spec lives in the leaf whose behaviour it specifies (`docs/high-level-design.md`, "Spec ownership across segments") |
| Packaged runtime closure | Hand-maintained `node_modules` globs (`electron-builder.yml:20-216`) | Bundling the packages; generated list | Bundling `@pulumi/*` risks an Electron-never-quits failure via `@grpc/grpc-js` (`electron-builder.yml:22-28`); hand maintenance over generation is `[inferred]` |

## Open Questions & Future Decisions

### Resolved

1. ✅ git-cliff over release-please / semantic-release, for explicit ranges and replay.
2. ✅ GitHub App token over `GITHUB_TOKEN` / PAT / auto-merge PR for the protected-branch push.
3. ✅ Fallback feed via the generic provider, original error wins, primary feed restored.
4. ✅ Download and install are explicit operator actions; a downloaded-but-not-installed update is discarded at quit.
5. ✅ Unsigned macOS download failures surface as ordinary failures with the "Download manually" link, no special handling.
6. ✅ The five auto-update channels move from `deployment-config`'s `IacSettingsController` to a controller owned by this leaf, keeping their `iac.settings.autoUpdate.*` names (Decisions & Alternatives, "Placement of the update channels"; `docs/arrows/operator-app/app-update-and-release.md`, Work Required).
7. ✅ `enableAutoUpdate` gates only automatic boot-time activity; an operator-initiated check runs regardless of it (APP-UPDATE-BOOT-004).

### Deferred

1. Should `installDownloadedUpdate` (`updater.ts:251-265`) refuse when no download completed, or should the `UpdateInstallResult` doc (`autoUpdateSetting.ts:86-91`) stop promising that failure case? What does `quitAndInstall` do with nothing downloaded (`[unverified]`)?
2. Should `publish-release` verify assets before creating the draft, or delete the draft on verification failure (`publish-release/action.yml:22-61`)?
3. Can the release repo identity come from one source instead of four (`electron-builder.yml:16-18`, `updater-fallback.ts:5`, `:8`, `settings.page.tsx:79`)?
4. Can the packaging matrix be extracted so `release.yml:325-354` and `package.yml` cannot drift?
5. Should the `@tailwindcss/oxide@4.3.0` reinstall (`build-package/action.yml:18`) read its version from the lockfile, which resolves `4.3.3`?
6. Can the "no prior check" retry key off updater state rather than the literal `'Please check update first'` (`updater.ts:178`, `:225`)?
7. Should the fallback lookup paginate or widen beyond `per_page=10` (`updater-fallback.ts:10`)?
8. Should workspace manifests track the released version, or should the bump commit stop staging `package-lock.json` so it contains only the version change (APP-UPDATE-BUMP-006) (`release.yml:272-273`)?
9. Can a script or test verify that `electron-builder.yml:20-216` covers the externalized packages' runtime closure?
10. Should the plan-history wording at `electron-builder.yml:239-240` ("A later group's GuidedIamService") be dropped under the repo's comment rules?
11. Is it intended that, with `enableAutoUpdate` on, `initUpdater`'s persistent `error` listener (`updater.ts:88-92`) also logs every later manual-check and download failure?

## References

- Arrow doc: `docs/arrows/operator-app/app-update-and-release.md`
- EARS specs: `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md`
- Docs: `docs/docs/app/settings.md`, `docs/docs/install.md`, `docs/docs/code-signing-roadmap.md`, `docs/docs/guides/maintainer.md`, `docs/docs/components/management-app.md`
- Neighbouring leaf designs: `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/iac/engine/engine-design.md`
