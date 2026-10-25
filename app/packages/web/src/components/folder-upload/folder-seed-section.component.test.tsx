import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { VolumeLike } from '@hyveon/shared/folderUpload';

const apiMock = vi.hoisted(() => ({
  folderPick: vi.fn(),
  folderRescan: vi.fn(),
  folderGetSelection: vi.fn(),
  folderSetSelection: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

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
  });

  it('should offer only a picker before a folder is chosen', async () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Destination in container')).not.toBeInTheDocument();
  });

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

  it('should reject a destination containing parent-directory segments', async () => {
    apiMock.folderPick.mockResolvedValue(makeScan());
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    const field = await screen.findByLabelText('Destination in container');
    await userEvent.clear(field);
    await userEvent.type(field, '/data/../etc');
    expect(await screen.findByRole('alert')).toHaveTextContent('without ".."');
  });

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
});
