import { CheckCircle2 } from 'lucide-react';

/** A cloud option the pick-cloud step can offer. Only `'aws'` exists for v1. */
export type CloudOption = 'aws';

/** Props for {@link PickCloudStep}. */
export interface PickCloudStepProps {
  /** Currently selected cloud. Locked to `'aws'` for v1. */
  selectedCloud: CloudOption;
  /** Called with the clicked option's id. */
  onSelect: (cloud: CloudOption) => void;
}

/** Static list of selectable cloud options, driving the rendered cards. Only one entry exists in v1. */
const CLOUD_OPTIONS: { id: CloudOption; label: string; description: string }[] = [
  { id: 'aws', label: 'Amazon Web Services (AWS)', description: 'ECS Fargate, EFS, Route 53, DynamoDB, Secrets Manager.' },
];

/**
 * Second step of the first-run wizard: the operator picks which
 * cloud to deploy to. AWS is the only option in v1 — the list-driven
 * rendering and `onSelect` callback keep the step structurally ready for
 * more clouds later without an early redesign.
 */
export function PickCloudStep({ selectedCloud, onSelect }: PickCloudStepProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Choose the cloud provider Hyveon will deploy your game servers to.</p>

      <div className="space-y-3" role="radiogroup" aria-label="Cloud provider">
        {CLOUD_OPTIONS.map((option) => {
          const selected = option.id === selectedCloud;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(option.id)}
              className="w-full flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 text-left transition-colors data-[selected=true]:border-[var(--color-primary)] data-[selected=true]:bg-[var(--color-surface-2)]"
              data-selected={selected}
            >
              {selected ? (
                <CheckCircle2 className="size-5 shrink-0 text-[var(--color-primary)]" />
              ) : (
                <span className="size-5 shrink-0 rounded-full border border-[var(--color-border)]" />
              )}
              <span>
                <span className="block font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">More clouds are coming in a future release.</p>
    </div>
  );
}
