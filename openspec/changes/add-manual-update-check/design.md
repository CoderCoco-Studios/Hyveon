## Context

`updater.ts`'s `initUpdater` only calls `checkForUpdates` when
`enableAutoUpdate` is true, and only once at boot. `electron-updater`'s
`checkForUpdates()` promise resolves with feed metadata regardless of
whether a newer version exists — availability is signaled via the
`update-available` / `update-not-available` events, not the return value. See
proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- A manual check callable at any time, independent of `enableAutoUpdate`.
- Reuse the same `autoUpdater` singleton and stay within the existing
  "detect, never install" restriction.

**Non-Goals:**
- Download or install an update (future increment).
- Change `initUpdater`'s boot-time behavior.

## Decisions

- **One-shot event race, not the `checkForUpdates()` return value.**
  `checkForUpdatesNow()` registers one-time listeners for
  `update-available` / `update-not-available` / `error`, calls
  `checkForUpdates()`, resolves from whichever event fires first, then
  removes all three listeners. Alternative considered: trust the promise
  return value — rejected because it doesn't carry an available/not-available
  signal, only the feed's latest metadata.
- **`autoDownload`/`autoInstallOnAppQuit` set on every manual call.** Cheap
  and idempotent; keeps the manual path safe even if it's ever called before
  `initUpdater` runs (e.g. `enableAutoUpdate` is off, so `initUpdater` never
  touches `autoUpdater` at all).
- **Listeners are call-scoped, not shared with `initUpdater`'s persistent
  listeners.** Avoids a manual check's one-shot handlers firing on a later,
  unrelated auto-check event, and vice versa.

## Risks / Trade-offs

- [Concurrent manual + auto checks race on the same `autoUpdater` singleton
  and could cross-fire events] → acceptable for v1: `electron-updater`
  serializes internally, and a stray extra log line is the worst case. Not
  addressed here.
