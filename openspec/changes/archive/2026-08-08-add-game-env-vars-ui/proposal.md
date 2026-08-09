## Why

`GameServer.environment` already exists in the shared type/schema and flows
fully through the backend write path, and `game-detail.page.tsx` already
displays declared env vars read-only — but no UI anywhere lets an operator
create or edit them. Today the only way to set a game's environment
variables is a hand-edit of `deployment-config.json` in the operator's S3
config bucket, which is outside the app entirely. Many game server images
(e.g. Minecraft's `EULA=TRUE`) require at least one env var just to boot, so
this gap blocks operators from configuring a working server through the app.

## What Changes

**Add-game wizard**
- From: five steps (Identity, Resources, Networking, Storage, Review) with
  no way to declare environment variables.
- To: six steps, with a new "Environment" step between Storage and Review
  that lets the operator add/edit/remove `name`/`value` rows.
- Reason: env vars are a first-class part of a game server declaration
  (`GameServer.environment`) with no create-time UI.
- Impact: non-breaking addition; existing wizard flows for games with no env
  vars are unaffected (the step is optional, zero rows is valid).

**Edit-game form**
- From: silently carries the existing game's `environment` value forward
  unmodified on every save (`edit-game-form.component.tsx`'s carry-forward
  hack), because the shared `WizardDraft` this form is built from has no
  field for it.
- To: renders the same Environment step as an editable "Environment" card,
  same as the Storage card; saving reflects the operator's edits.
- Reason: the carry-forward hack exists purely because the wizard draft
  never modeled this field — extending the draft removes the special case.
- Impact: non-breaking; a game with existing env vars now shows and allows
  editing them instead of silently preserving an opaque value.

**Shared validator**
- From: `gameServerEnvironmentVariableSchema` accepts any string `name`,
  including empty, and does not reject duplicate names within one entry.
- To: a new `checkEnvironmentVariables` business rule (parallel to the
  existing `checkAbsolutePaths`) rejects an empty `name` per row and rejects
  duplicate `name`s within the same entry, run from `validateGameServer` on
  every write path (IPC and, transitively, the web UI).
- Reason: an env var with no name or a name that collides with another row
  in the same entry is never a valid container declaration.
- Impact: non-breaking for existing declared games (only new/edited entries
  are re-validated against the stricter rule on save).

## Capabilities

### New Capabilities
- `game-environment-variables`: operator-facing configuration of a game's
  container environment variables — the add-game wizard's Environment step,
  the edit-game form's Environment card, the review-step summary, and the
  validation rules (`checkEnvironmentVariables`) that govern a valid entry.
  Mirrors the existing `game-https-configuration` capability's shape for the
  `https` flag.

### Modified Capabilities

(none — `game-environment-variables` is a new capability; no existing
capability's requirements change)

## Impact

- **Affected code**: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`,
  new `environment-step.component.tsx`, `add-game-wizard.component.tsx`,
  `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx`,
  `review-step.component.tsx`, `app/packages/shared/src/gameServerValidator.ts`.
- **APIs**: none — `CreateGamePayload`/`UpdateGamePayload` already carry
  `environment`; no IPC channel or payload shape changes.
- **Dependencies**: none added.
- **Systems**: web renderer only; no desktop-main, Lambda, or infra changes.
- **Docs**: `docs/docs/app/` wizard/edit-game pages and
  `docs/docs/components/management-app.md` need updating to describe the new
  step, per `CLAUDE.md`'s "docs in the same PR" rule.
