import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({ folderCancelUpload: vi.fn(), folderConfirmOverwrite: vi.fn() }));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

import { FolderUploadProgressMeter } from './folder-upload-progress-meter.component.js';
import { makeProgress } from './folder-upload.test-utils.js';

describe('FolderUploadProgressMeter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMock.folderCancelUpload.mockResolvedValue({ cancelled: true });
    apiMock.folderConfirmOverwrite.mockResolvedValue({ resolved: true });
  });

  it('should render nothing without a snapshot or a last run', () => {
    const { container } = render(<FolderUploadProgressMeter game="minecraft" progress={null} onRestart={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('should show only a starting-helper phase with no percent while the helper launches', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'starting-helper', bytesDone: 0 })} onRestart={vi.fn()} />);
    expect(screen.getByText('Starting helper')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('should show percent, bytes, files, current file, rate and ETA while uploading', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress()} onRestart={vi.fn()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('500 B of 1000 B')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Data/w.db')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB/s')).toBeInTheDocument();
    expect(screen.getByText('1m 05s')).toBeInTheDocument();
  });

  it('should hold the bar at 99% until verification completes', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'verifying', bytesDone: 1000 })} onRestart={vi.fn()} />);
    expect(screen.getByText('Verifying')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
  });

  it('should show 100% and a verified summary when done', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'done', bytesDone: 1000 })} onRestart={vi.fn()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('status')).toHaveTextContent('Upload verified: 3 files, 1000 B.');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('should cancel through the bridge', async () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress()} onRestart={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiMock.folderCancelUpload).toHaveBeenCalledWith('minecraft');
  });

  it('should offer Resume with the error when the run failed', async () => {
    const onRestart = vi.fn();
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'failed', error: 'connection reset' })} onRestart={onRestart} />);
    expect(screen.getByRole('alert')).toHaveTextContent('connection reset');
    await userEvent.click(screen.getByRole('button', { name: 'Resume upload' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('should list missing and mismatched paths and offer Retry on a verification failure', () => {
    render(
      <FolderUploadProgressMeter
        game="minecraft"
        progress={makeProgress({ phase: 'failed', error: 'Verification failed: Data/w.db (missing), Config/a.json (size mismatch)' })}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText('Data/w.db (missing)')).toBeInTheDocument();
    expect(screen.getByText('Config/a.json (size mismatch)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry upload' })).toBeInTheDocument();
  });

  it('should offer Resume after a cancel', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'cancelled' })} onRestart={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeEnabled();
  });

  it('should disable Resume when restart is not allowed', () => {
    render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'failed', error: 'x' })} onRestart={vi.fn()} restartDisabled />);
    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeDisabled();
  });

  it('should report each settled run once', () => {
    const onSettled = vi.fn();
    const { rerender } = render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'done' })} onRestart={vi.fn()} onSettled={onSettled} />);
    rerender(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'done' })} onRestart={vi.fn()} onSettled={onSettled} />);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('done');
  });

  it('should show the persisted last run with Resume when no run exists in this session', async () => {
    const onRestart = vi.fn();
    render(
      <FolderUploadProgressMeter
        game="minecraft"
        progress={null}
        lastRun={{ status: 'failed', completedAt: '2026-10-01T10:00:00Z', files: 600, bytes: 2048 }}
        onRestart={onRestart}
      />,
    );
    expect(screen.getByTestId('folder-upload-last-run')).toHaveTextContent('600 files, 2.0 KB');
    await userEvent.click(screen.getByRole('button', { name: 'Resume upload' }));
    expect(onRestart).toHaveBeenCalled();
  });

  it('should show a completed last run without a Resume action', () => {
    render(
      <FolderUploadProgressMeter
        game="minecraft"
        progress={null}
        lastRun={{ status: 'done', completedAt: '2026-10-01T10:00:00Z', files: 3, bytes: 1030 }}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('folder-upload-last-run')).toHaveTextContent('completed');
    expect(screen.queryByRole('button', { name: 'Resume upload' })).not.toBeInTheDocument();
  });

  describe('awaiting confirmation', () => {
    const overwrite = {
      conflictCount: 1,
      identicalCount: 2,
      newCount: 3,
      otherExistingCount: 0,
      samples: [{ relPath: 'Data/w.db', existingSize: 1, newSize: 1000 }],
    };

    it('should show the overwrite warning with a single Cancel that declines instead of the plain cancel', async () => {
      render(
        <FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'awaiting-confirmation', bytesDone: 0, overwrite })} onRestart={vi.fn()} />,
      );
      expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
      expect(screen.getByRole('alertdialog')).toHaveTextContent('1 file on the volume would be overwritten');
      expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(apiMock.folderConfirmOverwrite).toHaveBeenCalledWith('minecraft', false);
      expect(apiMock.folderCancelUpload).not.toHaveBeenCalled();
    });

    it('should fall back to the plain Cancel when the snapshot carries no summary', () => {
      render(<FolderUploadProgressMeter game="minecraft" progress={makeProgress({ phase: 'awaiting-confirmation', bytesDone: 0 })} onRestart={vi.fn()} />);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    });

    it('should explain a confirmation timeout in the cancelled state', () => {
      render(
        <FolderUploadProgressMeter
          game="minecraft"
          progress={makeProgress({ phase: 'cancelled', error: 'Timed out waiting for overwrite confirmation' })}
          onRestart={vi.fn()}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Timed out waiting for overwrite confirmation. Cancelled.');
    });
  });
});
