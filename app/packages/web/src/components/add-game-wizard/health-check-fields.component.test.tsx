import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthCheckFields } from './health-check-fields.component.js';
import { createEmptyWizardDraft } from './wizard-form.utils.js';

const TIMEOUT_MESSAGE = 'healthCheck.timeoutMs must be between 100 and 10000 milliseconds inclusive.';

/** Renders the fields for the empty draft with the given validation issues. */
function renderFields(issues: { path: string; message: string }[]) {
  render(
    <HealthCheckFields
      healthCheck={{ ...createEmptyWizardDraft().healthCheck, enabled: true }}
      ports={[]}
      webPort={null}
      issues={issues}
      onChange={vi.fn()}
    />,
  );
}

describe('HealthCheckFields', () => {
  // @spec RT-HEALTH-REDACT-004
  it('should display the timeout issue message beside the timeout input', () => {
    renderFields([{ path: 'healthCheck.timeoutMs', message: TIMEOUT_MESSAGE }]);

    const input = screen.getByLabelText('Timeout (ms)');
    expect(screen.getByText(TIMEOUT_MESSAGE)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  // @spec RT-HEALTH-REDACT-004
  it('should show no timeout message when no issue targets the timeout', () => {
    renderFields([{ path: 'healthCheck.path', message: 'Path is required.' }]);

    expect(screen.queryByText(TIMEOUT_MESSAGE)).not.toBeInTheDocument();
  });
});
