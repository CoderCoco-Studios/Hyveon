---
parent: operator-app
prefix: APP-UPDATE
---

# App Update and Release

## Context and Design Philosophy

Hyveon ships as one Electron installer per OS, so a "release" is a version of the desktop app, not of any single workspace package. This leaf owns both ends of the one artifact that connects maintainers to operators: the GitHub release feed (installers plus electron-updater's `latest*.yml` manifests and `*.blockmap` files).

The producer side is a manually dispatched GitHub Actions workflow (`.github/workflows/release.yml:1-35`) that computes the next semver from Conventional Commits, bumps the root `package.json`, tags, builds installers on three OSes, and creates a **draft** release a human must publish (`.github/actions/publish-release/action.yml:24-32`). The consumer side is the main-process updater (`app/packages/desktop-main/src/updater.ts`): an opt-in boot-time check gated by the local `enableAutoUpdate` electron-store flag, plus operator-initiated check, download and restart-to-install actions surfaced on the Settings page.

Guiding principles visible in the code:

- **Nothing downloads or installs on its own.** `autoDownload` and `autoInstallOnAppQuit` are pinned to `false` every time `electron-updater` is loaded (`updater.ts:22-28`); only `downloadUpdateNow` and `installDownloadedUpdate` (`updater.ts:189-256`) touch the installer, and both are reached only from operator clicks.
- **Default launch is silent.** `initUpdater` returns before importing `electron-updater` when not in Electron (`updater.ts:75`) or when `enableAutoUpdate` is falsy (`updater.ts:77-80`), so a default install makes zero boot-time feed requests.
- **Humans gate both ends of a release.** The workflow is `workflow_dispatch` only (`release.yml:3-4`) and the release is created as a draft (`publish-release/action.yml:32`).
- **electron-builder never publishes.** `publish: github` in `electron-builder.yml:15-18` exists only to embed `app-update.yml` feed metadata; `desktop:package` always runs with `--publish never` (root `package.json:48`, comment at `electron-builder.yml:10-14`).

What this leaf deliberately does not own:

- The Settings page UI and its `ManualCheckState` machine live in `operator-app/desktop-shell` (`app/packages/web/src/pages/settings.page.tsx:64-76`), described here only as the consumer of the channel contract.
- The preload bridge and the generic `ipcMain` bridge live in `operator-app/ipc-bridge`; this leaf relies on the `SELF_BRIDGED_PATTERNS` entry for the download stream (`app/packages/desktop-main/src/ipc-main-bridge.ts:27`).
- The five auto-update IPC handlers are methods on `IacSettingsController`, owned by `deployment-config` (`app/packages/desktop-main/src/controllers/iac-settings.controller.ts:228-320`), even though `enableAutoUpdate` is not a `DeploymentConfig` field (`app/packages/shared/src/autoUpdateSetting.ts:1-9`).
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

This is stricter than the `release-automation` spec's "Trigger with explicit range" scenario, which permits an arbitrary `from`/`to` in bump mode. The code's rule exists so the pushed tag always describes the commit the changelog was built against (error text at `release.yml:104`); the spec does not state it.

### Changelog, bump and summary

`git-cliff@2.13.1` is run through `npx` three times: rendered changelog, `--context` JSON (`release.yml:137-138`), and `--bumped-version` with an optional `--bump` override (`:154-161`). `cliff.toml` renders groups in a fixed order (`cliff.toml:13-28`), skips `chore(release):` commits so bump commits never appear in later changelogs (`:59`), treats `!` and `BREAKING CHANGE:` as breaking (`:64-67`), bumps minor on features and major on breaking changes (`:69-71`), and seeds the first tag as `v0.1.0` (`:76`).

The AI summary step runs `anthropics/claude-code-action@v1` with `continue-on-error: true`, `Read,Write` tools only, and model `claude-sonnet-5-5` (`release.yml:175-197`). The body is always the summary (or the literal `_AI summary unavailable._` when the step failed or wrote nothing) followed by the raw changelog in a collapsed `<details>` block (`release.yml:199-226`). The `release-automation` spec instead says the raw changelog becomes the body on failure. The `add-release-automation` design names `--model claude-opus-5` (`openspec/changes/add-release-automation/design.md`, "AI summary" decision); the workflow pins a different model.

### Bump commit and tag

The commit identity is the GitHub App's bot user (`release.yml:230-240`). Checkout runs with `persist-credentials: false` (`:71`), and the App token is supplied per-push through a request-scoped `http.extraheader` so the AI step never had the token on disk (`release.yml:253-259`). `npm version "$TARGET_VERSION" --no-git-tag-version --workspaces=false` bumps only the root manifest (`:272`); the commit stages both `package.json` and `package-lock.json` (`:273`). Both steps are idempotent: an unchanged version skips the commit (`:263-270`) and an existing remote tag skips tag creation (`:278-283`). As a result, root `package.json:3` is `0.9.1` while workspace manifests (`app/package.json:3`, `desktop-main/package.json:3`) stay at `1.0.0`.

### Packaging and draft publication

`build-package` reinstalls `@tailwindcss/oxide@4.3.0` without saving to fetch the runner's native binding (`.github/actions/build-package/action.yml:13-19`), then runs `app:build` and `desktop:package` and uploads the matrix's glob (`:21-34`). The matrix globs carry the feed files the updater needs: `latest-linux.yml` (`release.yml:333-336`), `latest-mac.yml` plus a `zip` because MacUpdater ignores `dmg` (`:339-346`), and `latest.yml` (`:349-353`). The same matrix is repeated in `package.yml`, held together by the comment at `release.yml:319-321`; `package.yml` itself runs on `pull_request` and `merge_group` (`package.yml:3-6`) as a packaging gate.

`publish-release` creates the draft first (`publish-release/action.yml:24-32`) and verifies the three feeds plus `exe`/`dmg`/`zip`/`AppImage` afterwards (`:37-61`). The comment at `:22-23` claims "a draft that exists always has all its assets"; that holds only because the job needs every `package` leg to succeed, and a failed verification still leaves the incomplete draft behind.

Replay mode skips `package` and `publish` (`release.yml:324`) and PATCHes the existing release's body through `gh api`, failing if no release has that tag (`release.yml:299-317`). The `add-release-automation` design describes replay as a `softprops/action-gh-release` upsert and describes reusing `package.yml`'s tag-triggered publish path; current code does neither (packaging moved into `release.yml`, `:319-321`).

### Packaged runtime closure

Because `electron-updater`, `@pulumi/*`, `class-validator` and `class-transformer` are externalized from the main bundle (`electron.vite.config.ts:104-111`), `electron-builder.yml:20-216` hand-lists their transitive runtime `node_modules` globs, with an explicit warning that new transitive deps are not picked up automatically (`:45-47`). `app/test/packaging-manifest-pins.test.ts:61-100` guards that root runtime pins match `desktop-main`/`infra` and that `PULUMI_ENGINE_VERSION` equals the root `@pulumi/pulumi` pin; nothing guards the `files` list itself. `extraResources` ships the icon, six Lambda bundles and the IAM bootstrap template (`electron-builder.yml:218-242`). macOS builds are unsigned with `hardenedRuntime: false` (`electron-builder.yml:255`), which `docs/docs/code-signing-roadmap.md:29-38` documents.

## Updater Runtime

### Shared helpers

`loadAutoUpdater()` imports `electron-updater` dynamically through `.default` because `autoUpdater` is a getter-defined CJS export that a named dynamic import resolves to `undefined` (`updater.ts:12-28`). It runs on every entry point, so the two `false` pins are reapplied each time.

`checkWithFallback()` calls `checkForUpdates()`; on rejection it asks `resolveFallbackFeedUrl(process.platform)` for a generic-provider URL, retries once against it, and always restores `PRIMARY_FEED` in `finally` because `setFeedURL` mutates the process-wide singleton (`updater.ts:40-61`). The original primary error is rethrown when no fallback exists or the retry fails (`:45`, `:55`).

`resolveFallbackFeedUrl` fetches the 10 newest releases unauthenticated with a 10 s timeout (`updater-fallback.ts:10-12`, `:65-70`), returns `null` on non-2xx, non-array bodies or any exception (`:71-82`), and maps the chosen release to `https://github.com/<repo>/releases/download/<tag>` (`:78`). `pickFallbackRelease` skips drafts, prereleases and releases lacking the platform feed (`latest.yml` / `latest-mac.yml` / `latest-linux.yml`, `:15-19`), then keeps the greatest `published_at`, treating missing or invalid dates as oldest and keeping the earlier entry on ties (`updater-fallback.ts:30-57`).

### Entry points

| Function | Gate | Behaviour | Result |
|---|---|---|---|
| `initUpdater(store)` (`updater.ts:74-104`) | Electron and `enableAutoUpdate` | Attaches four persistent logging listeners (`:84-97`), runs `checkWithFallback`, swallows the rejection (`:99-103`) | `void`; events are logged only |
| `checkForUpdatesNow()` (`updater.ts:122-169`) | Electron only; ignores the flag | Resolves from the first `update-available` / `update-not-available` event; a no-op `error` listener swallows events so the fallback can rescue a failed primary (`:145-151`); `null` from the check means the updater is disabled for this build (`:155-160`) | `ManualUpdateCheckResult` |
| `downloadUpdateNow(onProgress)` (`updater.ts:189-234`) | Electron only | Forwards `download-progress`, records the `update-downloaded` version, retries once after a re-check when the rejection message equals `'Please check update first'` (`:171-172`, `:214-221`), removes listeners in `finally` | `UpdateDownloadResult` |
| `installDownloadedUpdate()` (`updater.ts:242-256`) | Electron only | Calls `quitAndInstall(false, true)` (not silent, relaunch after) and returns `{ ok: true }` | `UpdateInstallResult` |

`electron-entry.ts:217-223` fires `initUpdater` without awaiting it and adds its own `.catch` as a second guarantee against an unhandled rejection; a failed `import('electron-updater')` inside `initUpdater` is not caught by `initUpdater` itself and relies on that outer catch.

Two behaviours are worth stating plainly. First, `installDownloadedUpdate` does not check that a download completed, although `autoUpdateSetting.ts:86-91` (`UpdateInstallResult` doc) lists "no update has been downloaded" as an `ok: false` case; the Settings page only offers "Restart & Install" after a completed download (`settings.page.tsx:66`, `:227`), which masks the gap. What `electron-updater` does when nothing is downloaded is `[unverified]`. Second, when `enableAutoUpdate` is on, `initUpdater`'s persistent `error` listener (`updater.ts:84-88`) stays attached for the process lifetime, so manual-check and download failures are also logged as "[updater] update check failed" alongside their own log lines `[inferred]` from listener lifetime.

### The flag and the spec contradiction

`enableAutoUpdate` is an optional boolean in the electron-store schema (`ElectronStoreService.ts:203`), read as `false` when unset (`iac-settings.controller.ts:234`). Writing it has no effect until the next launch because `initUpdater` runs once at boot (`iac-settings.controller.ts:244-249`).

`openspec/specs/auto-update-scaffold/spec.md` requires both that a disabled updater produce "no update-related network calls" for a full session ("Update-check telemetry is gated by the same flag", `:29-37`) and that an on-demand check run "independent of the `enableAutoUpdate` flag" (`:86-90`). The code implements the second: `checkForUpdatesNow` and its fallback `fetch` never read the flag, so the gate covers only the boot-time check (`updater.ts:77`). The spec's own wording should be read as "no automatic network activity" until it is reconciled.

## IPC Channel Contract

All five channels are handled by `IacSettingsController`; payload and result types live in `app/packages/shared/src/autoUpdateSetting.ts`.

| Channel | Kind | Payload | Result | Handler |
|---|---|---|---|---|
| `iac.settings.autoUpdate.get` | invoke | none | `AutoUpdateSettingGetResult`: `{ ok, enableAutoUpdate, appVersion }` or `{ ok: false, code: 'error', message }` (`autoUpdateSetting.ts:12-28`) | `iac-settings.controller.ts:228-242` |
| `iac.settings.autoUpdate.update` | invoke | `{ enableAutoUpdate: boolean }` | `AutoUpdateSettingWriteResult`; rejects non-boolean and missing store (`iac-settings.controller.ts:254-260`) | `iac-settings.controller.ts:250-268` |
| `iac.settings.autoUpdate.check` | invoke | none | `ManualUpdateCheckResult` (`autoUpdateSetting.ts:58-61`) | `iac-settings.controller.ts:276-280` |
| `iac.settings.autoUpdate.download` | self-bridged stream | none | Ack `{ started: true, streamId }`; progress on `.download.chunk`; one terminal message on `.download.end` with `version` or `error` | `iac-settings.controller.ts:291-310`, bridge registered in `onModuleInit` (`:104-120`) |
| `iac.settings.autoUpdate.install` | invoke | none | `UpdateInstallResult` | `iac-settings.controller.ts:316-320` |

The download handler is self-bridged because it needs the `IpcMainInvokeEvent` sender, which Nest's RPC context drops for `@MessagePattern` handlers (`iac-settings.controller.ts:104-110`). It starts `downloadUpdateNow` without awaiting, sends nothing once the sender is destroyed (`:298`, `:302`), and returns the ack immediately (`:309`). The chunk and end channel names are declared twice, once in the controller (`iac-settings.controller.ts:35-38`) and once in preload (`app/packages/desktop-preload/src/preload.ts:156-160`). The progress sample mirrors four `ProgressInfo` fields (`autoUpdateSetting.ts:68-77`, `updater.ts:197-204`).

The renderer's "Download manually" link points at `RELEASES_URL` (`settings.page.tsx:79`). The release repository `CoderCoco-Studios/Hyveon` is therefore written in four places: `electron-builder.yml:16-18`, `updater-fallback.ts:5`, `updater-fallback.ts:8` and `settings.page.tsx:79`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Changelog and bump engine | `git-cliff@2.13.1` via `npx`, config in `cliff.toml` | `release-please`, `semantic-release`, `conventional-changelog-cli`, `orhun/git-cliff-action` | Only git-cliff supports explicit ranges and a changelog-only replay without inventing a tag; the action is a thin wrapper (`openspec/changes/add-release-automation/design.md`, "Changelog + bump engine") |
| What gets versioned | Root `package.json` only, `--workspaces=false` (`release.yml:272`) | Per-workspace versioning | All packages ship in one installer, so only the root version is externally meaningful (`add-release-automation/design.md`, Non-Goals and "Version bump application") |
| Push identity on protected `main` | GitHub App installation token with ruleset bypass (`release.yml:59-64`) | `GITHUB_TOKEN`, personal PAT, auto-merge version-bump PR | `GITHUB_TOKEN` pushes do not trigger workflows; a PAT ties the release to a human; a PR round-trip adds latency without removing risk (`add-release-automation/design.md`, "Protected-branch push identity") |
| AI summary mechanism | `anthropics/claude-code-action` with OAuth token, `Read,Write` tools only, `continue-on-error` | Hand-rolled Messages API script | Subscription billing via OAuth outweighed the heavier harness (`add-release-automation/design.md`, "AI summary") |
| Release visibility | Draft only, created after all platform builds (`publish-release/action.yml:22-32`) | Auto-publish | A human must approve before a release is public (`add-release-automation/design.md`, "Draft-only publication") |
| Where packaging runs for a release | `package` matrix inside `release.yml`, steps shared via composite actions | Reusable workflow; `package.yml` tag-triggered publish (the original design) | Avoids a skipped doc-only filter job in release runs (`release.yml:319-321`); the matrix duplication is the cost |
| Bump-mode `to` | Must equal main's tip (`release.yml:101-107`) | Any ref, as the spec allows | The tag must describe the commit the changelog was built against (`release.yml:104`) |
| Who publishes installers | `softprops/action-gh-release`; electron-builder runs `--publish never` | electron-builder `--publish always` | Keeps one publishing path even though `GH_TOKEN` is present in CI (`electron-builder.yml:10-14`) |
| Boot-time update check | Opt-in via `enableAutoUpdate`, default off, lazy import (`updater.ts:63-80`) | Always-on check | First launch must produce zero update-feed traffic (`auto-update-scaffold` spec, "Updater is wired but inert by default"; doc comment `updater.ts:63-73`) |
| Download and install | Explicit operator actions only; `autoDownload` / `autoInstallOnAppQuit` pinned `false` (`updater.ts:22-28`) | electron-updater defaults (both `true`) | A detected update must never download or install itself (`add-user-initiated-update-install/design.md`, "Explicit action only") |
| Recovering from a release without a feed | One retry against the newest feed-bearing release via the generic provider, original error surfaced on failure (`updater.ts:40-61`) | Fail outright; authenticated API lookup | A release shipped without `latest.yml` otherwise 404s every check; unauthenticated 60 req/hr suffices because it runs only on failure (`add-update-feed-fallback/design.md`, Decisions) |
| Download progress transport | Self-bridged side-channel stream with `streamId` ack (`iac-settings.controller.ts:291-310`) | Plain invoke with no progress; polling | Reuses the existing `iac.stack.initialize` stream pattern (`add-user-initiated-update-install/design.md`, "Progress reuses the existing side-channel stream pattern") |
| Missing cached check before download | Re-check once when the rejection text is `'Please check update first'` (`updater.ts:214-221`) | Track check state in the app | Avoids a dead end when the app restarted between check and click (`add-user-initiated-update-install/design.md`, "No prior check in this process"); matching by message text rather than state is `[inferred]` to be the simplest available signal |
| Placement of the update channels | `IacSettingsController` under `iac.settings.autoUpdate.*` | A dedicated updater controller and namespace | `[inferred]` grown from the existing Settings controller; `autoUpdateSetting.ts:1-9` itself notes the flag is not a `DeploymentConfig` field |
| Packaged runtime closure | Hand-maintained `node_modules` globs (`electron-builder.yml:20-216`) | Bundling the packages; generated list | Bundling `@pulumi/*` risks an Electron-never-quits failure via `@grpc/grpc-js` (`electron-builder.yml:22-28`); hand maintenance over generation is `[inferred]` |

## Open Questions & Future Decisions

### Resolved

1. ✅ git-cliff over release-please / semantic-release, for explicit ranges and replay (`add-release-automation/design.md`).
2. ✅ GitHub App token over `GITHUB_TOKEN` / PAT / auto-merge PR for the protected-branch push (`add-release-automation/design.md`).
3. ✅ Fallback feed via the generic provider, original error wins, primary feed restored (`add-update-feed-fallback/design.md`).
4. ✅ Download and install are explicit operator actions; a downloaded-but-not-installed update is discarded at quit (`add-user-initiated-update-install/design.md`).
5. ✅ Unsigned macOS download failures surface as ordinary failures with the "Download manually" link, no special handling (`add-user-initiated-update-install/design.md`).

### Deferred

1. Should `auto-update-scaffold` drop or narrow "Update-check telemetry is gated by the same flag" (`openspec/specs/auto-update-scaffold/spec.md:29-37`) so it agrees with the on-demand check requirement (`:86-90`) and with `updater.ts:122-127`? EARS cannot be written against both.
2. When will `add-user-initiated-update-install` be synced into `openspec/specs/auto-update-scaffold/spec.md`, and the three shipped changes archived? The main spec currently omits download and install entirely, and re-applying `add-release-automation` would regress main.
3. Should `installDownloadedUpdate` (`updater.ts:242-256`) refuse when no download completed, or should the `UpdateInstallResult` doc (`autoUpdateSetting.ts:86-91`) stop promising that failure case? What does `quitAndInstall` do with nothing downloaded (`[unverified]`)?
4. Should `publish-release` verify assets before creating the draft, or delete the draft on verification failure (`publish-release/action.yml:22-61`)?
5. Should `release-automation` be updated to state the main-tip rule for explicit `to` (`release.yml:101-107`) and the always-summary-plus-`<details>` body shape (`release.yml:205-226`)?
6. Should the `add-release-automation` design's stale statements (model `claude-opus-5` versus `claude-sonnet-5-5` at `release.yml:181`; `package.yml` tag-triggered publish and softprops upsert versus `release.yml:299-386`) be corrected when the change is archived?
7. Can the release repo identity come from one source instead of four (`electron-builder.yml:16-18`, `updater-fallback.ts:5`, `:8`, `settings.page.tsx:79`)?
8. Can the packaging matrix be extracted so `release.yml:325-354` and `package.yml` cannot drift?
9. Should the `@tailwindcss/oxide@4.3.0` reinstall (`build-package/action.yml:18`) read its version from the lockfile, which resolves `4.3.3`?
10. Can the "no prior check" retry key off updater state rather than the literal `'Please check update first'` (`updater.ts:172`, `:217`)?
11. Should the fallback lookup paginate or widen beyond `per_page=10` (`updater-fallback.ts:10`)?
12. Should the auto-update channels move to their own controller and namespace (`iac-settings.controller.ts:228-320`), and should the chunk/end channel constants stop being declared in both the controller (`:35-38`) and preload (`preload.ts:156-160`)?
13. Should workspace manifests track the released version, or should the bump commit stop staging `package-lock.json` to match the spec's "only that change" wording (`release.yml:272-273`)?
14. Can a script or test verify that `electron-builder.yml:20-216` covers the externalized packages' runtime closure?
15. Should the plan-history wording at `electron-builder.yml:239-240` ("A later group's GuidedIamService") be dropped under the repo's comment rules?
16. Is it intended that, with `enableAutoUpdate` on, `initUpdater`'s persistent `error` listener (`updater.ts:84-88`) also logs every later manual-check and download failure?

## References

- Arrow doc: `docs/arrows/operator-app/app-update-and-release.md`
- EARS specs (not yet written): `docs/intent/operator-app/app-update-and-release/app-update-and-release-specs.md`
- OpenSpec: `openspec/specs/auto-update-scaffold/spec.md`, `openspec/specs/release-automation/spec.md`, `openspec/specs/install-and-signing-docs/spec.md`
- OpenSpec changes (shipped, unarchived): `openspec/changes/add-release-automation/`, `openspec/changes/add-update-feed-fallback/`, `openspec/changes/add-user-initiated-update-install/` (unsynced)
- Docs: `docs/docs/app/settings.md`, `docs/docs/install.md`, `docs/docs/code-signing-roadmap.md`, `docs/docs/guides/maintainer.md`, `docs/docs/components/management-app.md`
- Neighbouring leaf designs: `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/iac/engine/engine-design.md`
