import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import type { VolumeLike } from '@hyveon/shared/folderUpload';

const apiMock = vi.hoisted(() => ({
  folderPick: vi.fn(),
  folderRescan: vi.fn(),
  folderGetSelection: vi.fn(),
  folderSetSelection: vi.fn(),
  folderClearSelection: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

import type { FolderSeedState } from './use-folder-seed.hook.js';
import { FolderSeedSection } from './folder-seed-section.component.js';
import { useFolderSeed } from './use-folder-seed.hook.js';
import { makeScan } from './folder-upload.test-utils.js';

const VOLUMES: VolumeLike[] = [{ name: 'data', container_path: '/data' }];

/** Mounts the section over a real {@link useFolderSeed}. */
function Harness({ game = 'minecraft' }: { game?: string }) {
  const seed = useFolderSeed({ game, volumes: VOLUMES });
  const [shown] = useState(true);
  return shown ? <FolderSeedSection seed={seed} volumes={VOLUMES} /> : null;
}

describe('FolderSeedSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMock.folderGetSelection.mockResolvedValue(null);
    apiMock.folderRescan.mockResolvedValue(null);
    apiMock.folderSetSelection.mockResolvedValue({ saved: true });
    apiMock.folderClearSelection.mockResolvedValue(undefined);
  });

  // @spec HELPER-SELECT-001
  it('should offer only a picker before a folder is chosen', async () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Destination in container')).not.toBeInTheDocument();
  });

  // @spec HELPER-SELECT-002, HELPER-SAFE-003
  it('should include everything by default, default the destination, and persist the selection', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(await screen.findByLabelText('Destination in container')).toHaveValue('/data');
    expect(screen.getByRole('checkbox', { name: 'Include Config' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include Data' })).toBeChecked();
    expect(apiMock.folderSetSelection).toHaveBeenCalledWith({
      game: 'minecraft',
      scanId: 'scan-1',
      include: ['Config', 'Data'],
      destination: '/data',
    });
  });

  // @spec HELPER-SAFE-001
  it('should summarize the selection and note skipped links', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    const summary = await screen.findByTestId('folder-seed-summary');
    expect(summary).toHaveTextContent('3 files selected, 1.0 KB of 3 files');
    expect(summary).toHaveTextContent('1 symbolic link will be skipped.');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Data' }));
    expect(summary).toHaveTextContent('2 files selected, 30 B');
  });

  // @spec HELPER-SELECT-005
  it('should report a destination outside every volume and not persist it', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    const field = await screen.findByLabelText('Destination in container');
    apiMock.folderSetSelection.mockClear();
    await userEvent.clear(field);
    await userEvent.type(field, '/etc');
    expect(await screen.findByRole('alert')).toHaveTextContent('inside one of the game volume paths');
    expect(apiMock.folderSetSelection).not.toHaveBeenCalled();
  });

  // @spec HELPER-SELECT-005
  it('should reject a destination containing parent-directory segments', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    const field = await screen.findByLabelText('Destination in container');
    await userEvent.clear(field);
    await userEvent.type(field, '/data/../etc');
    expect(await screen.findByRole('alert')).toHaveTextContent('without ".."');
  });

  // @spec HELPER-SAFE-004
  it('should restore the persisted selection and a live scan on mount', async () => {
    apiMock.folderGetSelection.mockResolvedValue({ localPath: '/x', include: ['Config'], destination: '/data/cfg' });
    apiMock.folderRescan.mockResolvedValue(makeScan());
    render(<Harness />);
    expect(await screen.findByLabelText('Destination in container')).toHaveValue('/data/cfg');
    expect(screen.getByRole('checkbox', { name: 'Include Config' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include Data' })).not.toBeChecked();
  });

  it('should not persist while the game has no name yet', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness game="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    await screen.findByLabelText('Destination in container');
    await waitFor(() => expect(apiMock.folderSetSelection).not.toHaveBeenCalled());
  });

  it('should show an error when picking fails', async () => {
    apiMock.folderPick.mockRejectedValue(new Error('dialog exploded'));
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('dialog exploded');
  });

  describe('discardPersisted', () => {
    /** Mounts the hook alongside the section and exposes its latest state. */
    function mountWithHandle() {
      const handle: { current: FolderSeedState | null } = { current: null };
      function Probe() {
        const seed = useFolderSeed({ game: 'minecraft', volumes: VOLUMES });
        useEffect(() => {
          handle.current = seed;
        });
        return <FolderSeedSection seed={seed} volumes={VOLUMES} />;
      }
      render(<Probe />);
      return handle;
    }

    it('should wait for a pending save and clear it when the wizard closes mid-save', async () => {
      let finishSave: () => void = () => undefined;
      apiMock.folderSetSelection.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
      apiMock.folderPick.mockResolvedValue(makeScan());
      const handle = mountWithHandle();
      await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
      await waitFor(() => expect(apiMock.folderSetSelection).toHaveBeenCalled());

      let discarded = false;
      const discard = handle.current!.discardPersisted().then(() => { discarded = true; });
      act(() => handle.current!.reset());
      await Promise.resolve();
      expect(apiMock.folderClearSelection).not.toHaveBeenCalled();
      expect(discarded).toBe(false);

      await act(async () => {
        finishSave();
        await discard;
      });
      expect(apiMock.folderClearSelection).toHaveBeenCalledWith('minecraft');
    });

    it('should keep a name tracked when its clear fails so a later discard retries it', async () => {
      apiMock.folderPick.mockResolvedValue(makeScan());
      apiMock.folderClearSelection.mockRejectedValueOnce(new Error('disk busy'));
      const handle = mountWithHandle();
      await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
      await waitFor(() => expect(apiMock.folderSetSelection).toHaveBeenCalled());

      await act(async () => handle.current!.discardPersisted());
      expect(apiMock.folderClearSelection).toHaveBeenCalledTimes(1);

      await act(async () => handle.current!.discardPersisted());
      expect(apiMock.folderClearSelection).toHaveBeenCalledTimes(2);

      await act(async () => handle.current!.discardPersisted());
      expect(apiMock.folderClearSelection).toHaveBeenCalledTimes(2);
    });

    it('should not clear a persisted selection on a generic reset alone', async () => {
      apiMock.folderPick.mockResolvedValue(makeScan());
      const handle = mountWithHandle();
      await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
      await waitFor(() => expect(apiMock.folderSetSelection).toHaveBeenCalled());
      act(() => handle.current!.reset());
      expect(apiMock.folderClearSelection).not.toHaveBeenCalled();
    });
  });
});
