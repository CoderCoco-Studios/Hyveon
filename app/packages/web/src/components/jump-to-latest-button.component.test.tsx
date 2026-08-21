import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JumpToLatestButton } from './jump-to-latest-button.component.js';

describe('JumpToLatestButton', () => {
  it('should render nothing when hasNewer is false', () => {
    const { container } = render(<JumpToLatestButton hasNewer={false} onClick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('should render a "Jump to latest" button when hasNewer is true', () => {
    render(<JumpToLatestButton hasNewer onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });

  it('should call onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<JumpToLatestButton hasNewer onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
