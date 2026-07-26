import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrerequisitesStep } from './prerequisites-step.component.js';
import type { PrerequisitesReport } from '@hyveon/desktop-preload';

/** Stubs `navigator.userAgent` for the duration of one test so OS-specific instructions are deterministic. */
function stubUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
}

const SATISFIED: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

afterEach(() => {
  cleanup();
});

describe('PrerequisitesStep', () => {
  it('should show a checking message before the first report resolves', () => {
    render(<PrerequisitesStep report={null} checking={true} error={null} onRecheck={vi.fn()} />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it('should render both tools as found with their versions when satisfied', () => {
    render(<PrerequisitesStep report={SATISFIED} checking={false} error={null} onRecheck={vi.fn()} />);
    expect(screen.getByText('Found v1.9.0')).toBeInTheDocument();
    expect(screen.getByText('Found v2.15.30')).toBeInTheDocument();
  });

  it('should render "Not found" plus install instructions and a vendor link for a missing tool', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const report: PrerequisitesReport = { terraform: { found: false }, aws: SATISFIED.aws };
    render(<PrerequisitesStep report={report} checking={false} error={null} onRecheck={vi.fn()} />);

    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.getByText(/brew install hashicorp\/tap\/terraform/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /install guide/i })).toHaveAttribute(
      'href',
      'https://developer.hashicorp.com/terraform/install',
    );
  });

  it('should show per-platform instructions matching the detected OS', () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const report: PrerequisitesReport = { terraform: { found: false }, aws: SATISFIED.aws };
    render(<PrerequisitesStep report={report} checking={false} error={null} onRecheck={vi.fn()} />);

    expect(screen.getByText(/winget install Hashicorp.Terraform/)).toBeInTheDocument();
  });

  it('should warn when a found tool is below the minimum version', () => {
    const report: PrerequisitesReport = {
      terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.2.0', minimumVersionSatisfied: false },
      aws: SATISFIED.aws,
    };
    render(<PrerequisitesStep report={report} checking={false} error={null} onRecheck={vi.fn()} />);

    expect(screen.getByText(/below the minimum supported version/i)).toBeInTheDocument();
  });

  it('should render the error message when detection itself fails', () => {
    render(<PrerequisitesStep report={null} checking={false} error="IPC bridge unavailable" onRecheck={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('IPC bridge unavailable');
  });

  it('should call onRecheck when the Re-check button is clicked', async () => {
    const onRecheck = vi.fn();
    render(<PrerequisitesStep report={SATISFIED} checking={false} error={null} onRecheck={onRecheck} />);

    await userEvent.click(screen.getByRole('button', { name: /re-check/i }));

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('should disable the Re-check button while a check is in flight', () => {
    render(<PrerequisitesStep report={SATISFIED} checking={true} error={null} onRecheck={vi.fn()} />);
    expect(screen.getByRole('button', { name: /re-check/i })).toBeDisabled();
  });
});
