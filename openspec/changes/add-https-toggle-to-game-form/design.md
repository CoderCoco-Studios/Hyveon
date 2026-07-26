## Context

Since `replace-alb-with-caddy-sidecar`, a game flagged `https = true` in the `game_servers` map gains a Caddy sidecar container that terminates TLS with Let's Encrypt and reverse-proxies to the game container over `localhost`. The flag is a per-game boolean in the tfvars declaration, and everything below the UI already handles it:

- `GameServer.https?: boolean` in `@hyveon/shared/tfvars.ts`, with `https: z.boolean().optional()` in `gameServerValidator.ts`.
- `hclEmit.ts` emits `https = <bool>` when the value is defined, and omits the attribute when it is `undefined`.
- `TfvarsService.parseGameServers()` spreads raw entries, so the flag survives the read; `updateGameServer()` → `replaceGameServerEntry()` → `emitGameServerEntry()` carries it back out.
- The IPC and HTTP write surfaces are typed `Omit<GameServer, 'name'>`, so the flag is already in the payload contract.
- `game-detail.page.tsx` renders it read-only from the declared config.

The gap is the web form. The add-game wizard (#99) defined `WizardDraft` without `https`, and the edit-game form reuses that exact type. To avoid silently wiping the flag on save, the edit form spreads the original value back in after `draftToPayload`:

```ts
config: { ...config, environment: game.environment, https: game.https },
```

That workaround is why an operator who wants HTTPS today has to hand-edit the tfvars object in S3.

There is a second, quieter gap. Terraform's `game_servers` variable validation imposes four rules that only apply to `https = true` games, and the app's zod validator replicates none of them. Today that is harmless because the UI cannot set the flag. The moment it can, the UI becomes capable of saving a declaration that passes every app-side check and then fails `terraform validate` — after the operator has already committed it to the remote tfvars object.

## Goals / Non-Goals

**Goals:**

- Make `https` a first-class editable field in both the add-game wizard and the edit-game form, sharing one control and one draft field.
- Close the validation gap so the app rejects an HTTPS configuration that Terraform would reject, on every write path rather than only in the browser.
- Tell the operator what enabling HTTPS actually does to the stack, at the moment they enable it.
- Remove the `https` carry-forward workaround and the comments that explain it, so the code stops describing a constraint that no longer exists.

**Non-Goals:**

- Making `environment` editable. It is excluded for the same historical reason but is a different shape (a list of name/value pairs), a larger surface, and is not what is being asked for here. Its carry-forward stays.
- Any Terraform change. The variable validation already exists and is the source of truth being mirrored.
- Surfacing `hosted_zone_name` or the resulting `https://{game}.{zone}` URL in the form. The app carries no `hosted_zone_name` in any TypeScript type today; plumbing it through is a separate change (see Open Questions).
- Per-game ingress. The 443/80 security-group rule is stack-wide by Terraform's design, keyed on whether any HTTPS game exists. The form describes that behaviour; it does not change it.
- Any change to the read-only HTTPS field on the game detail page. It reads declared config and already updates from the write result without a refetch.

## Decisions

### D1: Put `https` on the shared `WizardDraft` rather than a form-local field

`WizardDraft` is the single draft shape behind both flows, and the whole draft pipeline (`createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`, `toProposedEntry`, `validateStep`, `stepForIssuePath`) is written against it. Adding the field there means the wizard gets the capability essentially for free and the edit form's carry-forward hack can be deleted outright.

The alternative — a field local to the edit form, with the wizard continuing to create HTTPS-off games — was rejected. It leaves two divergent draft paths, and it produces the obvious follow-up complaint ("why can I edit this but not set it at creation?"). The cost of doing both at once is one extra call site in `createEmptyWizardDraft` and one summary line in the review step.

Concretely:

| Function | Change |
|---|---|
| `WizardDraft` | add `https: boolean` (non-optional in the draft, even though the wire type is optional) |
| `createEmptyWizardDraft()` | seed `https: false` |
| `draftFromGameServer()` | `https: game.https ?? false` |
| `draftToPayload()` | emit `https` into the config |
| `toProposedEntry()` | include `https` so validation sees it |
| `stepForIssuePath()` | map `ports`-rooted paths to the networking step |

The draft field is a strict `boolean` while the wire type stays `boolean | undefined`. Normalising at the draft boundary keeps the checkbox a controlled component with no `undefined` state to reason about, and `draftToPayload` emitting an explicit `false` is harmless — `hclEmit` writes `https = false`, which is what Terraform defaults to anyway.

### D2: Render the control in the Networking step

The flag is a networking concern: it decides which ports are publicly reachable and introduces a second container listening on 443/80. The Networking step is also where the ports it constrains are edited, so a violation and its cause are visible together. Both flows already render this step, so one placement serves both.

The alternative of a dedicated step or card was rejected as disproportionate for a single boolean, and it would have separated the flag from the port rows its validation points at.

### D3: Mirror Terraform's four HTTPS rules in `validateGameServer`, not in the component

Putting the rules in the shared validator means they run behind the IPC and HTTP write surfaces too, so the protection is not defeated by a direct `games.update` call. It also matches how every other business rule in this codebase is expressed (Fargate cpu/memory pairing, absolute volume paths, connect_message placeholders, port collisions all live there).

The rules, transcribed from `terraform/aws/variables.tf`:

1. `length(cfg.ports) > 0`
2. `cfg.ports[0].protocol == "tcp"` — exact, lowercase
3. every port protocol ∈ `{"tcp", "udp"}`
4. no port may be 80 or 443

Rule 2's exactness deserves a note: Terraform compares the literal string, so `TCP` fails there. Being lenient in the app would let a save through that Terraform then rejects, which is precisely the failure this decision exists to prevent. The validator matches Terraform's strictness rather than being helpful, and the message says why.

Issue paths are anchored per entry (`ports[0]`, `ports[2]`) so `stepForIssuePath` routes them to the networking step and the offending row can be highlighted. Rule 1 has no entry to point at and is pathed at `ports`.

All four rules are gated on `https === true`. A non-HTTPS game may keep using UDP on 443 if it wants to.

### D4: An inline callout gated on the enabled state, not a confirm dialog

The three consequences — stack-wide 443/80 exposure, loss of the raw port's public ingress, first-boot ACME issuance needing DNS — are things the operator needs to *read*, and a dialog that is dismissed to proceed gets clicked through. An always-visible callout beside an enabled toggle keeps the information present while they finish configuring ports, which is exactly when rules 1–4 are most likely to bite.

A confirm dialog was considered and rejected: the action is not destructive at the moment of the click (nothing happens until `terraform apply`), so the `RemoveGameButton` alert-dialog pattern would be borrowing weight from a different kind of risk. Plain helper text was also rejected as too easy to skip for a change that reshapes the security group.

The repo's existing amber warning pattern is reused — `AlertTriangle` with `border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10`, as used by the Terraform page's busy banner and the first-run wizard's bootstrap step — rather than introducing a new visual treatment.

### D5: Use the repo's raw-checkbox pattern, not a new UI primitive

There is no `checkbox.component.tsx` in `components/ui/`. Existing boolean controls (the Discord page's per-action permission grid, the Logs page's autoscroll toggles) use a styled `<input type="checkbox">` inside a `<label>`. This change follows that rather than introducing a shared primitive, which would be a refactor with its own blast radius across those call sites. If a third or fourth consumer appears later, extracting the primitive is a clean, separate change.

Accessibility follows the `Field` helper already in `identity-step.component.tsx`: an associated `<Label htmlFor>`, `aria-describedby` pointing at the callout when it is shown, and `aria-invalid` when a rule is violated.

### D6: Coerce a non-boolean parsed `https` to `false` in the draft

`@cdktf/hcl2json` does not evaluate expressions. A tfvars entry written by hand as `https = length("valheim") > 0 ? true : false` parses back as a *string*, and `TfvarsService.test.ts` documents exactly this. Such an entry already fails `z.boolean()` in `validateGameServer` today, so it cannot be saved through the app at all — with or without this change.

`draftFromGameServer` therefore uses `game.https ?? false`, which yields `false` for a string value rather than a truthy checkbox. This is deliberate and worth stating: the form shows what it can honestly represent, and any save through the form replaces the expression with a literal. That is the only behaviour consistent with a checkbox, and the pre-existing zod rejection means the alternative is not "preserve the expression" but "cannot use the form on this game at all".

## Risks / Trade-offs

**Operator enables HTTPS on a game whose DNS does not resolve, and Caddy loops on failed ACME orders** → The callout names the `{game}.{hosted_zone_name}` requirement explicitly. Beyond that, this is inherent to the Caddy design from `replace-alb-with-caddy-sidecar` and is not made worse here; the sidecar retries with backoff and the game container is unaffected because Caddy proxies over localhost regardless of cert state.

**Enabling HTTPS on one game opens 443/80 for the whole stack, which the per-game control may imply is per-game** → The callout says "for the whole stack, not only this game" in those terms. A per-game ingress model would require a Terraform change and is out of scope.

**Validator rules drift from Terraform's if the variable validation is later edited** → The rules are transcribed, not shared — there is no mechanism to derive TypeScript checks from HCL validation blocks. Mitigation is a comment in `gameServerValidator.ts` naming `terraform/aws/variables.tf` as the source of truth, so a future edit to either side has a pointer to the other. Both copies of the Terraform variable (root and module) already have to be kept in sync by hand, so this is a third instance of an existing discipline rather than a new class of problem.

**A game that is currently valid becomes invalid under the new rules** → Only possible for a game already declared `https = true` with a non-conforming port list, which Terraform would already be refusing to apply. Such a game is broken today; the change surfaces it in the UI. If one exists, the edit form will block saving until the ports are corrected, which is the desired outcome rather than a regression.

**`draftToPayload` now always emits `https`, so entries that previously omitted the attribute gain an explicit `https = false` on their next save** → Cosmetic. `false` is the Terraform default, so the plan is unchanged; the diff on the tfvars object gains one line for games saved through the form after this ships.

## Migration Plan

None required. The change is additive to the form and to validation, ships in a single PR, and needs no data migration, no Terraform apply, and no coordination with a deploy. Rollback is a revert: the flag returns to being carried forward untouched, and any `https` value already written to the tfvars object stays valid because the declaration format does not change.

## Open Questions

- Should the form show the resulting URL (`https://{game}.{hosted_zone_name}`) once the flag is enabled? It would make the ACME/DNS requirement concrete rather than abstract. It needs `hosted_zone_name` plumbed into a TypeScript type — it exists in the Terraform outputs (`terraform/aws/outputs.tf`) but is not surfaced anywhere in the app today. Deferred; the callout describes the requirement in prose in the meantime.
- Should the review step block, rather than merely display, an HTTPS game whose ports violate the rules? The validation gate already disables save, so this is a question about redundancy in the wizard's summary rather than about correctness.
