import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './error-boundary.component.js';
import { reportRendererError } from '../lib/report-renderer-error.utils.js';

vi.mock('../lib/report-renderer-error.utils.js', () => ({
  reportRendererError: vi.fn(),
}));

/** A child that throws during render, simulating a crashing subtree. */
function Bomb(): never {
  throw new Error('render exploded');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should render children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>safe content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('safe content')).toBeInTheDocument();
  });

  it('should render the fallback UI when a child throws during render', () => {
    // React logs the caught error to the console during this render; suppress
    // the noise without hiding a genuine assertion failure.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it('should call reportRendererError with the boundary source when a child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(reportRendererError).toHaveBeenCalledWith('render exploded', expect.any(String), 'boundary');

    consoleSpy.mockRestore();
  });
});
