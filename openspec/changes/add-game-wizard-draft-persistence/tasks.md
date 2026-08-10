## 1. Storage layer

- [x] 1.1 Add `addGameWizardDraft: { draft: WizardDraft; stepIndex: number; savedAt: string } | null` to `AppStoreSchema` in `app/packages/desktop-main/src/services/ElectronStoreService.ts` (default `null`).
- [x] 1.2 Create `GameWizardDraftService` (`app/packages/desktop-main/src/services/GameWizardDraftService.ts`) with `get()`, `save(draft, stepIndex)`, `clear()`, delegating to `ElectronStoreService`. `get()` degrades to `null` and logs a warning on any read/shape failure instead of throwing.
- [x] 1.3 Write `GameWizardDraftService.test.ts` covering save/get/clear round-trip and corrupt/unexpected-shape read degrading to `null`, following `FirstRunWizardService.test.ts`'s mocking conventions.

## 2. IPC surface

- [x] 2.1 Add `games.draft.get`, `games.draft.save`, `games.draft.clear` `@MessagePattern` handlers to `GamesController` (`app/packages/desktop-main/src/controllers/games.controller.ts`), each starting with an entry `logger.debug` line per `.claude/rules/logging.md`, delegating to `GameWizardDraftService`.
- [x] 2.2 Extend the preload bridge (desktop-preload IPC surface / typed `window.hyveon.games` API) with `draft.get`/`draft.save`/`draft.clear`, following existing naming conventions (`preload-bridge-naming`).
- [x] 2.3 Write/extend `games.controller.test.ts` covering the three new handlers (success + degraded-read passthrough).

## 3. Renderer API wrappers

- [x] 3.1 Add `getGameDraft()`, `saveGameDraft(draft, stepIndex)`, `clearGameDraft()` to `app/packages/web/src/api.service.ts`, calling `hyveon().games.draft.*`.

## 4. Add-game wizard autosave

- [x] 4.1 In `AddGameWizard` (`add-game-wizard.component.tsx`), add a debounced (1000ms idle) `useEffect` on `draft`/`stepIndex` that calls `api.saveGameDraft(...)`, skipped when `draft` equals `createEmptyWizardDraft()` or while `submitting` is true.
- [x] 4.2 Flush any pending debounced save immediately on `handleOpenChange(false)` and on component unmount, before `resetWizard()` runs.
- [x] 4.3 Call `api.clearGameDraft()` on successful `handleSubmit()`, before the dialog closes.
- [x] 4.4 Accept an optional `initialDraft`/`initialStepIndex` (props or an imperative open-with-draft mechanism) so `GamesPage` can open the dialog pre-populated from a resumed draft.
- [x] 4.5 Extend `add-game-wizard.component.test.tsx` (fake timers) to cover: debounced save fires on field change, immediate flush on close, no autosave for an empty/untouched draft, no autosave while submitting, `clearGameDraft` called on successful submit, dialog opens pre-populated when given an initial draft.

## 5. Games page resume/discard banner

- [x] 5.1 On `GamesPage` mount, call `api.getGameDraft()`; if non-null, render a banner ("Unfinished draft: `<name or 'untitled'>` — Resume / Discard") following the visual/dismissal pattern of `pending-changes-banner.component.tsx`, without auto-opening the wizard.
- [x] 5.2 Wire "Resume" to open `AddGameWizard` with the saved `draft`/`stepIndex`.
- [x] 5.3 Wire "Discard" to call `api.clearGameDraft()` and hide the banner immediately, without opening the wizard.
- [x] 5.4 Add/extend `games.page` component tests: banner renders only when a draft exists, Resume opens the wizard pre-filled, Discard clears the draft and hides the banner, no banner when no draft exists.

## 6. Documentation

- [x] 6.1 Use the `write-docs` skill to update the games/add-game-wizard page under `docs/docs/app/` describing draft autosave and the resume/discard banner.

## 7. Verification

- [ ] 7.1 Run `npm run app:lint`, `npm run app:typecheck`, and `npm run app:test`; confirm all pass before opening the PR.
