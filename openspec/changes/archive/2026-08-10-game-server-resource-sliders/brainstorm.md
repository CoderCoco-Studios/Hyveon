<!--
Raw capture of superpowers:brainstorming output.
-->

# Background

The add-game wizard's Resources step (`app/packages/web/src/components/add-game-wizard/resources-step.component.tsx`) currently picks a game server's Fargate vCPU and memory via two cascading `<select>` dropdowns:
- CPU select populated from `getFargateCpuOptions()`.
- Memory select populated from `getFargateMemoryOptions(cpu)`, rebuilt whenever CPU changes; disabled until a CPU is chosen.
- Changing CPU resets memory to `null` if the previously-selected memory value is no longer valid for the new CPU tier (`resources-step.component.tsx:36-42`).
- Both option lists are sourced from `@hyveon/shared/gameServerValidator`'s `FARGATE_CPU_MEMORY_TABLE`, so the dropdowns can never offer an invalid pair.
- The same component is reused unmodified by `edit-game-form.component.tsx` (confirmed via `grep -rln "ResourcesStep\|resources-step" app/packages/web/src`), so any change to this one file covers both the add wizard and the edit form.

Cost-estimation math already exists: `CostService.estimateForSpec(cpu, memory)` in `desktop-main`, backed by `FARGATE_VCPU_PER_HOUR` (0.04048) / `FARGATE_GB_PER_HOUR` (0.004445) hardcoded us-east-1 on-demand pricing constants in `@hyveon/cloud-aws/AwsCloudProvider.ts`. It's currently only wired into the standalone Costs page (`app/packages/web/src/pages/costs.page.tsx`), not the wizard. The app makes no live AWS Pricing/Cost Explorer API calls by explicit prior decision (`openspec/changes/remove-cost-explorer-calls`).

User's initial request: replace the picker with a slider for vCPU count and a slider for memory, snapping to whole GiB numbers, with a live estimated cost shown while dragging. User also mentioned "the app has 4096 as a limit," which needed clarification.

# Decision chain

**Q1: What did you mean by "the app has 4096 as a limit"?**
Options offered: (a) no separate app cap — AWS's own table (up to 16 vCPU / 122880 MiB) is the real limit; (b) app should impose a cap at 4 vCPU / 4096 CPU units below AWS's max; (c) something else.
→ **Answered: (a) No separate app cap.** Confirmed via codebase check: `FARGATE_CPU_MEMORY_TABLE` in `gameServerValidator.ts` goes up to 16384 CPU units (16 vCPU); `4096` only appears as a mid-table boundary value and in test fixtures, never as an app-level ceiling. Full AWS range stays in scope.

**Q2: Fargate CPU isn't a continuous 1-16 range — only 7 fixed tiers exist (0.25, 0.5, 1, 2, 4, 8, 16 vCPU). How should the slider handle the two fractional tiers?**
Options offered: (a) keep all 7 tiers, slider shows a fraction at the low end; (b) whole-vCPU only (drop 0.25/0.5, 5 snap points); (c) something else.
→ **Answered: (a) Keep all 7 tiers.** Preserves the two cheapest Fargate options rather than removing them for the sake of "whole number" framing.

**Q3: Memory's valid range AND step size depend on the selected vCPU tier (1 GiB steps at low tiers, 4 GiB steps at 8 vCPU, 8 GiB steps at 16 vCPU, and a fixed 3-value list at 0.25 vCPU). How should the two sliders interact?**
Options offered: (a) cascading, like today's dropdowns — moving vCPU live re-ranges/re-steps memory; (b) independent sliders that silently clamp memory after a vCPU change; (c) something else.
→ **Answered: (a) Cascading**, matching the dropdowns' existing behavior exactly.

**Q4: What should the live cost readout show while dragging?**
Options offered: (a) hourly rate only — "$X/hr while running," no uptime assumptions; (b) full hr/day/month breakdown matching the Costs page (day = hourly×24, month = hourly×4hr/day×30 — bakes in a usage-pattern assumption); (c) something else.
→ **Answered: (a) Hourly rate only.** Simplest, always accurate regardless of how often this operator's game server actually runs (matches Hyveon's on-demand `RunTask`/`StopTask` model, not an always-on service).

**Q5: Does this apply only to the add-game wizard, or also to editing an existing game server's resources?**
Options offered: (a) add wizard only; (b) both add and edit; (c) something else / not sure.
→ **Answered: (b) Both.** Verified afterward that `edit-game-form.component.tsx` already imports and renders the same `ResourcesStep` component with the same `cpu`/`memory` props (`edit-game-form.component.tsx:43,180`) — so this requires no separate work, just confirms scope.

**Visual companion (layout options):** offered and accepted. Two mockups were shown side by side:
- Option A — sliders stacked full-width, cost readout pinned below both, reads top-to-bottom like a form.
- Option B — sliders side by side in a row, cost shown as a distinct highlighted card, more dashboard-like.
→ **Answered: Option A (stacked).**

**Q6: Where should the live cost math run? The pricing constants live in `@hyveon/cloud-aws`, which the web renderer doesn't depend on today.**
Options offered: (a) move the two constants into `@hyveon/shared` (already imported by web) and compute with a plain multiply in the renderer on every slider move — no IPC, no AWS SDK in the web bundle, `cloud-aws` re-imports from `shared` so there's still one source of truth; (b) call desktop-main via IPC per change, keeping constants where they are but adding IPC latency to what's supposed to feel live; (c) something else.
→ **Answered: (a) Move constants to `@hyveon/shared`.**

# Approved design

See `design.md` for the structured writeup. Summary of what was approved:

1. Single component change: `resources-step.component.tsx`. Same props in/out (`cpu`, `memory`, `issues`, `onChange`) — no changes needed in `add-game-wizard.component.tsx`, `edit-game-form.component.tsx`, or `review-step.component.tsx`.
2. vCPU slider: `<input type="range" min=0 max=6 step=1>` indexing into the 7-element tier array from `getFargateCpuOptions()` — not a raw CPU-unit range, since tiers aren't evenly spaced.
3. Memory slider: also an index, into `getFargateMemoryOptions(cpu)` for the current CPU tier — resets to unset when a CPU change invalidates it, same as the second dropdown already does.
4. New `estimateFargateHourlyCost(cpu, memory)` pure function in `@hyveon/shared`; `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` move from `@hyveon/cloud-aws` into `@hyveon/shared`, with `cloud-aws` re-importing them. Cost shown as "$X.XXX/hr while running," recomputed synchronously on every slider input event.
5. Layout: stacked (Option A from the visual mockup).
6. No new error handling — invalid states are structurally impossible by construction (sliders only index into pre-validated arrays).
7. Accessibility: `aria-label`/`aria-valuetext` on both range inputs reflecting the human-readable value, since the underlying `value` is an array index.
8. Testing: update the jsdom component spec to drive `<input type=range>`; add edge-tier cases (0.5 GiB option, 8 GiB step); assert the cost readout; new unit test for `estimateFargateHourlyCost`.
9. Docs: short update to the wizard page under `docs/docs/app/` in the same PR.

Out of scope: changes to the Costs page or `CostService.estimateForSpec` beyond relocating the two constants; any app-imposed cap below AWS's real max; live AWS Pricing API integration.

Scale note: single-component UI change plus a small shared-package refactor — not large enough to warrant PR stacking per `.claude/rules/pr-stacking.md`. Ships as one PR.
