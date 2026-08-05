## 1. Static region data set

- [ ] 1.1 Write `build/generate-aws-regions.mjs`: fetch
      `https://b0.p.awsstatic.com/locations/1.0/aws/current/locations.json`,
      filter to commercial-partition AWS Regions only (exclude Local
      Zones, Wavelength Zones, GovCloud, China), map to
      `{ code, name, continent }`, sort by continent then name.
- [ ] 1.2 Add `AwsRegionInfo` interface and `AWS_REGIONS: AwsRegionInfo[]`
      export to a new `app/packages/shared/src/awsRegions.ts`, written by
      the script from 1.1.
- [ ] 1.3 Export `AwsRegionInfo` and `AWS_REGIONS` from
      `app/packages/shared/src/index.ts`.
- [ ] 1.4 Add a `aws-regions:generate` script to the root `package.json`
      that runs the generator from 1.1 (following the `icons:generate`
      pattern — manually triggered, not part of `app:build`).
- [ ] 1.5 Run `aws-regions:generate` once to produce the initial
      committed `awsRegions.ts`.

## 2. Guided-IAM region dropdown

- [x] 2.1 In `guided-iam-step.component.tsx`, add local state to track
      whether manual entry is active (`manualRegionEntry: boolean`),
      defaulting to `false`. (The `region` phase is only ever entered with
      `region === ''` — a successful resume with a recovered region skips
      straight to the `template` phase — so no resume-aware default is
      needed.)
- [x] 2.2 Replace the `phase === 'region'` screen's `<Input>`
      (`guided-iam-step.component.tsx:474-486`) with the shadcn `Select`
      family (`Select`, `SelectTrigger`, `SelectContent`, `SelectGroup`,
      `SelectLabel`, `SelectItem`) from `ui/select.component.tsx`, rendered
      when `manualRegionEntry` is `false`.
- [x] 2.3 Group `SelectItem`s by `continent` using `SelectGroup` +
      `SelectLabel`, sorted per `AWS_REGIONS`' existing order; item label
      format `"{name} — {code}"`; `onValueChange` sets `region` to the
      selected `code`.
- [x] 2.4 Add a final ungrouped `SelectItem` "Other (enter manually)" whose
      selection sets `manualRegionEntry` to `true` instead of writing to
      `region`.
- [x] 2.5 When `manualRegionEntry` is `true`, render the original
      `<Input>` (pre-focused via `autoFocus`) in place of the `Select`,
      preserving existing `id`, `placeholder`, `value`/`onChange`, and
      `regionError` display unchanged.
- [x] 2.6 Verify `guided-iam-step.component.tsx`'s own local emptiness
      validation (`handleChooseGuided`) requires no changes — `region`
      stays a plain string in both render paths, so `handleChooseGuided`,
      `handleOpenConsole`, and `handleSubmitKey` need no changes either.

## 3. Tests

- [x] 3.1 Extend `guided-iam-step.component.tsx`'s jsdom component spec:
      region phase renders continent-grouped options with the
      `"{name} — {code}"` label format.
- [x] 3.2 Add a test: selecting a concrete region option sets `region` to
      its code and enables "Next".
- [x] 3.3 Add a test: selecting "Other (enter manually)" reveals the text
      input, and typing a value not present in `AWS_REGIONS` is accepted
      and flows through to the same state/validation path as before.
- [x] 3.4 Confirm existing region-phase tests (resume-without-region
      messaging, guided vs. manual-credentials buttons) still pass
      unmodified.

## 4. Verification

- [ ] 4.1 `npm run app:lint` — clean.
- [ ] 4.2 `npm run app:typecheck` — clean.
- [ ] 4.3 `npm run app:test` — full unit suite green.
- [ ] 4.4 Manually run the first-run wizard (`npm run desktop:dev`),
      reach the guided-IAM region screen, and confirm the dropdown renders
      grouped regions, a selection advances normally, and
      "Other (enter manually)" still accepts a typed region code.
