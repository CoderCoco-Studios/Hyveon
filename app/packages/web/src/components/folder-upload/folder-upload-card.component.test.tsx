import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FolderUploadProgress } from '@hyveon/shared/folderUpload';

const apiMock = vi.hoisted(() => ({
  statusGame: vi.fn(),
  volumeSessionStop: vi.fn(),
  folderPick: vi.fn(),
  folderRescan: vi.fn(),
  folderGetSelection: vi.fn(),
  folderSetSelection: vi.fn(),
  folderStartUpload: vi.fn(),
  folderCancelUpload: vi.fn(),
  folderGetProgress: vi.fn(),
  folderOnProgress: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

import { FolderUploadCard } from './folder-upload-card.component.js';
import { makeProgress, makeScan } from './folder-upload.test-utils.js';

const VOLUMES = [{ name: 'data', container_path: '/data' }];
const STORED = { localPath: '/src/FoundryVTT', include: ['Config', 'Data'], destination: '/data' };

let pushProgress: (p: FolderUploadProgress) => void;
const unsubscribe = vi.fn();

/** Renders the card with a stored, restorable selection by default. */
function setup(props: Partial<{ deployed: boolean }> = {}) {
  return render(<FolderUploadCard game="minecraft" volumes={VOLUMES} deployed={props.deployed ?? true} />);
}

describe('FolderUploadCard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMock.statusGame.mockResolvedValue({ game: 'minecraft', state: 'stopped' });
    apiMock.folderGetSelection.mockResolvedValue(STORED);
    apiMock.folderRescan.mockResolvedValue(makeScan());
    apiMock.folderSetSelection.mockResolvedValue({ saved: true });
    apiMock.folderGetProgress.mockResolvedValue(null);
    apiMock.folderStartUpload.mockResolvedValue({ started: true, runId: 'r1' });
    apiMock.folderOnProgress.mockImplementation((cb: (p: FolderUploadProgress) => void) => {
      pushProgress = cb;
      return unsubscribe;
    });
  });

  // @spec HELPER-SAFE-004
  it('should start the upload with the restored selection', async () => {
    setup();
    const button = screen.getByRole('button', { name: 'Upload folder' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(apiMock.folderStartUpload).toHaveBeenCalledWith({
      game: 'minecraft',
      scanId: 'scan-1',
      include: ['Config', 'Data'],
      destination: '/data',
    });
  });

  // @spec HELPER-UPLOAD-004
  it('should disable upload with an explanation when the game is not deployed, keeping the selection', async () => {
    setup({ deployed: false });
    expect(await screen.findByRole('checkbox', { name: 'Include Config' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Upload folder' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('not been deployed');
  });

  // @spec HELPER-UPLOAD-006
  it('should disable upload with an explanation while the server is running', async () => {
    apiMock.statusGame.mockResolvedValue({ game: 'minecraft', state: 'running' });
    setup();
    expect(await screen.findByText(/server is running/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload folder' })).toBeDisabled();
  });

  it('should disable upload when nothing is selected', async () => {
    apiMock.folderGetSelection.mockResolvedValue({ ...STORED, include: [] });
    setup();
    await screen.findByRole('checkbox', { name: 'Include Config' });
    expect(screen.getByRole('button', { name: 'Upload folder' })).toBeDisabled();
  });

  it('should show a guard failure from the start result', async () => {
    apiMock.folderStartUpload.mockResolvedValue({ started: false, error: 'scan expired' });
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Upload folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('scan expired');
  });

  // @spec HELPER-UPLOAD-011
  it('should stop the orphaned session and retry the upload', async () => {
    apiMock.folderStartUpload
      .mockResolvedValueOnce({ started: false, error: "A file manager session is already open for 'minecraft'. Restart it, then retry." })
      .mockResolvedValueOnce({ started: true, runId: 'r1' });
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: { game: 'minecraft', state: 'stopped' } });
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Upload folder' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(apiMock.volumeSessionStop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop session and upload' }));
    await waitFor(() => expect(apiMock.folderStartUpload).toHaveBeenCalledTimes(2));
    expect(apiMock.volumeSessionStop).toHaveBeenCalledWith('minecraft');
  });

  it('should show the stop failure and not retry the upload when stopping the orphaned session fails', async () => {
    apiMock.folderStartUpload.mockResolvedValue({ started: false, error: "A file manager session is already open for 'minecraft'. Restart it, then retry." });
    apiMock.volumeSessionStop.mockResolvedValue({ ok: false, code: 'failed', message: 'Could not stop the session.' });
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Upload folder' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop session and upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not stop the session.');
    expect(apiMock.folderStartUpload).toHaveBeenCalledTimes(1);
  });

  // @spec HELPER-PROG-001
  it('should follow pushed progress and lock the controls during a run', async () => {
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    act(() => pushProgress(makeProgress()));
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('button', { name: 'Upload folder' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Include Config' })).toBeDisabled();
  });

  it('should ignore progress for another game', async () => {
    setup();
    await waitFor(() => expect(apiMock.folderOnProgress).toHaveBeenCalled());
    act(() => pushProgress(makeProgress({ game: 'valheim' })));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('should resume a run already in flight when reopened', async () => {
    apiMock.folderGetProgress.mockResolvedValue(makeProgress({ bytesDone: 750 }));
    setup();
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
    expect(apiMock.folderGetProgress).toHaveBeenCalledWith('minecraft');
  });

  // @spec HELPER-SAFE-004, HELPER-PROG-006
  it('should restart from the persisted selection after the app restarts mid-run', async () => {
    apiMock.folderGetSelection.mockResolvedValue({
      ...STORED,
      lastRun: { status: 'failed', completedAt: '2026-10-01T10:00:00Z', files: 600, bytes: 2048 },
    });
    setup();
    const resume = await screen.findByRole('button', { name: 'Resume upload' });
    await waitFor(() => expect(resume).toBeEnabled());
    await userEvent.click(resume);
    expect(apiMock.folderStartUpload).toHaveBeenCalledWith(expect.objectContaining({ game: 'minecraft', scanId: 'scan-1' }));
  });

  it('should keep Resume disabled when the saved folder cannot be rescanned', async () => {
    apiMock.folderGetSelection.mockResolvedValue({
      ...STORED,
      lastRun: { status: 'cancelled', completedAt: '2026-10-01T10:00:00Z', files: 1, bytes: 1 },
    });
    apiMock.folderRescan.mockResolvedValue(null);
    setup();
    expect(await screen.findByRole('button', { name: 'Resume upload' })).toBeDisabled();
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });

  // @spec HELPER-RESUME-005
  it('should resume a failed run through the same start path', async () => {
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    act(() => pushProgress(makeProgress({ phase: 'failed', error: 'connection reset' })));
    const resume = await screen.findByRole('button', { name: 'Resume upload' });
    await waitFor(() => expect(resume).toBeEnabled());
    await userEvent.click(resume);
    expect(apiMock.folderStartUpload).toHaveBeenCalledTimes(1);
  });

  it('should refresh the persisted last run when a run settles', async () => {
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload folder' })).toBeEnabled());
    apiMock.folderGetSelection.mockClear();
    act(() => pushProgress(makeProgress({ phase: 'done', bytesDone: 1000 })));
    await waitFor(() => expect(apiMock.folderGetSelection).toHaveBeenCalledWith('minecraft'));
  });

  it('should unsubscribe from progress on unmount', async () => {
    const { unmount } = setup();
    await waitFor(() => expect(apiMock.folderOnProgress).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
