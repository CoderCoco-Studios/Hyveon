## Why

The `replace-alb-with-caddy-sidecar` change made HTTPS a per-game flag that any operator should be able to turn on: set `https = true` in the `game_servers` map and the game's ECS task gains a Caddy sidecar that terminates TLS via Let's Encrypt. Every layer below the UI already carries that flag end to end — the tfvars schema, the zod validator, the IPC and HTTP payloads, the HCL emitter, and the read-only HTTPS field on the game detail page.

The web UI is the one gap. Neither the add-game wizard nor the edit-game form has a control for `https`, because the wizard's draft shape (#99) never had a field for it. The edit form works around this by carrying the existing value forward verbatim so a save doesn't wipe it out. The practical consequence: turning HTTPS on for a game means hand-editing the tfvars object in S3, which is exactly the workflow the games UI exists to replace.

## What Changes

- Add `https` to the shared `WizardDraft` shape so both the add-game wizard and the edit-game form carry the flag through their draft → payload round trip.
- Render an HTTPS toggle in the Networking step, which both flows already use. Enabling it reveals an inline amber callout describing the infrastructure consequences.
- Remove the `https` carry-forward workaround in the edit form's submit path; the draft now owns the value. `environment` keeps its carry-forward, since it is still not an editable field.
- Port the four Terraform-level `https = true` validation rules into the shared `validateGameServer` business rules, so a configuration that would fail `terraform validate` is blocked at the form instead:
  - the game must declare at least one port;
  - `ports[0].protocol` must be exactly `tcp` (Caddy's `reverse-proxy` only speaks HTTP over TCP to the first port);
  - every port protocol must be `tcp` or `udp`;
  - no port may use 80 or 443, which are reserved for the sidecar on the task's shared ENI.
- Issues are pathed at `ports[N]` so the offending port row highlights in the Networking step rather than surfacing as a generic review-step error.
- Add `https` round-trip coverage to the tfvars write tests, which currently contain no `https` at all.

No breaking changes. A game that omits `https` continues to behave exactly as before — the flag stays optional and defaults to `false`.

## Capabilities

### New Capabilities

- `game-https-configuration`: Operator-facing configuration of a game's in-task TLS termination — how the `https` flag is presented, what constraints govern a valid HTTPS-enabled game, what the operator is told before enabling it, and how the value round-trips to the tfvars declaration.

### Modified Capabilities

None. No existing spec files live under `openspec/specs/` yet, so there are no published requirements to amend.

## Impact

**Web (`@hyveon/web`)**

- `components/add-game-wizard/wizard-form.utils.ts` — `WizardDraft` gains `https`; `createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`, `toProposedEntry`, and `stepForIssuePath` all need updating.
- `components/add-game-wizard/networking-step.component.tsx` — the toggle plus the amber callout.
- `components/edit-game-form/edit-game-form.component.tsx` — drop the `https` carry-forward from the submit payload; update the module doc and inline comment that explain the old workaround.
- `components/add-game-wizard/review-step.component.tsx` — surface the flag in the Networking summary.

**Shared (`@hyveon/shared`)**

- `gameServerValidator.ts` — four new business rules in `validateGameServer`, active only when `https === true`. This runs on the IPC/HTTP surface too, so the protection is not UI-only.

**Unchanged (verified)**

The tfvars types, `gamesWrite.ts` payloads, the preload bridge and `gsd-api.ts`, `api.service.ts`, both games controllers, `GamesWriteService`, `hclEmit`, and the `TfvarsService` write path already handle `https` correctly. No IPC, DTO, or Terraform changes are required.

**Tests**

- `wizard-form.utils.test.ts`, `networking-step.component.test.tsx`, `edit-game-form.component.test.tsx`, `review-step.component.test.tsx`
- `gameServerValidator.test.ts` — one case per new rule, plus a case proving the rules are inert when `https` is false or absent.
- `TfvarsService.write.test.ts` — assert `https` survives an update, that flipping it `false → true` rewrites the entry, and that enabling it on an entry with no `https` attribute at all emits `https = true`.

**Operator-visible behaviour**

Enabling HTTPS opens 443 and 80 to the internet stack-wide (the Terraform rule is keyed on "any HTTPS game exists", not per game), removes the game's raw container port from public ingress, and makes first boot perform an ACME issuance that requires `{game}.{hosted_zone_name}` to resolve to the task. The callout has to state all three, because none of them are recoverable by simply unchecking the box after a `terraform apply`.
