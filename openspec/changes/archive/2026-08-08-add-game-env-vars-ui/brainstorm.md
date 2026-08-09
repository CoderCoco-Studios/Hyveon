<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: Add environment-variable UI to add-game-wizard / edit-game-form

## Background

The operator asked: "In the add a game server [wizard], there is no way to
set environment variables. Is that something that needs to be done after
game server creation? If not we need to be able to set env vars."

Investigation before brainstorming started:

- `GameServer.environment` (`app/packages/shared/src/gameServerConfig.ts:112`)
  already exists as an optional `GameServerEnvironmentVariable[]`
  (`{ name: string; value: string }`), validated by
  `gameServerEnvironmentVariableSchema` in
  `app/packages/shared/src/gameServerValidator.ts:69` (currently just
  `{ name: z.string(), value: z.string() }` — no non-empty or dedupe rule).
- `game-detail.page.tsx:204-224` **displays** env vars read-only, only when
  already present in the declared config.
- `edit-game-form.component.tsx:141-145` carries the existing
  `game.environment` value through unchanged on every save, with a comment
  explaining the wizard's `WizardDraft` has no field for it.
- The add-game wizard (`add-game-wizard.component.tsx` + 5 step components:
  identity, resources, networking, storage, review) has **no** env-var step
  at all.
- Conclusion: there is genuinely no UI anywhere — wizard or edit form — to
  create or edit environment variables. Not a "do it after creation" gap;
  a real missing feature.
- Confirmed the backend needs zero changes: `CreateGamePayload`/
  `UpdateGamePayload` (`api.service.ts:51`) already carry
  `environment?: { name: string; value: string }[]`, and
  `GamesWriteService` → `validateGameServer` → `gameServerSchema` already
  accept/round-trip it. This is a pure UI + shared-validator change.

Explored the existing wizard pattern in depth by reading
`storage-step.component.tsx` (the closest analog — it already manages two
dynamic list types, `volumes` and `file_seeds`, with the exact add/remove/edit
UX an env-var list would need) and `wizard-form.utils.ts` (the `WizardDraft`
shape, `draftFromGameServer`/`draftToPayload` converters, `stepForIssuePath`
routing, and the `validateStep`/`validateXStep` family).

## Decision chain

**Q1: Where should the env-var editor live?**

Options presented:
- New "Environment" step (6th wizard step, same pattern as the `file_seeds`
  list) — clean separation, doesn't overload the Storage step's meaning.
- Fold into the existing Storage step as a third list alongside
  volumes/file_seeds — no new step, but Storage becomes a 3-concept step.

**Decision: new "Environment" step.** Inserted between Storage and Review:
Identity → Resources → Networking → Storage → Environment → Review.

**Q2: What validation should apply to env-var rows?**

Options presented:
- Non-empty name + no duplicate names within one entry (mirrors the
  `volumes` step's non-empty-name rule; new `checkEnvironmentVariables`
  business rule, same shape as `checkAbsolutePaths`).
- Non-empty name only, duplicates allowed (matches real container env-var
  semantics — last value silently wins).
- No new validation at all — ship the UI against the schema as-is.

**Decision: non-empty name + no duplicates.** Explicitly NOT enforcing any
name charset/casing convention (e.g. requiring `A-Z0-9_`) — left permissive
since container images vary too much to assume a universal pattern, and
container env vars technically accept any string key.

**Backend scope check (no question needed, verified directly):** Confirmed
`environment` already flows fully through the backend end-to-end
(`api.service.ts` payload types → `GamesWriteService` →
`validateGameServer` → `gameServerSchema`), so this change is UI + one
shared-validator rule only, no IPC/backend changes.

## Approved design (validated by user: "looks good")

**Architecture.** No new step *pattern* — replicates the existing
`file_seeds` sub-editor pattern (optional dynamic list, no minimum) as a
sixth wizard step, "Environment," between Storage and Review. Zero
backend/IPC changes.

**Changes:**

1. `wizard-form.utils.ts` — add `WizardDraftEnvironmentVariable
   { name: string; value: string }`; add `environment:
   WizardDraftEnvironmentVariable[]` to `WizardDraft`; wire through
   `createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`,
   `toProposedEntry`, `stepForIssuePath` (new `'environment'` step family);
   add `'environment'` to `WIZARD_STEPS`; add `validateEnvironmentStep`
   export mirroring `validateStorageStep`.
2. New `environment-step.component.tsx` — same row-list shape as the
   `file_seeds` half of `storage-step.component.tsx` (Add/Remove buttons,
   name+value `Input`s, `data-testid="env-row-{index}"`).
3. `add-game-wizard.component.tsx` — add the step to `STEP_LABELS`, render
   `<EnvironmentStep>` between Storage and Review.
4. `edit-game-form.component.tsx` — add an "Environment" `<Card>` section
   using the same component; delete the carry-forward hack
   (`environment: game.environment` passthrough + its comment) since it
   becomes a normal editable draft field, same as `https`.
5. `review-step.component.tsx` — add an "Environment variables" summary
   list (name/value pairs), same visual treatment as the existing Storage
   card's `file_seeds` sublist; omitted entirely when empty.
6. `gameServerValidator.ts` — new `checkEnvironmentVariables(entry)`
   business rule (same shape as `checkAbsolutePaths`): non-empty `name` per
   row, reject duplicate `name`s within the entry. Wired into
   `validateGameServer`'s success branch alongside the other post-parse
   checks.

**Data flow.** Identical to volumes/file_seeds: step component emits
`{ environment: [...] }` patches via `onChange`, wizard/edit-form's
`patchDraft` merges them into `WizardDraft` state, `validateStep`/
`validateWizardDraft` re-derives issues on every keystroke (including the
new duplicate/empty-name check), Submit/Save disabled while issues exist
for that step.

**Testing.** Following existing convention — add/extend specs for: row
add/remove/edit, empty-name rejection, duplicate-name rejection,
draft↔payload round-trip, edit-form no longer silently carrying forward
existing `environment`, and the review-step summary rendering.

**Scope note:** small, single-cohesive-unit change (one step + one
validator rule + wiring) — does not need a PR stack per
`.claude/rules/pr-stacking.md`, ships as one PR.
