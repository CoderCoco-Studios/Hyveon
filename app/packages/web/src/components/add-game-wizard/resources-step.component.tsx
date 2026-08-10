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

/** Formats a Fargate cpu-unit value as a vCPU count, e.g. `256` -\> `"0.25 vCPU"`, `2048` -\> `"2 vCPU"`. */
function formatVcpu(cpuUnits: number): string {
  return `${cpuUnits / 1024} vCPU`;
}

/** Formats a MiB memory value in GiB, e.g. `512` -\> `"0.5 GiB"`, `4096` -\> `"4 GiB"`. */
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

  // A range input must always render some numeric position, but "unset" has no
  // natural index, so both sliders fall back to index 0 while unset. That
  // fallback would normally risk a same-value no-op: a real drag/keypress
  // landing on the already-rendered fallback position doesn't change the
  // string value, so a controlled input's onChange never fires. The
  // onPointerUp/onKeyUp handlers below close that gap by explicitly
  // committing the slider's current rendered position on interaction, so a
  // same-value landing is applied immediately instead of silently dropped —
  // which is what makes a single shared, uncontroversial fallback of 0 safe
  // for both sliders.
  const unsetCpuIndex = 0;
  const unsetMemoryIndex = 0;

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
          value={cpuIndex >= 0 ? cpuIndex : unsetCpuIndex}
          onChange={(e) => handleCpuIndexChange(e.target.value)}
          onPointerUp={(e) => {
            if (cpu === null) handleCpuIndexChange(e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            if (cpu === null) handleCpuIndexChange(e.currentTarget.value);
          }}
          aria-invalid={cpuError ? 'true' : 'false'}
          aria-describedby={cpuError ? 'wizard-resources-cpu-error' : undefined}
          aria-valuetext={cpu !== null ? formatVcpu(cpu) : 'not selected'}
          className={`w-full ${cpu === null ? 'opacity-50' : ''}`}
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
          value={memoryIndex >= 0 ? memoryIndex : unsetMemoryIndex}
          onChange={(e) => handleMemoryIndexChange(e.target.value)}
          onPointerUp={(e) => {
            if (memory === null) handleMemoryIndexChange(e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            if (memory === null) handleMemoryIndexChange(e.currentTarget.value);
          }}
          disabled={cpu === null}
          aria-invalid={memoryError ? 'true' : 'false'}
          aria-describedby={memoryError ? 'wizard-resources-memory-error' : undefined}
          aria-valuetext={memory !== null ? formatGib(memory) : 'not selected'}
          className={`w-full disabled:opacity-50 ${memory === null ? 'opacity-50' : ''}`}
        />
        {memoryOptions.length > 0 && (
          <div className="flex justify-between text-xs text-[var(--color-muted-foreground)]">
            <span>{formatGib(memoryOptions[0])}</span>
            <span>{formatGib(memoryOptions[memoryOptions.length - 1])}</span>
          </div>
        )}
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
