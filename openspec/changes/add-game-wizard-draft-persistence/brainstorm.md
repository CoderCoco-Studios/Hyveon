<!--
Raw capture of superpowers:brainstorming output.

This file captures the brainstorming skill's output as-is, without enforcing
structure. The skill's natural output is usually a decision-log format
(context → decision chain Q1-Qn → design trade-offs), but the actual
organization may vary depending on the conversation.

design.md extracts from this file and reorganizes it into a structured
design document.

Do not copy this file's content into design.md — design.md is an
independently reorganized artifact; the two are complementary, not
overlapping.
-->

# Brainstorm: add-game wizard draft persistence

## Background

The operator raised: "When adding a game, there is no way as you progress the
form for a draft of it to be saved. Any click away or close of the app results
in lost progress."

## Project context gathered before questions

Explored via a research subagent over the Hyveon codebase (`app/packages/web`,
`app/packages/desktop-main`):

- **Wizard location**: `app/packages/web/src/components/add-game-wizard/`
  (`add-game-wizard.component.tsx` shell + one component per step: identity,
  resources, networking, storage, environment, review). Mounted as a Radix
  `<Dialog>` inside `/games` (`games.page.tsx`), not its own route.
- **State**: plain local `useState` in `AddGameWizard` — `draft: WizardDraft`
  (`wizard-form.utils.ts`), `stepIndex`, plus dialog/submission state. No
  reducer, no form library, no Context. `WizardDraft` is the single shape
  covering every field the wizard collects; `draftToPayload()`/
  `draftFromGameServer()` convert to/from the real `GameServer` config.
- **Loss today**: `resetWizard()` runs on every dialog close (Escape, overlay
  click, trigger, or successful submit) and implicitly on any in-app
  navigation away from `/games` while the dialog is open, since `HashRouter`
  unmounts `GamesPage` and `AddGameWizard` with it. Closing the whole Electron
  app loses the same in-memory state.
- **Submit path**: `handleSubmit()` → `api.createGame()` → IPC `games.create`
  → `GamesController` → `GamesWriteService.createGame()` → validates →
  `DeploymentConfigService.addGameServer()` → conditional S3 `PutObject` of
  `deployment-config.json`. No local-file fallback for the final config.
- **Existing persistence precedents**:
  - Renderer-only: `pending-changes-banner.component.tsx` uses
    `sessionStorage` (only browser-storage use in `@hyveon/web`; no
    `localStorage` anywhere). Survives navigation/reload, not a full app quit.
  - Main-process durable: `FirstRunWizardService` persists the first-run
    wizard's current step to `userData/wizard-state.json` (plain
    `fs/promises`, degrades to `DEFAULT_PROGRESS` on any corrupt/missing
    file), and `ElectronStoreService` (typed `electron-store` wrapper, with
    an in-memory fallback outside Electron and transparent secret-field
    encryption via `SafeStorageService`) holds the first-run wizard's actual
    field answers. Exposed via `wizard.progress.get/save` and
    `wizard.state.get/save` on `WizardController`. This is the closest analog
    to "full answers survive app restart."
- **Edit-game form** (`edit-game-form.component.tsx`) reuses the same
  `WizardDraft`/step components but is pre-seeded from a real, already-saved
  `GameServer` — flagged as lower-stakes to lose than a from-scratch add.
- No existing `beforeunload`/unsaved-changes guard anywhere in `@hyveon/web`.

## Decision chain

**Q1: Which loss scenario matters most — in-app dialog close/nav only, or
full app close/reopen too?**
→ **Full durability.** Draft must survive quitting and relaunching the whole
Electron app, not just in-session navigation. This rules out a
renderer-only `sessionStorage` approach and points at main-process
persistence (mirroring `FirstRunWizardService`'s durable-state pattern).

**Q2: Does this cover just the add-game wizard, or also the edit-game form
(same `WizardDraft` type)?**
→ **Add-wizard only.** New-game creation is the higher-stakes loss (up to 6
steps of from-scratch input). Edit form starts pre-seeded from the live
config, so an abandoned edit is cheap to redo — out of scope, no behavior
change there.

**Q3: How does the operator get back into a saved draft?**
→ **Explicit banner/prompt on `/games`**, mirroring the existing
`pending-changes-banner` pattern: "Unfinished draft: `<name>` — [Resume]
[Discard]". Rejected auto-reopening the wizard on every visit as too
surprising/intrusive until resolved. Resuming is always an opt-in operator
action, never automatic.

**Q4: When does the draft actually get written to disk?**
→ **Debounced autosave on every keystroke** (~1s idle after any field
change), rather than only on step transition/dialog close. Trades a bit more
IPC/disk-write frequency for effectively zero data loss, even mid-step —
picked over the coarser "save on step change + close" option since the
operator explicitly wanted stronger guarantees than "lose at most one step's
worth of typing."

## Resulting shape (informal, expanded into design.md)

- Storage: new key on `ElectronStoreService` (`addGameWizardDraft: { draft,
  stepIndex, savedAt } | null`) — reuses the store already built for durable
  "full answers" persistence rather than introducing a second file-based
  mechanism.
- IPC: `games.draft.get` / `games.draft.save` / `games.draft.clear` on
  `GamesController`, backed by a new small `GameWizardDraftService`
  (mirrors `FirstRunWizardService`'s read/degrade/write shape).
- Renderer: debounced (1s) autosave effect in `AddGameWizard`, with an
  immediate flush on dialog close/unmount to catch the last <1s of edits;
  `GamesPage` owns reading the draft on mount and rendering the
  Resume/Discard banner; successful submit or explicit Discard clears the
  stored draft.
- Error handling: corrupt/unreadable draft degrades to "no draft" (never
  blocks `/games`); save/clear failures are logged and swallowed — autosave
  is best-effort and shouldn't interrupt the operator with a toast.
- Testing: new `GameWizardDraftService` unit tests (mirroring
  `FirstRunWizardService.test.ts`), `GamesController` handler tests,
  `AddGameWizard` debounce/flush/clear-on-submit tests, `GamesPage`
  banner/resume/discard tests.

All four decision points converged with no unresolved TBDs; promoted
directly to `/opsx:propose` rather than continuing to iterate verbally.
