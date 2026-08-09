## 1. Shared pricing relocation

- [ ] 1.1 Move `FARGATE_VCPU_PER_HOUR` and `FARGATE_GB_PER_HOUR` from `app/packages/cloud-aws/src/AwsCloudProvider.ts` into `@hyveon/shared` (new module, e.g. `app/packages/shared/src/fargatePricing.ts`)
- [ ] 1.2 Update `AwsCloudProvider.ts` to re-import the constants from `@hyveon/shared`
- [ ] 1.3 Update `app/packages/desktop-main/src/services/CostService.ts`'s import path if it imports the constants directly rather than via `AwsCloudProvider`
- [ ] 1.4 Add `estimateFargateHourlyCost(cpu: number, memory: number): number` to `@hyveon/shared`, next to the relocated constants or `gameServerValidator.ts`
- [ ] 1.5 Unit test `estimateFargateHourlyCost` in `@hyveon/shared` for at least one value from each of the 7 vCPU tiers

## 2. Resources step slider control

- [ ] 2.1 Replace the vCPU `<select>` in `resources-step.component.tsx` with an `<input type="range">` indexed into `getFargateCpuOptions()`, with tick labels for all 7 tiers
- [ ] 2.2 Replace the memory `<select>` with an `<input type="range">` indexed into `getFargateMemoryOptions(cpu)` for the current vCPU tier
- [ ] 2.3 Port the existing cascading reset behavior (`resources-step.component.tsx:36-42`) to the slider `onChange` handlers: changing vCPU re-clamps memory's index if the current value is no longer valid
- [ ] 2.4 Render GiB labels for memory (MiB ÷ 1024), including the single 0.5 GiB case at the 0.25 vCPU tier
- [ ] 2.5 Add `aria-label`/`aria-valuetext` to both sliders reflecting the human-readable value ("2 vCPU", "4 GiB"), not the raw index
- [ ] 2.6 Add the live cost readout ("$X.XXX/hr while running") below both sliders, calling `estimateFargateHourlyCost` on every slider `input` event

## 3. Tests

- [ ] 3.1 Update `resources-step.component.spec` to drive `<input type="range">` via `fireEvent.change`/`fireEvent.input` instead of `<select>`'s `fireEvent.change`
- [ ] 3.2 Add a test case for the 0.25 vCPU tier's fixed 3-value memory list (512/1024/2048 MiB)
- [ ] 3.3 Add a test case for the 16 vCPU tier's 8 GiB memory step
- [ ] 3.4 Add a test asserting the cost readout text matches `estimateFargateHourlyCost` for a known (cpu, memory) pair
- [ ] 3.5 Confirm no test relies on the removed `<select>` elements in either the add-game wizard or edit-game form specs (`add-game-wizard.component.spec`, `edit-game-form.component.spec`, `review-step.component.spec` if applicable)

## 4. Verification and docs

- [ ] 4.1 `npm run app:lint` clean
- [ ] 4.2 `npm run app:typecheck` clean
- [ ] 4.3 `npm run app:test` full unit suite green
- [ ] 4.4 `npm run app:test:e2e` if the renderer/preload/IPC surface changed as a result of this work
- [ ] 4.5 Update the wizard page under `docs/docs/app/` describing the slider control and live cost estimate
- [ ] 4.6 `/opsx:sync` to fold `game-resource-picker` and the `cost-visibility` delta into `openspec/specs/` once implementation is verified
