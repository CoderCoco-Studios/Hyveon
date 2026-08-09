# Game Server Resource Sliders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the add-game wizard's / edit-game form's cpu/memory `<select>` dropdowns with index-based range sliders that can only land on valid AWS Fargate tiers, plus a live hourly cost readout.

**Architecture:** Add a pure `estimateFargateHourlyCost` function and relocate the two Fargate pricing constants into `@hyveon/shared/gameServerValidator` (already the single source of truth for the Fargate cpu/memory tier table). `@hyveon/cloud-aws` re-exports the constants so `CostService` needs no changes. Rewrite `ResourcesStep` to drive two `<input type="range">` elements by array index into `getFargateCpuOptions()`/`getFargateMemoryOptions(cpu)`, preserving the existing cascading reset behavior, and render the new cost estimate from the relocated function.

**Tech Stack:** TypeScript, React, Vitest + Testing Library (jsdom), Zod (unchanged), NestJS (unchanged, `CostService`/`AwsCloudProvider` only get an import-source change).

## Global Constraints

- No `as unknown as T` casts in tests — use `vi.mocked(fn)` / `Partial<T> as T` per `CLAUDE.md`.
- Test names read as "should ..." sentences.
- TSDoc comments on non-trivial functions and notable constants, following `.claude/rules/tsdoc-tags.md` (summary → `@remarks`/`@example` if any → `@param` in order → `@returns`; `@param name - description` hyphen form).
- Run `npm run app:lint` after writing/editing any TSDoc comment.
- Working directory for every command below is the repo root of this worktree: `/home/chris/GitHub/Hyveon/.claude/worktrees/game-server-resource-sliders`. `npm install` has already been run here.
- No infra, deployment-config, or IPC surface changes in this plan — `npm run app:test:e2e` is not required by `CLAUDE.md`'s pre-PR gate, but Task 5 still runs the full gate to confirm.

---

## Task 1: Fargate pricing constants + `estimateFargateHourlyCost` in `@hyveon/shared`

**Files:**
- Modify: `app/packages/shared/src/gameServerValidator.ts` (add near `FARGATE_CPU_MEMORY_TABLE`, after `getFargateMemoryOptions`)
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Produces: `export const FARGATE_VCPU_PER_HOUR: number` (`0.04048`), `export const FARGATE_GB_PER_HOUR: number` (`0.004445`), `export function estimateFargateHourlyCost(cpu: number, memory: number): number`.

- [ ] **Step 1: Write the failing tests**

Add to `app/packages/shared/src/gameServerValidator.test.ts` (new `describe` block, alongside the existing `validateGameServer`/`getFargateCpuOptions` tests):

```ts
import {
  validateGameServer,
  getFargateCpuOptions,
  getFargateMemoryOptions,
  estimateFargateHourlyCost,
  FARGATE_VCPU_PER_HOUR,
  FARGATE_GB_PER_HOUR,
} from './gameServerValidator.js';

// ... existing imports/helpers stay as-is ...

describe('estimateFargateHourlyCost', () => {
  it('should compute the Fargate hourly cost for 1 vCPU + 2 GiB', () => {
    // 1 * 0.04048 + 2 * 0.004445 = 0.04937
    expect(estimateFargateHourlyCost(1024, 2048)).toBeCloseTo(0.0494, 4);
  });

  it('should scale linearly with cpu and memory', () => {
    const half = estimateFargateHourlyCost(512, 1024);
    const full = estimateFargateHourlyCost(1024, 2048);
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it('should round to at most 4 decimal places', () => {
    const cost = estimateFargateHourlyCost(256, 512);
    const decimals = cost.toString().split('.')[1] ?? '';
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it('should compute the correct cost for every Fargate vCPU tier at its minimum valid memory', () => {
    for (const cpu of getFargateCpuOptions()) {
      const memory = getFargateMemoryOptions(cpu)[0]!;
      const expected =
        Math.round(((cpu / 1024) * FARGATE_VCPU_PER_HOUR + (memory / 1024) * FARGATE_GB_PER_HOUR) * 10000) / 10000;
      expect(estimateFargateHourlyCost(cpu, memory)).toBe(expected);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- gameServerValidator.test.ts`
Expected: FAIL — `estimateFargateHourlyCost`, `FARGATE_VCPU_PER_HOUR`, `FARGATE_GB_PER_HOUR` are not exported from `./gameServerValidator.js`.

- [ ] **Step 3: Implement the constants and function**

In `app/packages/shared/src/gameServerValidator.ts`, insert directly after the `getFargateMemoryOptions` function (after line 209 in the current file, before `describeFargateMemoryOptions`):

```ts
/**
 * Fargate on-demand price per vCPU-hour (us-east-1). `@hyveon/cloud-aws`
 * re-exports this single copy (via `AwsCloudProvider.ts`) instead of
 * declaring its own — keep every call site in sync by only ever editing the
 * value here.
 */
export const FARGATE_VCPU_PER_HOUR = 0.04048;

/** Fargate on-demand price per GB-hour (us-east-1), see {@link FARGATE_VCPU_PER_HOUR}. */
export const FARGATE_GB_PER_HOUR = 0.004445;

/**
 * Projected hourly Fargate cost for a `cpu`/`memory` pairing, in USD.
 *
 * Pure arithmetic, safe to call on every UI event (e.g. a slider drag) with
 * no debounce. Uses the same formula and rounding as
 * `CostService.estimateForSpec`'s `costPerHour` field, so the wizard's live
 * estimate and the Costs page's per-game table never disagree for the same
 * (cpu, memory) pair.
 *
 * @param cpu - Fargate CPU units (1024 = 1 vCPU).
 * @param memory - Task memory in MiB.
 * @returns The estimated hourly cost in USD, rounded to at most 4 decimal places.
 */
export function estimateFargateHourlyCost(cpu: number, memory: number): number {
  const vcpu = cpu / 1024;
  const memoryGb = memory / 1024;
  const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memoryGb * FARGATE_GB_PER_HOUR;
  return Math.round(hourly * 10000) / 10000;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- gameServerValidator.test.ts`
Expected: PASS, all tests in the file including the new `estimateFargateHourlyCost` block.

- [ ] **Step 5: Commit**

```bash
git add app/packages/shared/src/gameServerValidator.ts app/packages/shared/src/gameServerValidator.test.ts
git commit -m "feat(shared): add Fargate pricing constants and hourly cost estimator"
```

---

## Task 2: Relocate `@hyveon/cloud-aws`'s pricing constants to re-export from `@hyveon/shared`

**Files:**
- Modify: `app/packages/cloud-aws/src/AwsCloudProvider.ts:22-30`
- Test: `app/packages/cloud-aws/src/AwsCloudProvider.test.ts` (add one import-surface test; find the exact existing test file name first if it differs — grep `find app/packages/cloud-aws/src -iname "*AwsCloudProvider*test*"`)
- No change expected to: `app/packages/desktop-main/src/services/CostService.ts` (keeps importing `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` from `@hyveon/cloud-aws`, which now re-exports them)

**Interfaces:**
- Consumes: `FARGATE_VCPU_PER_HOUR`, `FARGATE_GB_PER_HOUR` from `@hyveon/shared` (Task 1).
- Produces: `@hyveon/cloud-aws` still exports `FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR` at the same import path (`@hyveon/cloud-aws`), now as a re-export rather than a local declaration — no consumer-visible change.

- [ ] **Step 1: Write the failing test**

First confirm the real test file name:

```bash
find app/packages/cloud-aws/src -iname "*AwsCloudProvider*test*"
```

Add a test to that file (create `app/packages/cloud-aws/src/AwsCloudProvider.test.ts` with just this block if no such file exists yet):

```ts
import { describe, it, expect } from 'vitest';
import { FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR } from './AwsCloudProvider.js';
import {
  FARGATE_VCPU_PER_HOUR as SHARED_VCPU_PER_HOUR,
  FARGATE_GB_PER_HOUR as SHARED_GB_PER_HOUR,
} from '@hyveon/shared/gameServerValidator';

describe('AwsCloudProvider pricing constants', () => {
  it('should re-export the same Fargate pricing constants as @hyveon/shared', () => {
    expect(FARGATE_VCPU_PER_HOUR).toBe(SHARED_VCPU_PER_HOUR);
    expect(FARGATE_GB_PER_HOUR).toBe(SHARED_GB_PER_HOUR);
  });
});
```

- [ ] **Step 2: Run the test to verify it currently passes for the wrong reason, then make the change**

This test will pass even before the change (both constants currently have the same values, just declared independently in two places) — it's a regression guard, not a red/green TDD gate. Run it once now to confirm it passes against the *current* (duplicated) constants:

Run: `npm run app:test -- AwsCloudProvider.test.ts`
Expected: PASS (duplicated values currently match by coincidence — the test exists to keep them locked together going forward).

- [ ] **Step 3: Replace the local declarations with a re-export**

In `app/packages/cloud-aws/src/AwsCloudProvider.ts`, replace lines 22-30:

```ts
/**
 * Fargate on-demand price per vCPU-hour (us-east-1). Exported so
 * `CostService.estimateForSpec` (`app/packages/desktop-main/src/services/CostService.ts`)
 * imports this single copy instead of hardcoding its own — keep both call
 * sites in sync by only ever editing the value here.
 */
export const FARGATE_VCPU_PER_HOUR = 0.04048;
/** Fargate on-demand price per GB-hour (us-east-1), see {@link FARGATE_VCPU_PER_HOUR}. */
export const FARGATE_GB_PER_HOUR = 0.004445;
```

with:

```ts
/**
 * Fargate on-demand pricing constants (us-east-1). Re-exported here from
 * `@hyveon/shared` — which owns them alongside the Fargate cpu/memory tier
 * table — so `CostService.estimateForSpec`
 * (`app/packages/desktop-main/src/services/CostService.ts`) and this file's
 * own {@link AwsCloudProvider.estimateHourlyCost} keep importing from
 * `@hyveon/cloud-aws` unchanged.
 */
export { FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR } from '@hyveon/shared';
```

- [ ] **Step 4: Run the test again to confirm it still passes**

Run: `npm run app:test -- AwsCloudProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full cloud-aws and desktop-main suites to confirm nothing else broke**

Run: `npm run app:test -- AwsCloudProvider CostService`
Expected: PASS — `CostService.test.ts`'s existing assertions (`toBeCloseTo(0.0494, 4)` etc.) are unaffected since the constant values themselves didn't change, only where they're declared.

- [ ] **Step 6: Commit**

```bash
git add app/packages/cloud-aws/src/AwsCloudProvider.ts app/packages/cloud-aws/src/AwsCloudProvider.test.ts
git commit -m "refactor(cloud-aws): re-export Fargate pricing constants from @hyveon/shared"
```

---

## Task 3: Rewrite `ResourcesStep` as index-based sliders with a live cost readout

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/resources-step.component.tsx` (full rewrite of the component body; props interface unchanged)
- Test: `app/packages/web/src/components/add-game-wizard/resources-step.component.test.tsx` (full rewrite of the interaction assertions; issue-surfacing tests stay conceptually the same)

**Interfaces:**
- Consumes: `getFargateCpuOptions()`, `getFargateMemoryOptions(cpu)`, `estimateFargateHourlyCost(cpu, memory)`, all from `@hyveon/shared/gameServerValidator` (Task 1).
- Produces: same exported `ResourcesStep(props: Props)` component and `ResourcesStepChange` interface as before — `add-game-wizard.component.tsx` and `edit-game-form.component.tsx` need no prop-shape changes, only their own tests' interaction code changes (Task 4).

- [ ] **Step 1: Write the failing tests (full replacement of the test file)**

Replace the full contents of `app/packages/web/src/components/add-game-wizard/resources-step.component.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { getFargateCpuOptions, getFargateMemoryOptions } from '@hyveon/shared/gameServerValidator';
import { ResourcesStep } from './resources-step.component.js';

describe('ResourcesStep', () => {
  it('should render the vCPU slider with one snap point per Fargate cpu tier', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    const cpuSlider = screen.getByLabelText('vCPU') as HTMLInputElement;
    expect(cpuSlider.min).toBe('0');
    expect(cpuSlider.max).toBe(String(getFargateCpuOptions().length - 1));
  });

  it('should only offer Fargate-valid memory pairings for the selected cpu (256 -> 512/1024/2048 MiB)', () => {
    render(<ResourcesStep cpu={256} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySlider = screen.getByLabelText('Memory') as HTMLInputElement;
    expect(memorySlider.max).toBe('2'); // 3 values: indices 0, 1, 2
    expect(memorySlider.disabled).toBe(false);
  });

  it('should disable the memory slider when no cpu is selected', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySlider = screen.getByLabelText('Memory') as HTMLInputElement;
    expect(memorySlider.disabled).toBe(true);
  });

  it('should call onChange with the cpu unit at the dragged vCPU index', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={null} memory={null} onChange={onChange} issues={[]} />);

    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.change(cpuSlider, { target: { value: String(cpuOptions.indexOf(256)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: null });
  });

  it('should reset memory to unset when a cpu change makes the current memory value invalid', () => {
    const onChange = vi.fn();
    // cpu=256/memory=512 is a valid pairing; cpu=512 does not accept 512 MiB.
    render(<ResourcesStep cpu={256} memory={512} onChange={onChange} issues={[]} />);

    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.change(cpuSlider, { target: { value: String(cpuOptions.indexOf(512)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 512, memory: null });
  });

  it('should keep the current memory value when a cpu change still supports it', () => {
    const onChange = vi.fn();
    // cpu=512/memory=2048 is valid; cpu=1024 also accepts 2048.
    render(<ResourcesStep cpu={512} memory={2048} onChange={onChange} issues={[]} />);

    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.change(cpuSlider, { target: { value: String(cpuOptions.indexOf(1024)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 1024, memory: 2048 });
  });

  it('should call onChange with the memory value at the dragged memory index', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={256} memory={null} onChange={onChange} issues={[]} />);

    const memoryOptions = getFargateMemoryOptions(256);
    const memorySlider = screen.getByLabelText('Memory');
    fireEvent.change(memorySlider, { target: { value: String(memoryOptions.indexOf(1024)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: 1024 });
  });

  it('should handle the 0.25 vCPU tier fixed 3-value memory list including the 0.5 GiB option', () => {
    render(<ResourcesStep cpu={256} memory={512} onChange={() => undefined} issues={[]} />);

    expect(screen.getByText('0.5 GiB')).toBeInTheDocument();
  });

  it('should handle the 16 vCPU tier 8 GiB memory step', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={16384} memory={32768} onChange={onChange} issues={[]} />);

    const memoryOptions = getFargateMemoryOptions(16384);
    expect(memoryOptions[1] - memoryOptions[0]).toBe(8192); // 8 GiB in MiB
    const memorySlider = screen.getByLabelText('Memory');
    fireEvent.change(memorySlider, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalledWith({ cpu: 16384, memory: memoryOptions[1] });
  });

  it('should show a live hourly cost estimate matching estimateFargateHourlyCost', async () => {
    const { estimateFargateHourlyCost } = await import('@hyveon/shared/gameServerValidator');
    render(<ResourcesStep cpu={1024} memory={2048} onChange={() => undefined} issues={[]} />);

    const expected = estimateFargateHourlyCost(1024, 2048);
    expect(screen.getByText(`$${expected.toFixed(4)}/hr while running`)).toBeInTheDocument();
  });

  it('should prompt for a selection instead of showing a cost when cpu or memory is unset', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    expect(screen.getByText('Select vCPU and memory to see cost')).toBeInTheDocument();
  });

  it('should surface a cpu validation issue beneath the vCPU slider', () => {
    render(
      <ResourcesStep
        cpu={100}
        memory={512}
        onChange={() => undefined}
        issues={[{ path: 'cpu', message: 'cpu must be one of the supported Fargate CPU units.' }]}
      />,
    );

    expect(screen.getByText('cpu must be one of the supported Fargate CPU units.')).toBeInTheDocument();
  });

  it('should surface a memory validation issue beneath the memory slider', () => {
    render(
      <ResourcesStep
        cpu={256}
        memory={1536}
        onChange={() => undefined}
        issues={[{ path: 'memory', message: 'memory 1536 MiB is not a valid Fargate pairing for cpu=256.' }]}
      />,
    );

    expect(
      screen.getByText('memory 1536 MiB is not a valid Fargate pairing for cpu=256.'),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- resources-step.component.test.tsx`
Expected: FAIL — `getByLabelText('vCPU')`/`getByLabelText('Memory')` find nothing (current labels are "CPU (vCPU units)"/"Memory (MiB)" on `<select>` elements, not `<input type="range">`).

- [ ] **Step 3: Rewrite the component**

Replace the full contents of `app/packages/web/src/components/add-game-wizard/resources-step.component.tsx`:

```tsx
import {
  getFargateCpuOptions,
  getFargateMemoryOptions,
  estimateFargateHourlyCost,
  type GameServerValidationIssue,
} from '@hyveon/shared/gameServerValidator';

/** Updates the "Resources" step emits — always both fields, since a cpu change may also reset memory. */
export interface ResourcesStepChange {
  cpu: number | null;
  memory: number | null;
}

interface Props {
  cpu: number | null;
  memory: number | null;
  onChange: (change: ResourcesStepChange) => void;
  issues: GameServerValidationIssue[];
}

/** Formats a Fargate cpu-unit value as a vCPU count, e.g. `256` -> `"0.25 vCPU"`, `2048` -> `"2 vCPU"`. */
function formatVcpu(cpuUnits: number): string {
  return `${cpuUnits / 1024} vCPU`;
}

/** Formats a MiB memory value in GiB, e.g. `512` -> `"0.5 GiB"`, `4096` -> `"4 GiB"`. */
function formatGib(memoryMib: number): string {
  return `${memoryMib / 1024} GiB`;
}

/**
 * "Resources" step of the add-game wizard (#99) and edit-game form: vCPU and
 * memory are picked via two range sliders, each holding an *index* into
 * {@link getFargateCpuOptions}/{@link getFargateMemoryOptions} rather than a
 * raw cpu-unit/MiB value — Fargate's tiers aren't evenly spaced (vCPU:
 * 0.25/0.5/1/2/4/8/16) and the valid memory step size itself varies by cpu
 * tier, so indexing into the same enumerated, pre-validated arrays the
 * previous dropdowns used guarantees every reachable slider position is a
 * valid Fargate pairing by construction. Selecting a new cpu tier resets
 * memory back to unset if the current memory value isn't valid for the new
 * tier, exactly as the previous dropdowns did. A live hourly cost estimate
 * renders below both sliders, recomputed on every change.
 */
export function ResourcesStep({ cpu, memory, onChange, issues }: Props) {
  const cpuOptions = getFargateCpuOptions();
  const memoryOptions = cpu !== null ? getFargateMemoryOptions(cpu) : [];

  const cpuIndex = cpu !== null ? cpuOptions.indexOf(cpu) : -1;
  const memoryIndex = memory !== null ? memoryOptions.indexOf(memory) : -1;

  const cpuError = issues.find((issue) => issue.path === 'cpu')?.message;
  const memoryError = issues.find((issue) => issue.path === 'memory')?.message;

  const hourlyCost = cpu !== null && memory !== null ? estimateFargateHourlyCost(cpu, memory) : null;

  /** Applies a new cpu index, resetting `memory` to unset if it isn't a valid pairing for the new cpu. */
  function handleCpuIndexChange(rawIndex: string) {
    const nextCpu = cpuOptions[Number(rawIndex)] ?? null;
    const validMemories = nextCpu !== null ? getFargateMemoryOptions(nextCpu) : [];
    const nextMemory = memory !== null && validMemories.includes(memory) ? memory : null;
    onChange({ cpu: nextCpu, memory: nextMemory });
  }

  function handleMemoryIndexChange(rawIndex: string) {
    const nextMemory = memoryOptions[Number(rawIndex)] ?? null;
    onChange({ cpu, memory: nextMemory });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="wizard-resources-cpu" className="text-sm font-medium text-[var(--color-foreground)]">
          vCPU
        </label>
        <input
          id="wizard-resources-cpu"
          type="range"
          min={0}
          max={cpuOptions.length - 1}
          step={1}
          value={cpuIndex >= 0 ? cpuIndex : 0}
          onChange={(e) => handleCpuIndexChange(e.target.value)}
          aria-invalid={cpuError ? 'true' : 'false'}
          aria-describedby={cpuError ? 'wizard-resources-cpu-error' : undefined}
          aria-valuetext={cpu !== null ? formatVcpu(cpu) : 'not selected'}
          className="w-56"
        />
        <div className="flex justify-between text-xs text-[var(--color-muted-foreground)]">
          {cpuOptions.map((option) => (
            <span key={option}>{formatVcpu(option)}</span>
          ))}
        </div>
        <p className="text-sm text-[var(--color-foreground)]">{cpu !== null ? formatVcpu(cpu) : 'Select vCPU'}</p>
        {cpuError && (
          <p id="wizard-resources-cpu-error" role="alert" className="text-sm text-[var(--color-red)]">
            {cpuError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="wizard-resources-memory" className="text-sm font-medium text-[var(--color-foreground)]">
          Memory
        </label>
        <input
          id="wizard-resources-memory"
          type="range"
          min={0}
          max={Math.max(memoryOptions.length - 1, 0)}
          step={1}
          value={memoryIndex >= 0 ? memoryIndex : 0}
          onChange={(e) => handleMemoryIndexChange(e.target.value)}
          disabled={cpu === null}
          aria-invalid={memoryError ? 'true' : 'false'}
          aria-describedby={memoryError ? 'wizard-resources-memory-error' : undefined}
          aria-valuetext={memory !== null ? formatGib(memory) : 'not selected'}
          className="w-56 disabled:opacity-50"
        />
        <p className="text-sm text-[var(--color-foreground)]">
          {memory !== null ? formatGib(memory) : 'Select memory'}
        </p>
        {memoryError && (
          <p id="wizard-resources-memory-error" role="alert" className="text-sm text-[var(--color-red)]">
            {memoryError}
          </p>
        )}
      </div>

      <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-foreground)]">
        {hourlyCost !== null ? `$${hourlyCost.toFixed(4)}/hr while running` : 'Select vCPU and memory to see cost'}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- resources-step.component.test.tsx`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/resources-step.component.tsx app/packages/web/src/components/add-game-wizard/resources-step.component.test.tsx
git commit -m "feat(web): replace Resources step dropdowns with sliders and a live cost estimate"
```

---

## Task 4: Fix the add-game wizard's end-to-end test to drive the new sliders

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx:50-51`

**Interfaces:**
- Consumes: `getFargateCpuOptions()`, `getFargateMemoryOptions(cpu)` from `@hyveon/shared/gameServerValidator` (already used elsewhere in this plan; import at the top of the test file if not already imported).

- [ ] **Step 1: Confirm this is the only other broken call site**

```bash
grep -rn "wizard-resources-cpu\|wizard-resources-memory\|CPU (vCPU units)\|Memory (MiB)\|getByLabelText(/CPU/i)\|getByLabelText(/Memory/i)" app/packages/web/src --include="*.test.tsx"
```

Expected output: only `resources-step.component.test.tsx` (rewritten in Task 3) and `add-game-wizard.component.test.tsx:50-51`. If any other file appears, add an equivalent fix step here before proceeding.

- [ ] **Step 2: Run the current test to see it fail against the new component**

Run: `npm run app:test -- add-game-wizard.component.test.tsx`
Expected: FAIL at line 50 — `userEvent.selectOptions` throws because `screen.getByLabelText(/CPU/i)` now resolves to an `<input type="range">`, which `selectOptions` doesn't support (and the accessible name changed from "CPU (vCPU units)" to "vCPU", so `getByLabelText(/CPU/i)` may also stop matching — check the actual failure message from this run before editing).

- [ ] **Step 3: Replace the two interaction lines**

At `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx:50-51`, replace:

```ts
  await userEvent.selectOptions(screen.getByLabelText(/CPU/i), '256');
  await userEvent.selectOptions(screen.getByLabelText(/Memory/i), '512');
```

with:

```ts
  const cpuOptions = getFargateCpuOptions();
  fireEvent.change(screen.getByLabelText('vCPU'), { target: { value: String(cpuOptions.indexOf(256)) } });
  const memoryOptions = getFargateMemoryOptions(256);
  fireEvent.change(screen.getByLabelText('Memory'), { target: { value: String(memoryOptions.indexOf(512)) } });
```

Add the two new imports at the top of the file (next to the existing `@testing-library/react` import, adding `fireEvent` to that import if `render`/`screen` are already imported from there):

```ts
import { getFargateCpuOptions, getFargateMemoryOptions } from '@hyveon/shared/gameServerValidator';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run app:test -- add-game-wizard.component.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx
git commit -m "test(web): drive the add-game wizard's resource sliders instead of selects"
```

---

## Task 5: Full verification gate and docs update

**Files:**
- Modify: `docs/docs/app/` — locate the page documenting the add-game wizard steps (`grep -rln "Resources step\|ResourcesStep\|add-game wizard" docs/docs/app/`) and add a short paragraph describing the slider control and live cost estimate.

- [ ] **Step 1: Run the full pre-PR gate**

```bash
npm run app:lint
npm run app:typecheck
npm run app:test
```

Expected: all three exit 0. Fix any failure before proceeding — do not skip or silence a failing check.

- [ ] **Step 2: Confirm no IPC/renderer/preload surface changed**

```bash
git diff --stat main...HEAD -- app/packages/desktop-preload app/packages/desktop-main/src/controllers
```

Expected: empty output (no IPC channel or preload bridge touched by this change) — confirms `npm run app:test:e2e` is not required by `CLAUDE.md`'s "when the renderer, preload bridge, or IPC surface changed" rule. If this shows any output, run `npm run app:test:e2e` too and fix any failure before proceeding.

- [ ] **Step 3: Update the wizard docs page**

```bash
grep -rln "Resources step\|ResourcesStep\|add-game wizard" docs/docs/app/
```

Open the matched file and add 1-2 sentences describing: vCPU and memory are now chosen via sliders snapping to valid AWS Fargate tiers (not free values), and a live estimated hourly cost is shown as either slider moves. Match the existing page's tone and heading structure — do not restructure the page.

- [ ] **Step 4: Commit the docs update**

```bash
git add docs/docs/app/
git commit -m "docs(app): document the Resources step slider control and live cost estimate"
```

- [ ] **Step 5: Sync the OpenSpec change's delta specs into the main specs**

This project's OpenSpec artifacts for this change live at `openspec/changes/game-server-resource-sliders/`. Once the above is verified working, fold the delta specs into `openspec/specs/` per `CLAUDE.md`'s "OpenSpec — if required behaviour changed, the change's delta specs must be synced" rule:

```bash
openspec status game-server-resource-sliders
```

Confirm `verify`/`retrospective` (or whichever artifacts this schema still expects before archive) are either not required or completed, then run `/opsx:sync` (or the equivalent `openspec` command it wraps) to merge `specs/game-resource-picker/spec.md` and the `cost-visibility` delta into `openspec/specs/`.

- [ ] **Step 6: Open the PR**

This is a single, reviewable-sized change (one component rewrite, one shared-package addition, one relocation, doc update) — ships as one PR per `.claude/rules/pr-stacking.md`, not a stack. Use the `/pr` command from the repo's workflow (validates the Conventional Commits title before calling the GitHub API) once on the feature branch with all commits from Tasks 1-5.
