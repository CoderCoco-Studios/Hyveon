# Tasks: add-update-feed-fallback

## 1. Desktop main

- [x] 1.1 Add `updater-fallback.ts` with `pickFallbackRelease` and `resolveFallbackFeedUrl`.
- [x] 1.2 Extract `loadAutoUpdater` and `checkWithFallback` in `updater.ts`; use them from `initUpdater` and `checkForUpdatesNow`.
- [x] 1.3 Unit tests: `updater-fallback.test.ts`, extended `updater.test.ts`.

## 2. Settings page

- [x] 2.1 Render a "Download manually" link to the GitHub Releases page when the manual check fails.
- [x] 2.2 Component tests for link shown on failure and absent on success.

## 3. Docs

- [x] 3.1 Update `docs/docs/app/settings.md` Check Now section and `docs/docs/components/management-app.md`.
