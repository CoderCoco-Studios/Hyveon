import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickCloudStep } from './pick-cloud-step.component.js';

afterEach(() => {
  cleanup();
});

describe('PickCloudStep', () => {
  it('should render the single AWS option', () => {
    render(<PickCloudStep selectedCloud="aws" onSelect={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Amazon Web Services \(AWS\)/i })).toBeInTheDocument();
  });

  it('should mark the AWS option as checked since it is the only choice', () => {
    render(<PickCloudStep selectedCloud="aws" onSelect={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('should render the "more clouds coming" footer', () => {
    render(<PickCloudStep selectedCloud="aws" onSelect={vi.fn()} />);
    expect(screen.getByText(/more clouds are coming/i)).toBeInTheDocument();
  });

  it('should call onSelect with "aws" when the option is clicked', async () => {
    const onSelect = vi.fn();
    render(<PickCloudStep selectedCloud="aws" onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('radio', { name: /Amazon Web Services/i }));

    expect(onSelect).toHaveBeenCalledWith('aws');
  });
});
