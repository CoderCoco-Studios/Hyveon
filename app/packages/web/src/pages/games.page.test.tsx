import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  games: vi.fn(),
  createGame: vi.fn(),
  drift: vi.fn(),
  getGameDraft: vi.fn(),
  saveGameDraft: vi.fn(),
  updateGameDraftStepIndex: vi.fn(),
  clearGameDraft: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { GamesPage } from './games.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** A fully declared + deployed game — the "in sync" row. */
const declaredDeployed = {
  name: 'minecraft',
  declared: true,
  deployed: true,
  config: {
    name: 'minecraft',
    image: 'itzg/minecraft-server:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [],
  },
};

/** Declared but not yet applied — the "pending deploy" row. */
const declaredOnly = {
  name: 'valheim',
  declared: true,
  deployed: false,
  config: {
    name: 'valheim',
    image: 'lloesche/valheim-server:latest',
    cpu: 4096,
    memory: 8192,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [],
  },
};

/** Deployed but no declared entry — the "ghost" / "undeclared" row (no `config`). */
const ghostRow = {
  name: 'terraria',
  declared: false,
  deployed: true,
};

/** A saved-but-unfinished add-game wizard draft, parked on step index 2 (Networking). */
const sampleDraft = {
  name: 'unfinished-game',
  image: 'some/image',
  connect_message: '',
  cpu: 256,
  memory: 512,
  ports: [],
  volumes: [],
  file_seeds: [],
  environment: [],
  https: false,
};

describe('GamesPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.games.mockResolvedValue({ games: [declaredDeployed, declaredOnly, ghostRow] });
    apiMock.drift.mockResolvedValue({ entries: [] });
    apiMock.getGameDraft.mockResolvedValue(null);
    apiMock.saveGameDraft.mockResolvedValue(undefined);
    apiMock.updateGameDraftStepIndex.mockResolvedValue(undefined);
    apiMock.clearGameDraft.mockClear();
  });

  it('should render the Games heading', () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    expect(screen.getByRole('heading', { name: 'Games' })).toBeInTheDocument();
  });

  it('should render a row with the correct columns for a declared and deployed game', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('itzg/minecraft-server:latest')).toBeInTheDocument();
    expect(screen.getByText('25565/tcp')).toBeInTheDocument();
    expect(screen.getByText('1024')).toBeInTheDocument();
    expect(screen.getByText('2048')).toBeInTheDocument();
  });

  it('should render a "Pending deploy" chip for a declared-only game', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('valheim')).toBeInTheDocument();
    expect(screen.getByText('Pending deploy')).toBeInTheDocument();
  });

  it('should render an "Undeclared" chip and em-dash columns for a ghost row', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('terraria')).toBeInTheDocument();
    expect(screen.getByText('Undeclared')).toBeInTheDocument();

    const ghostCells = screen.getAllByText('—');
    // image, ports, cpu, memory columns all fall back to an em dash when
    // there's no declared `config` to read from.
    expect(ghostCells.length).toBeGreaterThanOrEqual(4);
  });

  it('should link each row to its /games/:name detail route', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    const link = await screen.findByRole('link', { name: 'minecraft' });
    expect(link).toHaveAttribute('href', '/games/minecraft');
  });

  it('should render an empty state when no games are declared or deployed', async () => {
    apiMock.games.mockResolvedValue({ games: [] });
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('No games declared or deployed yet.')).toBeInTheDocument();
  });

  it('should always render the header "Add game" button, regardless of whether games exist', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('minecraft')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add game' })).toHaveLength(1);
  });

  it('should render an additional empty-state "Add game" CTA only when no games are declared or deployed', async () => {
    apiMock.games.mockResolvedValue({ games: [] });
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText('No games declared or deployed yet.');
    expect(screen.getAllByRole('button', { name: 'Add game' })).toHaveLength(2);
  });

  it('should open the AddGameWizard dialog when the header "Add game" button is clicked', async () => {
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText('minecraft');
    await user.click(screen.getByRole('button', { name: 'Add game' }));

    expect(await screen.findByRole('dialog', { name: 'Add a game server' })).toBeInTheDocument();
  });

  it('should open the AddGameWizard dialog when the empty-state "Add game" CTA is clicked', async () => {
    apiMock.games.mockResolvedValue({ games: [] });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText('No games declared or deployed yet.');
    const [, emptyStateCta] = screen.getAllByRole('button', { name: 'Add game' });
    await user.click(emptyStateCta);

    expect(await screen.findByRole('dialog', { name: 'Add a game server' })).toBeInTheDocument();
  });

  it('should not render the pending-changes banner when the drift report has no entries', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText('minecraft');
    // `PollingIndicator` also has `role="status"`, so scope the assertion to
    // the banner's own copy rather than `role: 'status'` generically.
    expect(screen.queryByText(/change.*pending/)).not.toBeInTheDocument();
  });

  it('should render the pending-changes banner above the games table when drift exists', async () => {
    apiMock.drift.mockResolvedValue({
      entries: [{ game: 'minecraft', kind: 'pending_create' }],
    });

    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    const bannerText = await screen.findByText(/change.*pending/);
    const banner = bannerText.closest('[role="status"]');
    if (!banner) throw new Error('Expected the pending-changes banner to render with role="status".');
    expect(banner).toHaveTextContent('1 change pending');

    const table = await screen.findByRole('table');
    // `compareDocumentPosition` returning `DOCUMENT_POSITION_FOLLOWING` means
    // `table` comes after `banner` in the DOM — i.e. the banner is mounted
    // above the games table.
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('should show no draft-resume banner when no draft is saved', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText('minecraft');
    expect(screen.queryByText(/Unfinished draft/i)).not.toBeInTheDocument();
  });

  it('should show a Resume/Discard banner when a draft is saved', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    await screen.findByText(/Unfinished draft: unfinished-game/i);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a game server' })).not.toBeInTheDocument();
  });

  it('should open the wizard pre-filled when Resume is clicked', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    await screen.findByRole('button', { name: 'Resume' });

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await screen.findByText('Step 3 of 6: Networking');
  });

  it('should not leave a stray "Add game" trigger behind after resuming a draft and closing the dialog', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    await screen.findByRole('button', { name: 'Resume' });

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByText('Step 3 of 6: Networking');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a game server' })).not.toBeInTheDocument());
    // Only the page's own header "Add game" trigger should remain — the
    // resumed instance renders with `hideTrigger`, so closing it must not
    // leave a second, dangling trigger button behind.
    expect(screen.getAllByRole('button', { name: 'Add game' })).toHaveLength(1);
  });

  it('should restore the resume/discard banner after closing a resumed draft without submitting', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    await screen.findByRole('button', { name: 'Resume' });

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByText('Step 3 of 6: Networking');
    expect(screen.queryByText(/Unfinished draft/i)).not.toBeInTheDocument();

    await user.keyboard('{Escape}');

    // The draft itself is untouched (Discard was never clicked), so closing
    // the resumed dialog without submitting should bring the banner back
    // rather than leaving it hidden until the next full page load.
    await screen.findByText(/Unfinished draft: unfinished-game/i);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('should hide the header "Add game" trigger while a resumed draft is open', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    await screen.findByRole('button', { name: 'Resume' });

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await screen.findByText('Step 3 of 6: Networking');
    expect(screen.queryByRole('button', { name: 'Add game' })).not.toBeInTheDocument();
  });

  it('should clear the draft and hide the banner when Discard is clicked, without opening the wizard', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    const user = userEvent.setup();
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    await screen.findByRole('button', { name: 'Discard' });

    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(apiMock.clearGameDraft).toHaveBeenCalled());
    expect(screen.queryByText(/Unfinished draft/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a game server' })).not.toBeInTheDocument();
  });
});
