import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import type { VolumeEntryInfo, VolumeSessionStatus, VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import type { FolderUploadProgress } from '../api.service.js';
import { makeDirEntry, makeFileEntry, makeSessionStatus, makeTransfer } from '../components/volume-files/volume-files.test-utils.js';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusGame: vi.fn(),
  costsEstimate: vi.fn(),
  volumeSessionStatus: vi.fn(),
  volumeSessionStart: vi.fn(),
  volumeSessionAttach: vi.fn(),
  volumeSessionDetach: vi.fn(),
  volumeSessionStop: vi.fn(),
  volumeSessionRestart: vi.fn(),
  volumeList: vi.fn(),
  volumeMkdir: vi.fn(),
  volumeRename: vi.fn(),
  volumeRemove: vi.fn(),
  volumeReadText: vi.fn(),
  volumeWriteText: vi.fn(),
  volumeDownload: vi.fn(),
  volumeCancelTransfer: vi.fn(),
  volumeUploadFiles: vi.fn(),
  volumeUploadDropped: vi.fn(),
  volumeUploadFolder: vi.fn(),
  volumeOnSession: vi.fn(),
  volumeOnTransfer: vi.fn(),
  folderGetProgress: vi.fn(),
  folderOnProgress: vi.fn(),
  folderCancelUpload: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { VolumeFilesPage } from './volume-files.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const GAME = 'mc';
const FILES_ROUTE = '/games/mc/files';

let pushSession: (status: VolumeSessionStatus) => void;
let pushTransfer: (progress: VolumeTransferProgress) => void;
let pushFolderProgress: (progress: FolderUploadProgress) => void;

/** Builds a session status for the `mc` game. */
function session(overrides: Partial<VolumeSessionStatus> = {}): VolumeSessionStatus {
  return makeSessionStatus({ game: GAME, volumes: [{ name: 'config', containerPath: '/config', mounted: true }], ...overrides });
}

/** Resolves attach and status with `status`. */
function mockSession(status: VolumeSessionStatus) {
  apiMock.volumeSessionAttach.mockResolvedValue(status);
  apiMock.volumeSessionStatus.mockResolvedValue(status);
}

/** Resolves `volumeList` from a path → entries map; unknown paths are empty. */
function mockListings(byPath: Record<string, VolumeEntryInfo[]>) {
  apiMock.volumeList.mockImplementation(async (_game: string, _volume: string, path: string) => ({
    ok: true,
    value: { path, entries: byPath[path] ?? [] },
  }));
}

/** Makes `api.status` / `api.statusGame` report the game's server in `state`. */
function mockServerState(state: 'stopped' | 'running' | 'starting' | 'error') {
  apiMock.status.mockResolvedValue([{ game: GAME, state }]);
  apiMock.statusGame.mockResolvedValue({ game: GAME, state });
}

/** Renders the page at the files route, with optional router state. */
function renderFiles(state?: { autoStart: boolean }) {
  const initialEntries = state ? [{ pathname: FILES_ROUTE, state }] : [FILES_ROUTE];
  return renderPage(
    <Routes>
      <Route path="/games/:name/files" element={<VolumeFilesPage />} />
    </Routes>,
    { initialEntries },
  );
}

/** Names of the table's body rows in display order. */
function rowNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
}

beforeEach(() => {
  vi.resetAllMocks();
  mockServerState('stopped');
  apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
  mockSession(session());
  mockListings({ '/': [makeFileEntry('a.txt', 10)] });
  apiMock.volumeSessionDetach.mockResolvedValue(session());
  apiMock.volumeOnSession.mockImplementation((cb: (status: VolumeSessionStatus) => void) => {
    pushSession = cb;
    return () => undefined;
  });
  // The page and the browser each subscribe, so a push fans out to every listener.
  const transferListeners = new Set<(progress: VolumeTransferProgress) => void>();
  pushTransfer = (progress) => transferListeners.forEach((listener) => listener(progress));
  apiMock.volumeOnTransfer.mockImplementation((cb: (progress: VolumeTransferProgress) => void) => {
    transferListeners.add(cb);
    return () => transferListeners.delete(cb);
  });
  apiMock.folderGetProgress.mockResolvedValue(null);
  apiMock.folderOnProgress.mockImplementation((cb: (progress: FolderUploadProgress) => void) => {
    pushFolderProgress = cb;
    return () => undefined;
  });
});

describe('VolumeFilesPage', () => {
  it('should show session state without starting a helper when opened directly', async () => {
    mockSession(session({ state: 'stopped' }));

    renderFiles();

    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(apiMock.volumeSessionStart).not.toHaveBeenCalled();
  });

  it('should start the session when arriving from the dashboard Files action', async () => {
    mockSession(session({ state: 'stopped' }));
    apiMock.volumeSessionStart.mockResolvedValue(session({ state: 'starting' }));

    renderFiles({ autoStart: true });

    await waitFor(() => expect(apiMock.volumeSessionStart).toHaveBeenCalledTimes(1));
    expect(apiMock.volumeSessionStart).toHaveBeenCalledWith(GAME);
  });

  it('should start the session on arrival when the last session failed', async () => {
    mockSession(session({ state: 'failed', error: 'Could not launch.' }));
    apiMock.volumeSessionStart.mockResolvedValue(session({ state: 'starting' }));

    renderFiles({ autoStart: true });

    await waitFor(() => expect(apiMock.volumeSessionStart).toHaveBeenCalledTimes(1));
  });

  it('should reuse a running session instead of starting another on arrival', async () => {
    renderFiles({ autoStart: true });

    expect(await screen.findByText('a.txt')).toBeInTheDocument();
    expect(apiMock.volumeSessionStart).not.toHaveBeenCalled();
  });

  it('should navigate into a folder and update the breadcrumb', async () => {
    mockListings({ '/': [makeDirEntry('world')], '/world': [makeFileEntry('level.dat')] });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'world' }));

    expect(await screen.findByText('level.dat')).toBeInTheDocument();
    expect(apiMock.volumeList).toHaveBeenCalledWith(GAME, 'config', '/world');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('button', { name: 'config' })).toBeInTheDocument();
    expect(within(breadcrumb).getByText('world')).toBeInTheDocument();
  });

  it('should sort by size when the size header is clicked', async () => {
    mockListings({ '/': [makeFileEntry('a.txt', 50), makeFileEntry('b.txt', 5), makeFileEntry('c.txt', 20)] });
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('a.txt');
    expect(rowNames()).toEqual(['a.txt', 'b.txt', 'c.txt']);

    await user.click(screen.getByRole('button', { name: /^Size/ }));

    expect(rowNames()).toEqual(['b.txt', 'c.txt', 'a.txt']);
    await user.click(screen.getByRole('button', { name: /^Size/ }));
    expect(rowNames()).toEqual(['a.txt', 'c.txt', 'b.txt']);
  });

  it('should render an unknown modified time as a dash instead of 1970', async () => {
    mockListings({ '/': [makeFileEntry('a.txt', 10, 0)] });

    renderFiles();

    const row = (await screen.findByText('a.txt')).closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/1970/);
  });

  it('should disable mutating actions while the server is running', async () => {
    mockServerState('running');
    mockListings({ '/': [makeFileEntry('a.txt')] });
    renderFiles();

    expect(await screen.findByText('The server is running. Stop it to change files.')).toBeInTheDocument();

    for (const name of ['New folder', 'Upload files', 'Upload folder', 'Rename a.txt', 'Delete a.txt']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'The server is running. Stop it to change files.');
    }
    expect(screen.getByRole('button', { name: 'Download a.txt' })).toBeEnabled();
  });

  it('should disable mutating actions and offer Retry when the server state can not be confirmed', async () => {
    apiMock.volumeMkdir.mockResolvedValue({ ok: false, code: 'server-check-failed', message: 'Could not check.' });
    const user = userEvent.setup();
    renderFiles();
    await user.click(await screen.findByRole('button', { name: 'New folder' }));
    await user.type(screen.getByLabelText('Folder name'), 'saves');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText("Couldn't confirm the server is stopped.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(apiMock.statusGame).toHaveBeenCalledWith(GAME));
    await waitFor(() => expect(screen.queryByText("Couldn't confirm the server is stopped.")).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'New folder' })).toBeEnabled();
  });

  it('should show the read-only banner when a mutation reports the server is running', async () => {
    apiMock.volumeRemove.mockResolvedValue({ ok: false, code: 'server-running', message: 'The server is running.' });
    const user = userEvent.setup();
    renderFiles();
    await user.click(await screen.findByRole('button', { name: 'Delete a.txt' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('The server is running. Stop it to change files.')).toBeInTheDocument();
  });

  it('should explain an unconfirmed state when the game status is an error', async () => {
    mockServerState('error');

    renderFiles();

    expect(await screen.findByText("Couldn't confirm the server is stopped.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
  });

  it('should list the selected volume when the operator switches volumes', async () => {
    mockSession(
      session({
        volumes: [
          { name: 'config', containerPath: '/config', mounted: true },
          { name: 'saves', containerPath: '/saves', mounted: true },
        ],
      }),
    );
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('a.txt');

    await user.selectOptions(screen.getByLabelText('Volume'), 'saves');

    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledWith(GAME, 'saves', '/'));
  });

  it('should show an unapplied volume as unavailable', async () => {
    mockSession(
      session({
        volumes: [
          { name: 'config', containerPath: '/config', mounted: true },
          { name: 'mods', containerPath: '/mods', mounted: false },
        ],
      }),
    );

    renderFiles();

    const option = await screen.findByRole('option', { name: /mods/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent('Apply the infrastructure to browse this volume.');
    expect(screen.getByLabelText('Volume')).toHaveValue('config');
  });

  it('should label a legacy volume with an empty name as the default volume', async () => {
    mockSession(session({ volumes: [{ name: '', containerPath: '', mounted: true }] }));

    renderFiles();

    expect(await screen.findByRole('option', { name: 'Default volume' })).toBeInTheDocument();
    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledWith(GAME, '', '/'));
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Default volume')).toBeInTheDocument();
  });

  it('should keep an entry with an unusable name listed but disable every action that needs its path', async () => {
    mockListings({ '/': [makeFileEntry('a\\b.txt'), makeDirEntry('bad\\dir'), makeFileEntry('ok.txt')] });
    renderFiles();

    expect(await screen.findByText('a\\b.txt')).toBeInTheDocument();

    for (const name of ['Download a\\b.txt', 'Edit a\\b.txt', 'Rename a\\b.txt', 'Delete a\\b.txt', 'Download bad\\dir', 'Rename bad\\dir', 'Delete bad\\dir']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining("can't be handled here"));
    }
    expect(screen.getByRole('button', { name: 'bad\\dir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit ok.txt' })).toBeEnabled();
  });

  it('should confirm before deleting a folder with folder wording', async () => {
    mockListings({ '/': [makeDirEntry('world')] });
    apiMock.volumeRemove.mockResolvedValue({ ok: true, value: true });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Delete world' }));

    expect(await screen.findByText('Delete world and everything in it?')).toBeInTheDocument();
    expect(apiMock.volumeRemove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(apiMock.volumeRemove).toHaveBeenCalledWith(GAME, 'config', '/world'));
  });

  it('should confirm before deleting a file with file wording', async () => {
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Delete a.txt' }));

    expect(await screen.findByText('Delete a.txt?')).toBeInTheDocument();
  });

  it('should reject an invalid name in the name dialog before submitting', async () => {
    const user = userEvent.setup();
    renderFiles();
    await user.click(await screen.findByRole('button', { name: 'New folder' }));

    await user.type(screen.getByLabelText('Folder name'), 'a/b');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByText("Names can't be empty, . or .., contain / or \\, or be longer than 255 bytes.")).toBeInTheDocument();
    expect(apiMock.volumeMkdir).not.toHaveBeenCalled();
  });

  it('should rename an entry from the name dialog', async () => {
    apiMock.volumeRename.mockResolvedValue({ ok: true, value: makeFileEntry('b.txt') });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Rename a.txt' }));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'b.txt');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(apiMock.volumeRename).toHaveBeenCalledWith(GAME, 'config', '/a.txt', 'b.txt'));
  });

  it('should keep edits and show a conflict on save', async () => {
    apiMock.volumeReadText.mockResolvedValue({ ok: true, value: { path: '/a.txt', content: 'hello', modifiedMs: 5 } });
    apiMock.volumeWriteText.mockResolvedValue({ ok: false, code: 'conflict', message: 'The file changed on disk.' });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Edit a.txt' }));
    const textarea = await screen.findByRole('textbox', { name: 'File contents' });
    await waitFor(() => expect(textarea).toHaveValue('hello'));
    await user.clear(textarea);
    await user.type(textarea, 'edited');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The file changed on disk.')).toBeInTheDocument();
    expect(textarea).toHaveValue('edited');
    expect(apiMock.volumeWriteText).toHaveBeenCalledWith(GAME, 'config', '/a.txt', 'edited', 5);
    expect(screen.getAllByText('The file changed on disk.')).toHaveLength(1);
  });

  it('should offer a download when the file can not be edited here', async () => {
    apiMock.volumeReadText.mockResolvedValue({ ok: false, code: 'binary', message: 'Binary file.' });
    apiMock.volumeDownload.mockResolvedValue({ ok: true, value: null });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Edit a.txt' }));

    expect(await screen.findByText("This file can't be edited here. Download it instead.")).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(apiMock.volumeDownload).toHaveBeenCalledWith(GAME, 'config', '/a.txt', false));
  });

  it('should not offer Edit for a file larger than the editor limit', async () => {
    mockListings({ '/': [makeFileEntry('big.bin', 2_000_000)] });

    renderFiles();

    await screen.findByText('big.bin');
    expect(screen.queryByRole('button', { name: 'Edit big.bin' })).not.toBeInTheDocument();
  });

  it('should offer only Restart for an orphaned session', async () => {
    mockSession(session({ state: 'orphaned' }));

    renderFiles();

    expect(await screen.findByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('should show the stop reason and offer Start for a failed session', async () => {
    mockSession(session({ state: 'failed', error: 'The helper exited.' }));

    renderFiles();

    expect(await screen.findByText('The helper exited.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });

  it('should confirm before stopping a session with a running upload', async () => {
    mockSession(session({ uploadHolders: 1 }));
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: session({ state: 'stopped' }) });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('This cancels the running transfer.')).toBeInTheDocument();
    expect(apiMock.volumeSessionStop).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => expect(apiMock.volumeSessionStop).toHaveBeenCalledWith(GAME));
  });

  it('should confirm before stopping a session with a running download', async () => {
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: session({ state: 'stopped' }) });
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('a.txt');

    pushTransfer(makeTransfer({ game: GAME, transferId: 'd1', kind: 'download', name: 'world.zip' }));
    await screen.findByRole('button', { name: 'Cancel world.zip' });
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('This cancels the running transfer.')).toBeInTheDocument();
    expect(apiMock.volumeSessionStop).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => expect(apiMock.volumeSessionStop).toHaveBeenCalledWith(GAME));
  });

  it('should stop without confirming once the download has finished', async () => {
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: session({ state: 'stopped' }) });
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('a.txt');

    pushTransfer(makeTransfer({ game: GAME, transferId: 'd1', kind: 'download', name: 'world.zip' }));
    await screen.findByRole('button', { name: 'Cancel world.zip' });
    pushTransfer(makeTransfer({ game: GAME, transferId: 'd1', kind: 'download', name: 'world.zip', phase: 'done' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel world.zip' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(apiMock.volumeSessionStop).toHaveBeenCalledWith(GAME));
    expect(screen.queryByText('This cancels the running transfer.')).not.toBeInTheDocument();
  });

  it('should stop an idle session without confirming', async () => {
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: session({ state: 'stopped' }) });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(apiMock.volumeSessionStop).toHaveBeenCalledWith(GAME));
  });

  it('should explain a not-deployed volume and offer no actions', async () => {
    mockSession(session({ state: 'not_deployed', volumes: [] }));

    renderFiles();

    expect(await screen.findByText("This game's volume doesn't exist yet. Apply the infrastructure first.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
  });

  it('should warn when fewer than ten minutes remain before auto-stop', async () => {
    mockSession(session({ startedAt: new Date(Date.now() - 60_000).toISOString(), autoStopAt: new Date(Date.now() + 5 * 60_000).toISOString() }));

    renderFiles();

    expect(await screen.findByText(/stops automatically soon/)).toBeInTheDocument();
  });

  it('should not warn when more than ten minutes remain before auto-stop', async () => {
    mockSession(session({ startedAt: new Date().toISOString(), autoStopAt: new Date(Date.now() + 30 * 60_000).toISOString() }));

    renderFiles();

    await screen.findByText(/Auto-stop in/);
    expect(screen.queryByText(/stops automatically soon/)).not.toBeInTheDocument();
  });

  it('should hide folder download when the backend has no archive support', async () => {
    mockSession(session({ supportsArchive: false }));
    mockListings({ '/': [makeDirEntry('world'), makeFileEntry('a.txt')] });

    renderFiles();

    await screen.findByText('a.txt');
    expect(screen.queryByRole('button', { name: 'Download world' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download a.txt' })).toBeInTheDocument();
  });

  it('should download a folder when the backend supports archives', async () => {
    mockListings({ '/': [makeDirEntry('world')] });
    apiMock.volumeDownload.mockResolvedValue({ ok: true, value: { transferId: 't' } });
    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole('button', { name: 'Download world' }));

    expect(apiMock.volumeDownload).toHaveBeenCalledWith(GAME, 'config', '/world', true);
  });

  it('should upload dropped files into the current folder', async () => {
    apiMock.volumeUploadDropped.mockResolvedValue({ ok: true, value: { transferId: 't' } });
    renderFiles();
    const zone = await screen.findByTestId('volume-drop-zone');
    const file = new File(['x'], 'x.txt');

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(apiMock.volumeUploadDropped).toHaveBeenCalledWith(GAME, 'config', '/', [file]));
  });

  it('should ignore dropped files while the server is running', async () => {
    mockServerState('running');
    renderFiles();
    const zone = await screen.findByTestId('volume-drop-zone');

    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'x.txt')] } });

    expect(apiMock.volumeUploadDropped).not.toHaveBeenCalled();
  });

  it('should show transfers and cancel a running one', async () => {
    apiMock.volumeCancelTransfer.mockResolvedValue({ cancelled: true });
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('a.txt');

    pushTransfer(makeTransfer({ game: GAME, transferId: 't9', name: 'big.zip', bytesDone: 5, bytesTotal: 10 }));
    await user.click(await screen.findByRole('button', { name: 'Cancel big.zip' }));

    expect(apiMock.volumeCancelTransfer).toHaveBeenCalledWith(GAME, 't9');
  });

  it('should show a failed transfer error and the saved name of a finished download', async () => {
    renderFiles();
    await screen.findByText('a.txt');

    pushTransfer(makeTransfer({ game: GAME, transferId: 't1', kind: 'upload', name: 'a.zip', phase: 'failed', error: 'Disk full.' }));
    pushTransfer(makeTransfer({ game: GAME, transferId: 't2', kind: 'download', name: 'b.zip', phase: 'done', savedAs: 'b (1).zip' }));

    expect(await screen.findByText('Disk full.')).toBeInTheDocument();
    expect(screen.getByText(/b \(1\)\.zip/)).toBeInTheDocument();
  });

  it('should refresh the listing when a folder upload run settles', async () => {
    renderFiles();
    await screen.findByText('a.txt');
    apiMock.volumeList.mockClear();

    pushFolderProgress({
      game: GAME,
      phase: 'done',
      bytesDone: 10,
      bytesTotal: 10,
      filesDone: 1,
      filesTotal: 1,
      bytesPerSecond: 0,
    });

    await waitFor(() => expect(apiMock.volumeList).toHaveBeenCalledWith(GAME, 'config', '/'));
  });

  describe('lost session', () => {
    it.each(['unreachable', 'no-session'] as const)(
      'should re-read the session and offer Start when an operation fails with %s',
      async (code) => {
        apiMock.volumeDownload.mockResolvedValue({ ok: false, code, message: "The file manager isn't reachable. Restart the session." });
        const user = userEvent.setup();
        renderFiles();
        await screen.findByText('a.txt');
        const readsBefore = apiMock.volumeSessionStatus.mock.calls.length;
        apiMock.volumeSessionStatus.mockResolvedValue(session({ state: 'failed', error: 'Task stopped: auto-stop.' }));

        await user.click(screen.getByRole('button', { name: 'Download a.txt' }));

        expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
        expect(screen.getByText('Task stopped: auto-stop.')).toBeInTheDocument();
        expect(apiMock.volumeSessionStatus.mock.calls.length).toBeGreaterThan(readsBefore);
        expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
      },
    );

    it('should not re-read the session when an operation fails for another reason', async () => {
      apiMock.volumeDownload.mockResolvedValue({ ok: false, code: 'failed', message: 'Disk full.' });
      const user = userEvent.setup();
      renderFiles();
      await screen.findByText('a.txt');
      const readsBefore = apiMock.volumeSessionStatus.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Download a.txt' }));

      expect(await screen.findByText('Disk full.')).toBeInTheDocument();
      expect(apiMock.volumeSessionStatus).toHaveBeenCalledTimes(readsBefore);
    });

    it('should keep an open editor, with Save disabled and a notice, when the session ends', async () => {
      apiMock.volumeReadText.mockResolvedValue({ ok: true, value: { path: '/a.txt', content: 'hello', modifiedMs: 5 } });
      const user = userEvent.setup();
      renderFiles();
      await user.click(await screen.findByRole('button', { name: 'Edit a.txt' }));
      const textarea = await screen.findByRole('textbox', { name: 'File contents' });
      await waitFor(() => expect(textarea).toHaveValue('hello'));
      await user.clear(textarea);
      await user.type(textarea, 'unsaved text');

      act(() => pushSession(session({ state: 'failed', error: 'Task stopped: auto-stop.' })));

      // The open dialog hides the page behind it from the accessibility tree.
      expect(await screen.findByRole('button', { name: 'Start', hidden: true })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('unsaved text');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(within(screen.getByRole('dialog')).getByText(/session ended/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
      await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('attach failure', () => {
    it('should show the error with Retry instead of a permanent spinner, and recover on Retry', async () => {
      apiMock.volumeSessionAttach.mockRejectedValueOnce(new Error('bridge down'));
      const user = userEvent.setup();
      renderFiles();

      expect(await screen.findByText('bridge down')).toBeInTheDocument();
      expect(screen.queryByText('Checking the file browser session…')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('a.txt')).toBeInTheDocument();
      expect(screen.queryByText('bridge down')).not.toBeInTheDocument();
    });
  });

  describe('fail-closed server guard', () => {
    it('should treat a game missing from the loaded statuses as unconfirmed', async () => {
      apiMock.status.mockResolvedValue([]);

      renderFiles();

      expect(await screen.findByText("Couldn't confirm the server is stopped.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete a.txt' })).toBeDisabled();
    });

    it('should disable mutating actions without a banner while the first status load is in flight', async () => {
      apiMock.status.mockReturnValue(new Promise(() => undefined));

      renderFiles();

      const button = await screen.findByRole('button', { name: 'New folder' });
      expect(button).toBeDisabled();
      expect(screen.queryByText("Couldn't confirm the server is stopped.")).not.toBeInTheDocument();
    });

    it('should disable Save in the editor while the server is running', async () => {
      mockServerState('running');
      apiMock.volumeReadText.mockResolvedValue({ ok: true, value: { path: '/a.txt', content: 'hello', modifiedMs: 5 } });
      const user = userEvent.setup();
      renderFiles();

      await user.click(await screen.findByRole('button', { name: 'Edit a.txt' }));

      await waitFor(() => expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('hello'));
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('dialogs left open when the server starts', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Makes the next status poll report a running server and runs it. */
    async function serverStarts() {
      mockServerState('running');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
    }

    it.each([
      ['New folder', 'New folder', 'Create'],
      ['Rename a.txt', 'Rename a.txt', 'Rename'],
      ['Delete a.txt', 'Delete a.txt', 'Delete'],
    ])('should disable the %s dialog submit once the server starts', async (_label, opener, submit) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderFiles();
      await user.click(await screen.findByRole('button', { name: opener }));
      expect(await screen.findByRole('button', { name: submit })).toBeEnabled();

      await serverStarts();

      const button = await screen.findByRole('button', { name: submit });
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute('title', 'The server is running. Stop it to change files.');
    });
  });

  describe('folder upload resume', () => {
    const cancelled: FolderUploadProgress = {
      game: GAME,
      phase: 'cancelled',
      bytesDone: 5,
      bytesTotal: 10,
      filesDone: 1,
      filesTotal: 2,
      bytesPerSecond: 0,
    };

    beforeEach(() => {
      mockSession(
        session({
          volumes: [
            { name: 'config', containerPath: '/config', mounted: true },
            { name: 'saves', containerPath: '/saves', mounted: true },
          ],
        }),
      );
    });

    it('should resume into the original folder of the volume the run started in', async () => {
      mockListings({ '/': [makeDirEntry('world')], '/world': [] });
      apiMock.volumeUploadFolder.mockResolvedValue({ ok: true, value: { started: true, runId: 'r1' } });
      const user = userEvent.setup();
      renderFiles();
      await user.click(await screen.findByRole('button', { name: 'world' }));
      await screen.findByText('This folder is empty.');
      await user.click(screen.getByRole('button', { name: 'Upload folder' }));
      await waitFor(() => expect(apiMock.volumeUploadFolder).toHaveBeenCalledWith(GAME, 'config', '/world'));
      await act(async () => pushFolderProgress(cancelled));
      await user.click(screen.getByRole('button', { name: 'config' }));
      await screen.findByText('world');

      await user.click(screen.getByRole('button', { name: 'Resume upload' }));

      await waitFor(() => expect(apiMock.volumeUploadFolder).toHaveBeenLastCalledWith(GAME, 'config', '/world'));
    });

    it('should not resume a run into another volume after the operator switches volumes', async () => {
      apiMock.volumeUploadFolder.mockResolvedValue({ ok: true, value: { started: true, runId: 'r1' } });
      const user = userEvent.setup();
      renderFiles();
      await screen.findByText('a.txt');
      await user.click(screen.getByRole('button', { name: 'Upload folder' }));
      await waitFor(() => expect(apiMock.volumeUploadFolder).toHaveBeenCalledTimes(1));
      await act(async () => pushFolderProgress(cancelled));
      expect(await screen.findByRole('button', { name: 'Resume upload' })).toBeEnabled();

      await user.selectOptions(screen.getByLabelText('Volume'), 'saves');

      await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'Resume upload' }));
      expect(apiMock.volumeUploadFolder).toHaveBeenCalledTimes(1);
    });

    it('should not resume a run that was not started from this page', async () => {
      apiMock.folderGetProgress.mockResolvedValue(cancelled);

      renderFiles();

      expect(await screen.findByRole('button', { name: 'Resume upload' })).toBeDisabled();
      expect(apiMock.volumeUploadFolder).not.toHaveBeenCalled();
    });
  });
});
