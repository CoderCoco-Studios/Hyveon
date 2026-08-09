## Context

`GameServer.environment` (`app/packages/shared/src/gameServerConfig.ts:112`)
is an optional `GameServerEnvironmentVariable[]` (`{ name, value }`) that
already flows fully through the backend write path
(`CreateGamePayload`/`UpdateGamePayload` in `api.service.ts` →
`GamesWriteService` → `validateGameServer` → `gameServerSchema` in
`gameServerValidator.ts`) and is already rendered read-only on
`game-detail.page.tsx`. The gap is UI-only: neither the add-game wizard nor
the edit-game form exposes a way to create or edit these rows, and
`edit-game-form.component.tsx` currently carries an existing game's
`environment` value through unmodified on every save because the shared
`WizardDraft` it's built from never modeled the field.

This is a close structural analog of a change already shipped in this
codebase: `game-https-configuration` added the `https` flag to both flows
plus a validator rule. This design follows the same shape, and is also a
close analog of the existing `volumes`/`file_seeds` dynamic-list editors
already built into the wizard's Storage step
(`storage-step.component.tsx`) — env vars are a third instance of the same
"optional list of rows with Add/Remove" UI pattern.

## Goals / Non-Goals

**Goals:**
- Let an operator declare, edit, and remove environment variables for a
  game server from both the add-game wizard and the edit-game form.
- Reject structurally invalid rows (empty name, duplicate name within one
  entry) client-side and server-side, using one shared rule.
- Reuse the existing `WizardDraft`/step-component/validation architecture
  exactly — no new architectural pattern introduced.

**Non-Goals:**
- No backend, IPC, or payload-shape changes — `environment` already
  round-trips end-to-end.
- No env var name charset/casing enforcement (e.g. requiring `A-Z0-9_`) —
  left permissive since container images vary too much to assume a
  universal convention.
- No secret-masking/redaction treatment for values — matches the existing
  read-only display on `game-detail.page.tsx`, which already shows values
  in plain text; this change doesn't introduce a new exposure, just a new
  write path for the same already-visible data.
- No change to how `file_seeds`/`volumes` are validated or rendered.

## Decisions

### D1: New "Environment" wizard step, not folded into Storage

- **Choice**: Add a sixth wizard step, "Environment," positioned between
  Storage and Review: Identity → Resources → Networking → Storage →
  Environment → Review.
- **Rationale**: Storage already bundles two distinct dynamic-list concepts
  (`volumes`, required min-1; `file_seeds`, optional). Adding env vars as a
  third list there would overload one step with three unrelated concerns.
  A dedicated step keeps `STEP_LABELS`, `stepForIssuePath` routing, and the
  review summary each mapped to one clear concept, matching how `https`
  got its own place in the Networking step rather than being bolted onto
  an unrelated step.
- **Alternatives considered**: Folding into Storage as a third list —
  rejected because it doesn't reduce total UI complexity (same number of
  rows/inputs either way), only step *count*, and step count isn't the
  scarce resource here — step *clarity* is.

### D2: Validation — non-empty name + no duplicate names, no charset rule

- **Choice**: New `checkEnvironmentVariables(entry)` in
  `gameServerValidator.ts`, structured like `checkAbsolutePaths`: for each
  `environment[N]`, reject an empty `name`; reject a `name` that duplicates
  an earlier row's `name` within the same entry. No format/charset
  constraint on `name` itself.
- **Rationale**: An empty or duplicate name is never a valid container env
  var declaration under any image's convention, so it's safe to reject
  universally (matches `volumes[].name`'s existing non-empty rule). A
  charset rule would be guessing at a convention that doesn't hold
  universally across game server images.
- **Alternatives considered**: Non-empty only, duplicates allowed (matches
  real container semantics — last value silently wins) — rejected because a
  duplicate is virtually always an operator mistake worth surfacing rather
  than silently accepting; "no new validation at all" — rejected because
  the existing schema's total permissiveness (empty name allowed) would
  carry a known-bad case straight into a live container declaration.

### D3: `WizardDraft` gains a real `environment` field; edit-form carry-forward hack is deleted

- **Choice**: Add `environment: WizardDraftEnvironmentVariable[]` to
  `WizardDraft`, wired through `createEmptyWizardDraft`,
  `draftFromGameServer`, `draftToPayload`, `toProposedEntry`, and
  `stepForIssuePath`. Delete the `environment: game.environment`
  passthrough (and its explanatory comment) in
  `edit-game-form.component.tsx`.
- **Rationale**: The passthrough exists solely because the draft never
  modeled this field; once it does, the special case has no reason to
  exist and would silently mask a real bug (edits not being saved) if left
  in place.
- **Alternatives considered**: Leaving the wizard's `environment` field
  create-only (add wizard gets it, edit form keeps the carry-forward) —
  rejected; the operator's original ask was explicitly "if not [settable
  after creation], we need to be able to set env vars," so edit-time
  support is required, not optional.

## Risks / Trade-offs

- [Risk] A game with a very large number of pre-existing env vars (hand-
  edited into `deployment-config.json` before this change existed) could
  render an unwieldy row list when opened in the edit form for the first
  time. → Mitigation: none needed structurally — this is the same shape
  `volumes`/`file_seeds` already handle with no reported issue at any
  observed scale; if it becomes a problem, it's a shared UI concern across
  all three lists, not specific to this change.
- [Trade-off] No charset/casing validation on `name` means an operator can
  save a value the underlying container image will silently ignore (e.g. a
  typo'd variable name). → Accepted: matches this change's Non-Goal of not
  guessing at an image-specific convention; the same trade-off already
  exists for `volumes[].name` and `file_seeds[].path`.
- [Trade-off] Plain-text values, no masking. → Accepted: this is not a new
  exposure — `game-detail.page.tsx` already renders these values in plain
  text today; this change only adds a write path for already-visible data.

## Migration Plan

N/A — this change involves no deployment, data, or schema-migration
changes. `environment` is already an optional field on the existing
`GameServer` type and `deployment-config.json` shape; games declared before
this change (with `environment` unset or already populated) continue to
parse and validate unchanged. No feature flag needed — this is additive UI
plus a stricter (but backward-compatible for existing valid data) shared
validation rule.

## Open Questions

None — all decisions were resolved during brainstorming and confirmed by
the user.
