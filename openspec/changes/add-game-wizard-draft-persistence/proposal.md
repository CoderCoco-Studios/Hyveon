## Why

The add-game wizard (`app/packages/web/src/components/add-game-wizard/`) holds
its entire in-progress `WizardDraft` in local React state and discards it on
any dialog close (Escape, overlay click, successful submit) or in-app
navigation away from `/games`, and loses it entirely if the Electron app is
closed. Operators filling out the 6-step wizard have no way to recover partial
progress after any of these, forcing a full re-entry of every field. This
change adds durable, main-process-backed draft persistence so an in-progress
add-game draft survives an app restart, with an explicit resume/discard
affordance on the games list.

## What Changes

**Draft persistence for the add-game wizard**
- From: `WizardDraft` state lives only in `AddGameWizard`'s React state and is
  wiped by `resetWizard()` on every dialog close, with no recovery path.
- To: the wizard autosaves the current `WizardDraft` + step index to a new
  durable main-process store (debounced ~1s after each edit, flushed
  immediately on dialog close), and the `/games` page shows a
  "Unfinished draft — Resume / Discard" banner whenever a saved draft exists.
- Reason: prevent lost operator work from an accidental close, misclick, or
  app restart mid-wizard.
- Impact: non-breaking, additive. New IPC channels, one new desktop-main
  service, changes to `AddGameWizard` and `GamesPage`. The edit-game form is
  explicitly out of scope — it is pre-seeded from a live config, so an
  abandoned edit is cheap to redo and gets no new persistence behavior.

## Capabilities

### New Capabilities
- `game-draft-persistence`: durable save/resume/discard of an in-progress
  add-game wizard draft (`WizardDraft` + step index) across app restarts,
  including the storage layer, IPC surface, autosave behavior, and the
  resume/discard banner on the games list.

### Modified Capabilities
<!-- none: no existing spec's requirements change -->

## Impact

- **Affected code**:
  - `app/packages/desktop-main/src/services/` — new `GameWizardDraftService`.
  - `app/packages/desktop-main/src/services/ElectronStoreService.ts` — new
    `addGameWizardDraft` schema key.
  - `app/packages/desktop-main/src/controllers/games.controller.ts` — new
    `games.draft.get` / `games.draft.save` / `games.draft.clear`
    `@MessagePattern` handlers.
  - `app/packages/web/src/api.service.ts` — new `getGameDraft` /
    `saveGameDraft` / `clearGameDraft` wrappers.
  - `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx`
    — debounced autosave effect, flush-on-close, clear-on-submit, accepts an
    initial draft/step to resume into.
  - `app/packages/web/src/pages/games.page.tsx` — reads the saved draft on
    mount, renders the Resume/Discard banner.
- **No changes** to `edit-game-form.component.tsx`, `DeploymentConfigService`,
  or the final `games.create` write path (`deployment-config.json` in S3).
- **Dependencies**: none new — reuses the existing `electron-store`-backed
  `ElectronStoreService` and the existing NestJS `@MessagePattern` IPC
  convention.
