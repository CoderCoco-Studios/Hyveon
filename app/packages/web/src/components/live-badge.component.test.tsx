import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveBadge } from './live-badge.component.js';

describe('LiveBadge', () => {
  it('should read Live when neither paused nor historical', () => {
    render(<LiveBadge paused={false} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('should read Paused when paused in live mode', () => {
    render(<LiveBadge paused />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  // @spec APP-LOGS-UI-008
  it('should read Historical while browsing history, whether or not paused', () => {
    const { rerender } = render(<LiveBadge paused={false} historical />);
    expect(screen.getByText('Historical')).toBeInTheDocument();
    rerender(<LiveBadge paused historical />);
    expect(screen.getByText('Historical')).toBeInTheDocument();
  });
});
