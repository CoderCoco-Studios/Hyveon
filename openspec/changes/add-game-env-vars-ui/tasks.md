## 1. Shared validator rule

- [ ] 1.1 Add `checkEnvironmentVariables(entry)` to
      `app/packages/shared/src/gameServerValidator.ts` (parallel to
      `checkAbsolutePaths`): reject an empty `environment[N].name`; reject a
      `name` that duplicates an earlier row's `name` within the same entry.
- [ ] 1.2 Wire `checkEnvironmentVariables` into `validateGameServer`'s
      post-parse success branch, alongside the other checks
      (`checkFargateCpuMemoryPairing`, `checkAbsolutePaths`,
      `checkConnectMessagePlaceholders`).
- [ ] 1.3 Add/extend `gameServerValidator.test.ts` (or create it if it
      doesn't exist): empty-name rejection, duplicate-name rejection,
      distinct-non-empty-names acceptance, issue path shape
      (`environment[N].name`).

## 2. Wizard draft plumbing

- [ ] 2.1 Add `WizardDraftEnvironmentVariable { name: string; value: string }`
      and an `environment: WizardDraftEnvironmentVariable[]` field to
      `WizardDraft` in
      `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`.
- [ ] 2.2 Wire `environment` through `createEmptyWizardDraft` (empty array),
      `draftFromGameServer` (map from `game.environment ?? []`),
      `draftToPayload` (map back, omitting the field entirely when empty —
      matching `file_seeds`' `undefined`-when-empty convention), and
      `toProposedEntry`.
- [ ] 2.3 Add `'environment'` to `WIZARD_STEPS` between `'storage'` and
      `'review'`, and extend `stepForIssuePath` so the `environment` path
      family routes to the new step.
- [ ] 2.4 Add a `validateEnvironmentStep` export mirroring
      `validateStorageStep`.
- [ ] 2.5 Extend `wizard-form.utils.test.ts` for the new draft field, step
      ordering, and `stepForIssuePath` routing.

## 3. Environment step component

- [ ] 3.1 Create
      `app/packages/web/src/components/add-game-wizard/environment-step.component.tsx`:
      a dynamic row list (name + value `Input` pairs, Add/Remove buttons,
      `data-testid="env-row-{index}"`), modeled directly on the `file_seeds`
      half of `storage-step.component.tsx` (optional list, no minimum row
      count, no "last row" remove restriction).
- [ ] 3.2 Add `environment-step.component.test.tsx`: row add/remove/edit,
      empty state message, validation issue display per row.

## 4. Wire the step into both flows

- [ ] 4.1 In `add-game-wizard.component.tsx`, add `'Environment'` to
      `STEP_LABELS` and render `<EnvironmentStep>` between the Storage and
      Review steps.
- [ ] 4.2 In `edit-game-form.component.tsx`, add an "Environment" `<Card>`
      section rendering `<EnvironmentStep>`, positioned after the Storage
      card.
- [ ] 4.3 In `edit-game-form.component.tsx`, delete the
      `environment: game.environment` carry-forward line and its
      explanatory comment in `handleSave` — `config` from `draftToPayload`
      now already carries the operator's edited value.
- [ ] 4.4 Extend `add-game-wizard.component.test.tsx` and
      `edit-game-form.component.test.tsx` for the new step/section:
      submitting with env vars, submitting without, editing an existing
      game's env vars, unrelated-field save leaving env vars untouched.

## 5. Review step summary

- [ ] 5.1 In `review-step.component.tsx`, add an "Environment variables"
      summary list (name/value pairs) below the existing Storage card's
      content (or as its own card, matching the Environment step's own
      step/card boundary chosen in section 4), omitted entirely when the
      draft's `environment` list is empty — matching the `hasFileSeeds`
      convention.
- [ ] 5.2 Extend `review-step.component.test.tsx` for the new summary:
      rendered when rows exist, omitted when empty.

## 6. Documentation

- [ ] 6.1 Update the add-game wizard / edit-game page(s) under
      `docs/docs/app/` to describe the new Environment step/section.
- [ ] 6.2 Update `docs/docs/components/management-app.md` if it enumerates
      the wizard's steps.
- [ ] 6.3 Run the `write-docs` skill (or its evaluator agents) over the
      touched docs pages per `CLAUDE.md`'s "docs in the same PR" rule.

## 7. Verification gate

- [ ] 7.1 `npm run app:lint` — clean.
- [ ] 7.2 `npm run app:typecheck` — clean.
- [ ] 7.3 `npm run app:test` — full unit suite green, including every new
      spec added above.
- [ ] 7.4 `npm run app:test:e2e` — since the renderer changed (new wizard
      step / edit-form section).
