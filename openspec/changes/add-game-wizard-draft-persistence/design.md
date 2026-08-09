## Context

The add-game wizard (`app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx`)
holds its entire in-progress `WizardDraft` (`wizard-form.utils.ts`) in local
React `useState`. `resetWizard()` runs on every dialog close — Escape, overlay
click, the trigger button, or a successful submit — and implicitly on any
in-app navigation away from `/games` while the dialog is open, since
`HashRouter` unmounts `GamesPage` and `AddGameWizard` with it. Closing the
Electron app entirely loses the same in-memory state. There is currently no
recovery path.

The edit-game form (`edit-game-form.component.tsx`) reuses the same
`WizardDraft` type and step components but is pre-seeded from a real,
already-persisted `GameServer` — an abandoned edit is cheap to redo, so it is
explicitly out of scope for this change.

Two existing persistence patterns inform this design:
- `pending-changes-banner.component.tsx` — the only browser-storage use in
  `@hyveon/web` (`sessionStorage`), survives navigation/reload but not a full
  app quit.
- `FirstRunWizardService` + `ElectronStoreService` — the first-run wizard's
  durable, main-process, restart-surviving pattern: a resumable step pointer
  and full field answers, persisted via `electron-store`, exposed over IPC,
  degrading to a safe default on any corrupt/missing state rather than
  blocking the operator.

## Goals / Non-Goals

**Goals:**
- An in-progress add-game wizard draft survives closing and relaunching the
  whole Electron app, not just in-session navigation.
- Resuming a draft is always an explicit operator action (a banner with
  Resume/Discard on `/games`), never automatic.
- At most the last ~1 second of typing is lost in the worst case; no whole
  step of work is lost.
- No behavior change to the edit-game form or to the final `games.create`
  write path.

**Non-Goals:**
- Draft persistence for the edit-game form.
- Multiple concurrent drafts — only one add-game wizard can be open at a
  time, so a single draft slot is sufficient.
- Reconciling a resumed draft against concurrent changes made to the live
  deployment config through another path while the draft sat unfinished
  (existing `games.create` validation, e.g. duplicate-name checks, already
  runs at submit time and covers this).

## Decisions

### D1: Durability level — main-process store, not renderer `sessionStorage`

- **Choice**: persist the draft in the desktop-main process via
  `ElectronStoreService`, reachable only through IPC.
- **Rationale**: the operator's stated requirement is surviving a full app
  close/reopen, which renderer-only `sessionStorage`/`localStorage` cannot do
  (both are scoped to the renderer's lifetime/profile and `@hyveon/web` uses
  neither for anything durable today).
- **Alternatives considered**: `sessionStorage` (rejected — doesn't survive
  app quit); a new bespoke JSON file under `userData/` mirroring
  `FirstRunWizardService`/`wizard-state.json` exactly (rejected in favor of
  D2 below — `ElectronStoreService` already solves this problem class).

### D2: Storage mechanism — `ElectronStoreService`, not a new JSON file

- **Choice**: add one new schema key, `addGameWizardDraft: { draft:
  WizardDraft, stepIndex: number, savedAt: string } | null`, to
  `ElectronStoreService`'s existing `AppStoreSchema`.
- **Rationale**: `ElectronStoreService` already provides typed read/write,
  an in-memory fallback outside Electron (test-friendly), and is the store
  the first-run wizard already uses for full field-answer persistence (as
  opposed to `FirstRunWizardService`'s separate file, which only tracks a
  step pointer). Reusing it avoids introducing a second file-based
  persistence mechanism for the same class of problem.
- **Alternatives considered**: a dedicated `userData/add-game-wizard-draft.json`
  file via raw `fs/promises`, matching `FirstRunWizardService` exactly —
  workable, but duplicates infrastructure `ElectronStoreService` already
  provides for no added benefit.

### D3: Scope — add-game wizard only

- **Choice**: only `AddGameWizard` gets draft persistence; `edit-game-form`
  is untouched.
- **Rationale**: new-game creation is the higher-stakes loss (up to 6 steps
  of from-scratch input with nothing to fall back on). An in-progress edit
  is recoverable for free by re-opening the edit form, which re-seeds from
  the live `GameServer`.
- **Alternatives considered**: covering both — rejected as unnecessary scope;
  would also require per-game-name draft keys and reconciliation against a
  config that may have changed elsewhere mid-edit, with no clear operator
  benefit to justify the complexity.

### D4: Resume UX — explicit banner, not auto-reopen

- **Choice**: `GamesPage` renders a dismiss-resistant "Unfinished draft:
  `<name>` — Resume / Discard" banner (visually following
  `pending-changes-banner`'s pattern) whenever a saved draft exists on mount.
  It does not auto-open the wizard.
- **Rationale**: automatically reopening a dialog on every visit to `/games`
  until the operator resolves it was judged too surprising/intrusive.
  Explicit opt-in matches how `pending-changes-banner` already handles a
  similar "something needs your attention" case.
- **Alternatives considered**: auto-reopen the wizard dialog on `/games`
  mount whenever a draft exists — rejected for being intrusive on every
  visit until dismissed.

### D5: Save trigger — debounced autosave, not save-on-step-change only

- **Choice**: a `useEffect` in `AddGameWizard` debounces (1000ms idle) saves
  on every `draft`/`stepIndex` change, calling `api.saveGameDraft(...)` via
  IPC. An immediate flush (bypassing the debounce) fires on dialog close and
  component unmount so the last pending edit isn't dropped.
- **Rationale**: chosen over "save only on Next/Back + close" because the
  operator explicitly wanted stronger guarantees than "lose at most one
  step's worth of typing" — debounced autosave loses at most ~1s of typing
  even mid-step, at the cost of somewhat more frequent IPC/disk writes,
  which is acceptable given the draft blob is small (one `WizardDraft`).
- **Alternatives considered**: save on step transition + dialog close only
  (simpler, fewer writes, but reintroduces "lose the current step's
  in-progress typing" as a residual gap) — rejected per the operator's Q4
  answer in brainstorming.

## Risks / Trade-offs

- [Risk] A corrupted or unexpectedly-shaped `addGameWizardDraft` entry (e.g.
  after an app update changes `WizardDraft`'s shape) could throw when read.
  → Mitigation: `GameWizardDraftService.get()` degrades to `null` on any
  read/parse failure, exactly like `FirstRunWizardService`'s corrupt-file
  handling — a bad draft is equivalent to no draft, never blocks `/games`.
- [Risk] Frequent debounced writes could race with a slow disk or many rapid
  edits. → Mitigation: standard idle-debounce (1s) collapses bursts into one
  write; `save()` failures are logged and swallowed rather than retried
  aggressively, since losing one autosave cycle just means the *next*
  successful save (or the flush-on-close) catches up.
- [Trade-off] The draft may contain values the operator later considers
  sensitive (e.g. environment variables under the environment step) sitting
  at rest in `electron-store` while unfinished → accepted: this is the same
  storage/at-rest posture as the first-run wizard's own field answers in the
  same store, and no worse than the eventual `deployment-config.json` write,
  which also isn't field-level encrypted.
- [Trade-off] Only one draft slot exists; starting a second add-game draft
  before resolving the first silently overwrites it → accepted per D3/Goals
  scope (only one wizard instance can be open at a time in the UI today, so
  this can only happen via Discard-then-restart, which is an intentional
  operator action).

## Migration Plan

N/A — this change involves no deployment changes. It adds one new
`ElectronStoreService` schema key (additive, no migration of existing keys),
three new IPC handlers, and renderer-side changes to two existing
components. No existing data (deployment config, other electron-store keys)
is altered or needs backfilling. Rollback is a plain revert — the new schema
key is simply never read/written if the change is reverted, with no cleanup
required for operators who used the feature in the interim (`electron-store`
tolerates unknown keys).

## Open Questions

None outstanding — D1 through D5 resolved every fork raised during
brainstorming.
