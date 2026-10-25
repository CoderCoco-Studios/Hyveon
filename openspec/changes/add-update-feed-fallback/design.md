## Context

`updater.ts` previously called `checkForUpdates()` directly in two places (`initUpdater`, `checkForUpdatesNow`) with duplicated setup. The GitHub provider resolves only the latest published release, so one release without `latest.yml` breaks every check. Prevention in the release workflow landed separately (#664, #665); this change adds client-side recovery.

## Goals / Non-Goals

**Goals:**
- Recover automatically from a latest release that lacks the platform feed file.
- Give operators a manual path when recovery fails.

**Non-Goals:**
- No automatic download or install; `autoDownload` and `autoInstallOnAppQuit` stay `false`.
- No GitHub authentication, no new IPC channel, no change to `ManualUpdateCheckResult`.

## Decisions

- **Resolver in its own module.** `updater-fallback.ts` holds a pure `pickFallbackRelease(releases, platform)` and `resolveFallbackFeedUrl(platform)` using native `fetch` against `GET /repos/CoderCoco-Studios/Hyveon/releases?per_page=10` (unauthenticated; 60 req/hr/IP is ample because it runs only on failure). Owner/repo is a single constant.
- **Retry via the generic provider.** `autoUpdater.setFeedURL({ provider: 'generic', url: <releases/download/tag> })`, then one more `checkForUpdates()`.
- **Original error wins.** If resolution finds nothing or the retry fails, the primary error is rethrown so the operator sees the real cause.
- **Errors decided by the call result, not the first `error` event.** `checkForUpdatesNow` keeps one-shot `update-available` / `update-not-available` listeners but resolves failures from the rejection of the check-with-fallback call, so the primary failure's `error` event cannot resolve before the retry.
- **Shared helpers.** `loadAutoUpdater()` (the `.default` import, logger, and the two `false` pins) and `checkWithFallback()` are used by both entry points.

## Risks / Trade-offs

- The fallback feed stays set on the singleton for the process lifetime; later checks in the same session use it. Acceptable: it points at a known-good release and the next app launch starts from the default provider.
- Unauthenticated API rate limit; failure to fetch simply yields the original error.
