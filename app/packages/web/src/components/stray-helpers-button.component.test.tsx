import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({ folderCleanupStrayHelpers: vi.fn() }));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { StrayHelpersButton } from './stray-helpers-button.component.js';

describe('StrayHelpersButton', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should list the helpers it stopped', async () => {
    apiMock.folderCleanupStrayHelpers.mockResolvedValue({
      stopped: [{ game: 'minecraft', taskArn: 'arn:1', ageMinutes: 42 }],
      skipped: 1,
      revokedRules: 2,
      errors: [],
    });
    render(<StrayHelpersButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Clean up stray helpers' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Stopped 1 helper');
    expect(screen.getByText('minecraft (42 min old)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Skipped 1, revoked 2 access rules');
  });

  it('should say when nothing was stray and surface per-item errors', async () => {
    apiMock.folderCleanupStrayHelpers.mockResolvedValue({ stopped: [], skipped: 0, revokedRules: 0, errors: ['stop failed'] });
    render(<StrayHelpersButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Clean up stray helpers' }));
    expect(await screen.findByText('No stray helpers found.')).toBeInTheDocument();
    expect(screen.getByText('stop failed')).toBeInTheDocument();
  });

  it('should show an error banner when the call rejects', async () => {
    apiMock.folderCleanupStrayHelpers.mockRejectedValue(new Error('no credentials'));
    render(<StrayHelpersButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Clean up stray helpers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no credentials');
  });
});
