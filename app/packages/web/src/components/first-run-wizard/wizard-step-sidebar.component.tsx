import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils.utils';
import type { WizardStep } from './wizard.utils.js';

/** Props for {@link WizardStepSidebar}. */
export interface WizardStepSidebarProps {
  /** Steps in display order, e.g. `WIZARD_STEPS`. */
  steps: readonly WizardStep[];
  /** Index into `steps` of the step currently shown. */
  currentIndex: number;
  /** Human-readable label per step id. */
  labels: Record<WizardStep, string>;
}

/**
 * Non-interactive progress list for the first-run wizard shell.
 *
 * @remarks
 * Shown alongside step content at the `md:` breakpoint and above. Has no
 * click handlers or interactive roles: wizard navigation is strictly
 * linear (`goNext`/`goBack` only), so this communicates progress — it is
 * not a navigation control.
 *
 * @param props - {@link WizardStepSidebarProps}
 */
export function WizardStepSidebar({ steps, currentIndex, labels }: WizardStepSidebarProps) {
  return (
    <nav aria-label="Wizard progress" className="hidden md:block w-64 shrink-0">
      <ol className="space-y-1">
        {steps.map((stepId, index) => {
          const state = index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'upcoming';
          return (
            <li
              key={stepId}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm',
                state === 'current' && 'bg-[var(--color-surface-2)] font-medium text-foreground',
                state === 'completed' && 'text-muted-foreground',
                state === 'upcoming' && 'text-muted-foreground/50',
              )}
            >
              {state === 'completed' ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--color-green)]" />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px]">
                  {index + 1}
                </span>
              )}
              {labels[stepId]}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
