## Why

The add-game wizard's Resources step picks a game server's Fargate vCPU and memory via two cascading `<select>` dropdowns, which force scanning a flat list to find a valid pair and give no sense of cost until after saving. AWS Fargate only supports 7 fixed vCPU tiers with memory ranges that vary by tier, so operators can't easily see the tradeoff space at a glance. Replacing the dropdowns with sliders that snap to valid tiers, plus a live cost readout, makes the tradeoff visible while choosing instead of after.

## What Changes

**Resources step control**
- From: two independent `<select>` dropdowns for vCPU and memory, values in raw Fargate units (CPU units, MiB).
- To: two range sliders. The vCPU slider snaps across the 7 fixed Fargate tiers (0.25–16 vCPU); the memory slider snaps across the valid memory options for whichever vCPU tier is selected, displayed in GiB. Selecting a new vCPU tier live re-ranges the memory slider, same cascading behavior the dropdowns already have.
- Reason: matches the user's request for a slider-based picker and makes the valid-value space directly manipulable instead of scanned.
- Impact: non-breaking. Same `cpu`/`memory` data shape and validation; only the input control changes. Applies to both the add-game wizard and the edit-game form, since both already render the same `ResourcesStep` component.

**Live cost estimate**
- From: no cost feedback during game server creation/editing; cost is only visible after the fact on the standalone Costs page.
- To: a live "$X.XXXX/hr while running" estimate rendered beneath the sliders, recomputed on every slider move, using the same hardcoded Fargate pricing constants the Costs page already uses.
- Reason: lets operators see the cost impact of a resource choice before committing to it.
- Impact: non-breaking addition. No new AWS calls (reuses the existing no-Cost-Explorer-API design). The two pricing constants relocate from `@hyveon/cloud-aws` to `@hyveon/shared` so the web renderer can compute the estimate locally without depending on `@hyveon/cloud-aws`.

## Capabilities

### New Capabilities
- `game-resource-picker`: operator selects a game server's vCPU and memory via slider controls constrained to valid AWS Fargate tiers, with cascading vCPU→memory range behavior.

### Modified Capabilities
- `cost-visibility`: extends the existing "free per-game Fargate cost estimates" requirement so a live hourly estimate is also shown inline in the add/edit-game wizard's Resources step, not only on the standalone Costs page.

## Impact

- `app/packages/web/src/components/add-game-wizard/resources-step.component.tsx` — control implementation (dropdowns → sliders), new cost readout.
- `app/packages/shared/src/gameServerValidator.ts` (or a new sibling module) — new `estimateFargateHourlyCost(cpu, memory)` pure function.
- `app/packages/cloud-aws/src/AwsCloudProvider.ts` — `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` relocate to `@hyveon/shared`; this file re-imports them.
- `app/packages/desktop-main/src/services/CostService.ts` — updates its import path for the relocated constants; no behavior change.
- Test files: `resources-step.component.spec` (jsdom), new unit spec for `estimateFargateHourlyCost`.
- `docs/docs/app/` — wizard page gets a short update describing the new control and live estimate.
- No infra, IAM, or deployment-config schema changes — `cpu`/`memory` fields and their AWS-side meaning are unchanged.
