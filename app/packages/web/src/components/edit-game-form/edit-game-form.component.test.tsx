import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { EditGameForm } from './edit-game-form.component.js';
import type { GameServer } from '../../api.service.js';

/** Renders `<EditGameForm>` wrapped in a `MemoryRouter` — the "apply this change" hint links to `/iac`. */
function renderForm(ui: ReactElement): RenderResult {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * Stub for the `@/api.service.js` module: `games()` backs the
 * other-declared-games fetch the form fires on mount (used for the
 * cross-game port-collision check), and `updateGame()` backs the "Save
 * changes" button. Both are reset to a "happy" default in `beforeEach` and
 * overridden per test.
 */
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  updateGame: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

/** A fully-populated declared game used to prefill the form under test. */
function sampleGame(overrides: Partial<GameServer> = {}): GameServer {
  return {
    name: 'mygame',
    image: 'itzg/minecraft-server',
    cpu: 512,
    memory: 1024,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    connect_message: 'Connect at {ip}:25565',
    environment: [{ name: 'EULA', value: 'true' }],
    https: false,
    file_seeds: [],
    ...overrides,
  };
}

/** The payload `draftToPayload`/`EditGameForm` produce for an unedited `sampleGame()`. */
function samplePayloadConfig() {
  return {
    image: 'itzg/minecraft-server',
    cpu: 512,
    memory: 1024,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    connect_message: 'Connect at {ip}:25565',
    file_seeds: undefined,
    environment: [{ name: 'EULA', value: 'true' }],
    https: false,
  };
}

describe('EditGameForm', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.updateGame.mockReset();
  });

  it('should prefill every field from the supplied GameServer config', async () => {
    renderForm(<EditGameForm game={sampleGame()} />);

    expect(await screen.findByLabelText('Name')).toHaveValue('mygame');
    expect(screen.getByLabelText('Image')).toHaveValue('itzg/minecraft-server');
    expect(screen.getByLabelText('Connect message')).toHaveValue('Connect at {ip}:25565');
    expect(screen.getByLabelText(/CPU/i)).toHaveValue('512');
    expect(screen.getByLabelText(/Memory/i)).toHaveValue('1024');
    expect(screen.getByLabelText('Container port')).toHaveValue(25565);
    expect(screen.getByLabelText('Protocol')).toHaveValue('tcp');
    expect(screen.getByLabelText('Volume name')).toHaveValue('data');
    expect(screen.getByLabelText('Container path')).toHaveValue('/data');
  });

  it('should render the Name field as not editable', async () => {
    renderForm(<EditGameForm game={sampleGame()} />);

    expect(await screen.findByLabelText('Name')).toBeDisabled();
  });

  it('should allow saving a legacy, non-DNS-safe declared name (e.g. containing an underscore) without a client-side name error blocking Save', async () => {
    // Regression test: the current DNS-safe name pattern is create-only —
    // editing an already-declared game must never re-validate its
    // (immutable, read-only) name against that pattern. Before this fix,
    // `EditGameForm` ran the same `checkName()` the add wizard uses, so a
    // legacy HCL-era name containing an underscore would permanently
    // disable Save for that game with no way to fix it (the name field is
    // read-only, so the operator couldn't even correct the "invalid" name).
    apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
    renderForm(<EditGameForm game={sampleGame({ name: 'My_Legacy_Server' })} />);

    const imageField = await screen.findByLabelText('Image');
    await userEvent.clear(imageField);
    await userEvent.type(imageField, 'itzg/minecraft-server-2');

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeEnabled();

    await userEvent.click(saveButton);

    await waitFor(() =>
      expect(apiMock.updateGame).toHaveBeenCalledWith({
        name: 'My_Legacy_Server',
        config: { ...samplePayloadConfig(), image: 'itzg/minecraft-server-2' },
      }),
    );
  });

  it('should show a hint linking to the Infrastructure page to apply the change', async () => {
    renderForm(<EditGameForm game={sampleGame()} />);

    expect(await screen.findByRole('link', { name: 'Infrastructure' })).toHaveAttribute('href', '/iac');
  });

  it('should call api.updateGame with the updated payload after a field edit and Save', async () => {
    apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
    renderForm(<EditGameForm game={sampleGame()} />);

    const imageField = await screen.findByLabelText('Image');
    await userEvent.clear(imageField);
    await userEvent.type(imageField, 'itzg/minecraft-server-2');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(apiMock.updateGame).toHaveBeenCalledWith({
        name: 'mygame',
        config: { ...samplePayloadConfig(), image: 'itzg/minecraft-server-2' },
      }),
    );
  });

  it('should not call api.updateGame for an unedited, valid draft other than the Save click itself', async () => {
    apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
    renderForm(<EditGameForm game={sampleGame()} />);

    await screen.findByLabelText('Image');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(apiMock.updateGame).toHaveBeenCalledWith({ name: 'mygame', config: samplePayloadConfig() }),
    );
  });

  it('should render an inline error and keep the edited draft on a server validation failure', async () => {
    apiMock.updateGame.mockResolvedValue({
      ok: false,
      code: 'validation',
      issues: [{ path: 'image', message: 'Image is required.' }],
    });
    renderForm(<EditGameForm game={sampleGame()} />);

    const imageField = await screen.findByLabelText('Image');
    await userEvent.clear(imageField);
    await userEvent.type(imageField, 'edited/image');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Image is required.');
    expect(screen.getByLabelText('Image')).toHaveValue('edited/image');
  });

  it('should render an inline alert and keep the edited draft on a server conflict failure', async () => {
    apiMock.updateGame.mockResolvedValue({
      ok: false,
      code: 'conflict',
      message: 'deployment config changed since this draft was loaded.',
    });
    renderForm(<EditGameForm game={sampleGame()} />);

    const imageField = await screen.findByLabelText('Image');
    await userEvent.clear(imageField);
    await userEvent.type(imageField, 'edited/image');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('deployment config changed since this draft was loaded.');
    expect(screen.getByLabelText('Image')).toHaveValue('edited/image');
  });

  it('should call onSaved with the write result on a successful save', async () => {
    const onSaved = vi.fn();
    const result = { ok: true as const, games: [] };
    apiMock.updateGame.mockResolvedValue(result);
    renderForm(<EditGameForm game={sampleGame()} onSaved={onSaved} />);

    await screen.findByLabelText('Image');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(result));
  });

  describe('https field', () => {
    it('should render the HTTPS control enabled for a game declared with https: true', async () => {
      renderForm(<EditGameForm game={sampleGame({ https: true })} />);

      expect(await screen.findByLabelText('Enable HTTPS (Caddy sidecar)')).toBeChecked();
    });

    it('should render the HTTPS control disabled for a game declared with https: false', async () => {
      renderForm(<EditGameForm game={sampleGame({ https: false })} />);

      expect(await screen.findByLabelText('Enable HTTPS (Caddy sidecar)')).not.toBeChecked();
    });

    it('should send https: false rather than carrying the previous true forward when the control is disabled and saved', async () => {
      apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
      renderForm(<EditGameForm game={sampleGame({ https: true })} />);

      await userEvent.click(await screen.findByLabelText('Enable HTTPS (Caddy sidecar)'));
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(apiMock.updateGame).toHaveBeenCalledWith({
          name: 'mygame',
          config: { ...samplePayloadConfig(), https: false },
        }),
      );
    });

    it('should still send https: true when only an unrelated field (image) is edited on an https: true game', async () => {
      apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
      renderForm(<EditGameForm game={sampleGame({ https: true })} />);

      const imageField = await screen.findByLabelText('Image');
      await userEvent.clear(imageField);
      await userEvent.type(imageField, 'itzg/minecraft-server-2');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(apiMock.updateGame).toHaveBeenCalledWith({
          name: 'mygame',
          config: { ...samplePayloadConfig(), image: 'itzg/minecraft-server-2', https: true },
        }),
      );
    });
  });
});
