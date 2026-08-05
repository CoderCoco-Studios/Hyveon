import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WizardStepSidebar } from './wizard-step-sidebar.component.js';
import type { WizardStep } from './wizard.utils.js';

const STEPS: readonly WizardStep[] = ['pick-cloud', 'guided-iam', 'credentials', 'bootstrap', 'stack-init'];
const LABELS: Record<WizardStep, string> = {
  'pick-cloud': 'Pick cloud label',
  'guided-iam': 'Guided IAM label',
  credentials: 'Credentials label',
  bootstrap: 'Bootstrap label',
  'stack-init': 'Stack init label',
};

describe('WizardStepSidebar', () => {
  it('should render all five step labels', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    for (const label of Object.values(LABELS)) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('should mark steps before currentIndex as completed', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.getByText(LABELS['pick-cloud']).closest('li')).toHaveAttribute('data-state', 'completed');
    expect(screen.getByText(LABELS['guided-iam']).closest('li')).toHaveAttribute('data-state', 'completed');
  });

  it('should mark the step at currentIndex as current with aria-current', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    const currentItem = screen.getByText(LABELS['credentials']).closest('li');
    expect(currentItem).toHaveAttribute('data-state', 'current');
    expect(currentItem).toHaveAttribute('aria-current', 'step');
  });

  it('should mark steps after currentIndex as upcoming', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.getByText(LABELS['bootstrap']).closest('li')).toHaveAttribute('data-state', 'upcoming');
    expect(screen.getByText(LABELS['stack-init']).closest('li')).toHaveAttribute('data-state', 'upcoming');
  });

  it('should render no interactive step entries', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('should mark no steps as completed when currentIndex is 0', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={0} labels={LABELS} />);

    for (const stepId of STEPS) {
      expect(screen.getByText(LABELS[stepId]).closest('li')).not.toHaveAttribute('data-state', 'completed');
    }
  });

  it('should mark no steps as upcoming when currentIndex is the last step', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={STEPS.length - 1} labels={LABELS} />);

    for (const stepId of STEPS) {
      expect(screen.getByText(LABELS[stepId]).closest('li')).not.toHaveAttribute('data-state', 'upcoming');
    }
  });
});
