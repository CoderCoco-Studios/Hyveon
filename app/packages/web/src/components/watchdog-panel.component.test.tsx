import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WatchdogPanel } from './watchdog-panel.component.js';

describe('WatchdogPanel', () => {
  it('should render the Watchdog Settings heading', () => {
    render(<WatchdogPanel />);

    expect(screen.getByText('Watchdog Settings')).toBeInTheDocument();
  });

  it('should point operators at the General section instead of offering its own editor', () => {
    render(<WatchdogPanel />);

    expect(screen.getByText(/configured in the/i)).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('should not render a Save button', () => {
    render(<WatchdogPanel />);

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('should not render any editable inputs', () => {
    render(<WatchdogPanel />);

    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  });
});
