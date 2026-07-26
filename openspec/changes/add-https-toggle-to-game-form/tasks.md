# Tasks — add-https-toggle-to-game-form

Single PR. Validation lands before the UI so the form has real rules to bind to, and so a
half-finished branch never ships a control that can save a Terraform-invalid declaration.

## 1. Shared validation (`@hyveon/shared`)

- [ ] 1.1 In `app/packages/shared/src/gameServerValidator.ts`, add an HTTPS business-rule block to `validateGameServer`, gated on `https === true`. Transcribe the four rules from `terraform/aws/variables.tf`: at least one port (pathed `ports`); `ports[0].protocol === 'tcp'` matched exactly and lowercase (pathed `ports[0]`); every port protocol in `{'tcp','udp'}` (pathed at the offending entry); no port using 80 or 443 (pathed at the offending entry). Add a comment naming `terraform/aws/variables.tf` as the source of truth these rules mirror.
- [ ] 1.2 Extend `gameServerValidator.test.ts`: one failing case per rule asserting both the message and the issue path, a case proving all four are inert when `https` is `false` and when it is omitted, and a passing case for a valid HTTPS game (first port `8080/tcp`). Include the uppercase-`TCP` case explicitly — it is the rule most likely to look like a bug later.

## 2. Draft plumbing (`@hyveon/web`)

- [ ] 2.1 In `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`, add `https: boolean` to `WizardDraft`; seed `https: false` in `createEmptyWizardDraft()`; read `https: game.https === true` in `draftFromGameServer()` — an explicit strict-equality normalisation, not `?? false`, so a non-boolean parsed value (design D6) becomes `false` rather than surviving as a truthy string; emit `https` from `draftToPayload()`; include it in `toProposedEntry()` so validation sees it.
- [ ] 2.2 Update `stepForIssuePath()` so `ports`-rooted paths (`ports`, `ports[N]`) resolve to the `networking` step rather than falling through to `review`, and confirm existing port-collision issues still route correctly.
- [ ] 2.3 Extend `wizard-form.utils.test.ts`: round-trip a `GameServer` with `https: true` through `draftFromGameServer` → `draftToPayload`; assert a game with no `https` yields a `false` draft and an explicit `https: false` payload; assert a string-valued `https` (the `hcl2json` expression case from design D6) coerces to `false`; assert `stepForIssuePath` maps `ports[1]` to `networking`.

## 3. Networking step control (`@hyveon/web`)

- [ ] 3.1 In `networking-step.component.tsx`, render the HTTPS checkbox using the repo's raw-checkbox pattern (styled `<input type="checkbox">` inside a `<label>`, per `discord.page.tsx`), with an associated `<Label htmlFor>` and `aria-invalid` when a rule is violated.
- [ ] 3.2 Render the amber warning callout beside the control, shown only when the flag is enabled, using the existing `AlertTriangle` + `border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10` pattern. Cover all three consequences: 443/80 open stack-wide (not per game), this game's raw container port loses public ingress, and first boot performs an ACME issuance requiring `{game}.{hosted_zone_name}` to resolve. Wire `aria-describedby` from the control to the callout while it is shown.
- [ ] 3.3 Surface HTTPS port-rule issues against the offending port row so the operator sees which entry is at fault.
- [ ] 3.4 Extend `networking-step.component.test.tsx`: toggling the control fires the change handler with the right value; the callout renders only when enabled; a violated rule marks the control/row invalid and the callout is referenced by `aria-describedby`.

## 4. Edit form (`@hyveon/web`)

- [ ] 4.1 In `edit-game-form.component.tsx`, drop `https` from the carry-forward spread in `handleSave()` so the draft owns the value; keep `environment`'s carry-forward untouched.
- [ ] 4.2 Update the module doc comment and the inline submit comment so they describe only `environment` as non-editable — the current text explains a constraint that no longer applies to `https`.
- [ ] 4.3 Extend `edit-game-form.component.test.tsx`: a game with `https: true` renders the control enabled; disabling and saving sends `https: false` rather than carrying `true` forward; editing only the image on an HTTPS game still sends `https: true`.

## 5. Wizard review step (`@hyveon/web`)

- [ ] 5.1 Add the HTTPS flag to the Networking summary in `review-step.component.tsx` so a wizard-created game's TLS setting is visible before submit.
- [ ] 5.2 Extend `review-step.component.test.tsx` to cover both the enabled and disabled rendering.

## 6. Write-path coverage (`@hyveon/desktop-main`)

- [ ] 6.1 Add `https` coverage to `TfvarsService.write.test.ts`, which currently has none: an update that enables HTTPS on an entry omitting `https` entirely emits `https = true` (the common case, since the attribute is optional and most existing entries lack it); an update that flips `false → true` emits `https = true`; an update that flips `true → false` emits `https = false` rather than dropping the attribute; an unrelated field edit on an HTTPS game leaves `https = true` and the surrounding attributes intact.

## 7. Gates and PR

- [ ] 7.1 Gate: `npm run app:test` and `npm run app:lint` pass from the repo root.
- [ ] 7.2 Manually drive the flow in the app (`npm run app:dev`): enable HTTPS on a game, confirm the callout appears, confirm a `udp` first port blocks the save with the issue on the right row, correct it, save, and verify the game detail page's read-only HTTPS field flips to Enabled without a refetch.
- [ ] 7.3 Open PR via `/pr`: title `feat(web): allow setting the HTTPS flag from the game form`, body first line `Closes #N` once the issue is filed.
