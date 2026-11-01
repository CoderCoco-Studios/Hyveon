import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OverwriteSummary } from '@hyveon/shared/folderUpload';

const apiMock = vi.hoisted(() => ({ folderConfirmOverwrite: vi.fn() }));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

import { OverwriteConfirmation } from './overwrite-confirmation.component.js';

const summary = (overrides: Partial<OverwriteSummary> = {}): OverwriteSummary => ({
  conflictCount: 2,
  identicalCount: 5,
  newCount: 3,
  otherExistingCount: 0,
  samples: [
    { relPath: 'Config/a.json', existingSize: 10, newSize: 2048 },
    { relPath: 'Data/w.db', existingSize: 1000, newSize: 5 },
  ],
  ...overrides,
});

describe('OverwriteConfirmation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMock.folderConfirmOverwrite.mockResolvedValue({ resolved: true });
  });

  // @spec HELPER-OVER-002
  it('should state the counts and list each conflicting path with existing and new sizes', () => {
    render(<OverwriteConfirmation game="minecraft" summary={summary()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '2 files on the volume would be overwritten (5 identical files will be skipped, 3 new).',
    );
    expect(screen.getByText('Config/a.json: 10 B on volume, 2.0 KB new')).toBeInTheDocument();
    expect(screen.getByText('Data/w.db: 1000 B on volume, 5 B new')).toBeInTheDocument();
  });

  // @spec HELPER-OVER-002, HELPER-OVER-008
  it('should singularize one file and mention unrelated existing files and hidden samples', () => {
    render(
      <OverwriteConfirmation
        game="minecraft"
        summary={summary({ conflictCount: 21, identicalCount: 1, otherExistingCount: 4, samples: summary().samples })}
      />,
    );
    expect(screen.getByText(/1 identical file will be skipped/)).toBeInTheDocument();
    expect(screen.getByText(/4 other existing files in the same folders will be left alone/)).toBeInTheDocument();
    expect(screen.getByText('and 19 more')).toBeInTheDocument();
  });

  // @spec HELPER-OVER-003
  it('should confirm the overwrite when Overwrite and upload is pressed', async () => {
    render(<OverwriteConfirmation game="minecraft" summary={summary()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite and upload' }));
    expect(apiMock.folderConfirmOverwrite).toHaveBeenCalledWith('minecraft', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  // @spec HELPER-OVER-004
  it('should decline when Cancel is pressed', async () => {
    render(<OverwriteConfirmation game="minecraft" summary={summary()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiMock.folderConfirmOverwrite).toHaveBeenCalledWith('minecraft', false);
  });

  it('should re-enable the buttons and show an error when the answer cannot be sent', async () => {
    apiMock.folderConfirmOverwrite.mockRejectedValue(new Error('ipc down'));
    render(<OverwriteConfirmation game="minecraft" summary={summary()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite and upload' }));
    expect(await screen.findByText('Could not send your answer; try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overwrite and upload' })).toBeEnabled();
  });
});
