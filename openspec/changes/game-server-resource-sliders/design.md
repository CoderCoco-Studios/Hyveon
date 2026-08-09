## Context

The add-game wizard's Resources step (`app/packages/web/src/components/add-game-wizard/resources-step.component.tsx`) currently uses two cascading `<select>` dropdowns to pick a game server's Fargate vCPU and memory, sourced from `getFargateCpuOptions()`/`getFargateMemoryOptions(cpu)` in `@hyveon/shared/gameServerValidator`. The same component is reused unmodified by `edit-game-form.component.tsx`, so any change here covers both flows.

AWS Fargate does not support arbitrary (vCPU, memory) combinations. `FARGATE_CPU_MEMORY_TABLE` in `gameServerValidator.ts` encodes the real constraint:

| CPU units | vCPU | Memory range | Step |
|---|---|---|---|
| 256 | 0.25 | 512 / 1024 / 2048 MiB (fixed list) | n/a |
| 512 | 0.5 | 1024–4096 MiB | 1024 |
| 1024 | 1 | 2048–8192 MiB | 1024 |
| 2048 | 2 | 4096–16384 MiB | 1024 |
| 4096 | 4 | 8192–30720 MiB | 1024 |
| 8192 | 8 | 16384–61440 MiB | 4096 |
| 16384 | 16 | 32768–122880 MiB | 8192 |

Cost math already exists (`CostService.estimateForSpec` in desktop-main, `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` in `@hyveon/cloud-aws/AwsCloudProvider.ts`) but is wired only into the standalone Costs page, not this wizard step. The app has an explicit prior decision against live AWS Pricing/Cost Explorer API calls (`openspec/changes/remove-cost-explorer-calls`) — all cost figures come from these hardcoded constants.

## Goals / Non-Goals

**Goals:**
- Replace the two dropdowns with two sliders that can only ever land on valid Fargate (vCPU, memory) pairs.
- Show a live estimated hourly cost as the operator drags either slider.
- Cover both the add-game wizard and the edit-game form via the single shared `ResourcesStep` component.

**Non-Goals:**
- Changing the Costs page or `CostService.estimateForSpec` itself, beyond relocating two constants.
- Imposing any app-level cap below AWS's real Fargate maximum (16 vCPU / 122880 MiB).
- Adding live AWS Pricing API calls — the hardcoded constants remain the source of truth.
- Changing the `GameServerConfig`/`DeploymentConfig` data shape, infra task-definition wiring, or validation logic (`checkFargateCpuMemoryPairing`) — only the input control changes.

## Decisions

### D1: Slider values are array indices, not raw units
- **Choice**: Both sliders (`<input type="range" min=0 max=N step=1>`) hold an index into an enumerated, pre-validated array — `getFargateCpuOptions()` for vCPU, `getFargateMemoryOptions(cpu)` for memory — rather than a raw CPU-unit or MiB range with a fixed `step`.
- **Rationale**: Fargate's tiers are not evenly spaced (vCPU: 0.25/0.5/1/2/4/8/16) and memory's step size itself varies by tier (1/4/8 GiB) with a fixed 3-value list at the smallest tier. A raw range+step slider cannot represent this; indexing into the same enumerated arrays the dropdowns already use guarantees every reachable slider position is valid, by construction, with no extra validation code.
- **Alternatives considered**: A raw MiB-range slider with dynamic min/max/step recalculated per CPU tier — rejected because the 0.25 vCPU tier's memory options (512/1024/2048 MiB) aren't evenly spaced by any single step, so a min/max/step model can't represent it at all; would need special-casing that the index approach avoids entirely.

### D2: CPU tier changes cascade into memory range, matching current behavior
- **Choice**: Moving the vCPU slider live recomputes `getFargateMemoryOptions(cpu)` and re-clamps the memory slider's index if the previous memory value is no longer in range — the same logic already at `resources-step.component.tsx:36-42`.
- **Rationale**: User explicitly chose this over independent sliders with silent post-hoc clamping, to keep the interaction model identical to what the dropdowns already do (least surprise).
- **Alternatives considered**: Independent sliders with clamp-on-change — rejected per user's explicit preference in brainstorming (Q3).

### D3: Cost readout shows hourly rate only, computed client-side
- **Choice**: New pure function `estimateFargateHourlyCost(cpu: number, memory: number): number` in `@hyveon/shared`. The two pricing constants (`FARGATE_VCPU_PER_HOUR`, `FARGATE_GB_PER_HOUR`) move from `@hyveon/cloud-aws/AwsCloudProvider.ts` into `@hyveon/shared`; `cloud-aws` re-imports them so there is exactly one source of truth (same pattern as `canRun()` living in one place per `CLAUDE.md`). Rendered as `$X.XXX/hr while running`, recomputed synchronously on every slider `input` event.
- **Rationale**: The math is two multiplications — pure, cheap, and safe to run on every input event with no debounce. Computing it client-side avoids adding an IPC round-trip to something meant to feel live, and avoids pulling `@hyveon/cloud-aws` (and transitively the AWS SDK) into the web renderer bundle. Hourly-only (not day/month) was chosen because day/month figures bake in a usage-pattern assumption (`CostService`'s existing `×24` / `×4hr/day×30` derivations) that doesn't apply cleanly to a picker showing an instantaneous rate, and Hyveon's on-demand `RunTask`/`StopTask` model means "per month" isn't a fixed multiple of "per hour" the way it would be for an always-on service.
- **Alternatives considered**: Call the existing costs IPC endpoint per slider change (debounced) — rejected because it adds latency to a supposedly-live UI element for a computation that doesn't need a service call at all. Showing the full hr/day/month breakdown — rejected per user's explicit preference (Q4).

### D4: Layout is stacked, not side-by-side
- **Choice**: vCPU slider, then memory slider, then the cost readout, all full-width and stacked vertically.
- **Rationale**: User selected this over a side-by-side layout with a pinned cost card, after reviewing both as mockups via the visual brainstorming companion.
- **Alternatives considered**: Side-by-side sliders with a highlighted cost card — presented as Option B, not chosen.

## Risks / Trade-offs

- [Risk] Range inputs are less discoverable as "snap points" than a dropdown's explicit option list — a user dragging might not immediately realize there are only 7 vCPU stops. → Mitigation: render tick marks/labels at each snap point (as mocked) and show the resolved value as text next to the slider on every move, not just on release.
- [Risk] The underlying slider `value` is an array index, not the real vCPU/MiB number, which is easy to get backwards when wiring `aria-valuetext`/`onChange` → `draft.cpu`/`draft.memory`. → Mitigation: keep the index→value mapping in one small pure helper next to the component, covered directly by the component spec's edge-tier test cases (D1's rationale already requires enumerating this correctly).
- [Trade-off] Moving `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` out of `@hyveon/cloud-aws` touches a file (`AwsCloudProvider.ts`) outside the wizard's own directory → accepted, because the alternative (duplicating the constants, or pulling `cloud-aws` into the web bundle) is worse on both correctness and bundle-size grounds; the move is a pure relocation with `cloud-aws` re-importing, so there's no behavior change to `CostService`.

## Migration Plan

N/A — this change involves no deployment, infra, or persisted-data changes. `cpu`/`memory` field values, their AWS-side meaning, and the ECS task-definition wiring in `app/packages/infra/src/ecs.ts` are all unchanged; this is a UI-control and shared-utility relocation only. No feature flag or rollback plan beyond a normal revert is needed.

## Open Questions

None outstanding — all forks identified during brainstorming were resolved with the user (see `brainstorm.md` Q1–Q6 and the visual layout choice).
