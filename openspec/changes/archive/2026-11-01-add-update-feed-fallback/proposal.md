## Why

electron-updater's GitHub provider checks only the single latest published release. v0.7.0 shipped with no assets, so `latest.yml` returned 404 and every update check failed with no recovery: the log recorded the error and the Settings "Check Now" row showed the raw message with no next step. Installed clients should recover by looking at older releases, and failures should point operators at the manual download.

## What Changes

**Update check failure handling**
- From: a failed `checkForUpdates()` is logged (automatic check) or returned as `{ ok: false, message }` (manual check) and nothing else happens.
- To: on failure the updater queries the GitHub releases API for the newest non-draft, non-prerelease release that carries the platform's feed file (`latest.yml` / `latest-mac.yml` / `latest-linux.yml`), points the generic provider at that release's download URL, and retries once. If no such release exists or the retry fails, the ORIGINAL error is surfaced.
- Reason: a single bad release must not strand every installed client.
- Impact: non-breaking. The updater still never downloads or installs (`autoDownload` and `autoInstallOnAppQuit` stay `false`).

**Settings "Check Now" failure state**
- From: failure shows only the error text.
- To: failure also shows a "Download manually" link to the GitHub Releases page.
- Impact: renderer-only; no new IPC channel and no change to `ManualUpdateCheckResult`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `auto-update-scaffold`: adds the fallback-feed retry and the manual-download link on failure.

## Impact

- `app/packages/desktop-main/src/updater.ts`, new `updater-fallback.ts`.
- `app/packages/web/src/pages/settings.page.tsx`.
- `docs/docs/app/settings.md`, `docs/docs/components/management-app.md`.
- Clients without this code cannot self-heal; one manual update is needed.
