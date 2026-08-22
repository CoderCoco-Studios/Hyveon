import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  games: vi.fn(),
  discordConfig: vi.fn(),
  discordRemoveGuild: vi.fn().mockResolvedValue(undefined),
  discordDeletePermission: vi.fn().mockResolvedValue(undefined),
  discordSaveAdmins: vi.fn().mockResolvedValue(undefined),
  discordSaveCredentials: vi.fn().mockResolvedValue(undefined),
  discordRegisterCommands: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('sonner', () => ({ toast: toastMock }));

import { DiscordPage } from './discord.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const REDACTED_CONFIG = {
  clientId: '123456789012345678',
  allowedGuilds: ['111111111111111111'],
  admins: { userIds: [], roleIds: [] },
  gamePermissions: {},
  baseAllowedGuilds: [],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: true,
  publicKeySet: true,
  interactionsEndpointUrl: 'https://example.amazonaws.com/discord',
};

describe('DiscordPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.games.mockResolvedValue({
      games: [{ name: 'minecraft', declared: true, deployed: true }],
    });
    apiMock.discordConfig.mockResolvedValue(REDACTED_CONFIG);
    apiMock.discordSaveCredentials.mockResolvedValue(undefined);
    apiMock.discordRegisterCommands.mockResolvedValue({ success: true, message: 'Registered 4 commands.' });
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Discord heading and the polling indicator wired to the status poll', async () => {
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    // Wait for the configured-state header to render — the early-load path
    // also has an h2 with the same text, so anchor on the description copy
    // that only appears once the redacted config has resolved.
    expect(await screen.findByText(/Slash-command bot configuration/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Discord' })).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render the configuration tabs once the redacted config resolves', async () => {
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    expect(await screen.findByRole('tab', { name: 'Credentials' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Guilds' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Admins' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Per-Game Permissions' })).toBeInTheDocument();
  });

  describe('SetupWizard', () => {
    it('should render the setup wizard when allowedGuilds is empty', async () => {
      apiMock.discordConfig.mockResolvedValue({
        ...REDACTED_CONFIG,
        allowedGuilds: [],
        botTokenSet: false,
        publicKeySet: false,
        clientId: '',
        interactionsEndpointUrl: null,
      });
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    });

    it('should not render the setup wizard when allowedGuilds is non-empty', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByText(/Slash-command bot configuration/i);
      expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
    });

    it('should mark credentials step as done when botTokenSet and publicKeySet are true', async () => {
      apiMock.discordConfig.mockResolvedValue({
        ...REDACTED_CONFIG,
        allowedGuilds: [],
        botTokenSet: true,
        publicKeySet: true,
        clientId: '123456789012345678',
        interactionsEndpointUrl: null,
      });
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByRole('heading', { name: 'Get started' });
      // The credentials step text should be present (and rendered as struck-through)
      expect(screen.getByText(/Paste those values into the/i)).toBeInTheDocument();
    });
  });

  it('should show the unavailable-state copy when /api/discord/config rejects', async () => {
    apiMock.discordConfig.mockRejectedValue(new Error('boom'));
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    expect(await screen.findByText(/Discord config unavailable/i)).toBeInTheDocument();
  });

  it('should keep the polling indicator visible while /api/discord/config is loading', async () => {
    // Hold the discord-config response open so the page stays in its
    // loading state for the duration of the assertions.
    apiMock.discordConfig.mockReturnValue(new Promise(() => undefined));
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    // Loading copy is rendered, AND the indicator is wired to the (mocked)
    // status poll above so the operator can still see "Updated …".
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  describe('Per-Game Permissions tab — Clear', () => {
    it('should open a confirmation dialog when Clear is clicked', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      // Navigate to the Per-Game Permissions tab
      await userEvent.click(await screen.findByRole('tab', { name: 'Per-Game Permissions' }));

      // Click the Clear button for the minecraft row
      await userEvent.click(screen.getByRole('button', { name: /clear/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Clear permissions for minecraft?')).toBeInTheDocument();
    });

    it('should call the delete API after the user confirms', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Per-Game Permissions' }));
      await userEvent.click(screen.getByRole('button', { name: /clear/i }));
      await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));

      expect(apiMock.discordDeletePermission).toHaveBeenCalledWith('minecraft');
    });
  });

  describe('Guilds tab — Remove guild', () => {
    it('should open a confirmation dialog when Remove is clicked', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      // Navigate to the Guilds tab
      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));

      // Click the Remove button for the guild
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Remove guild?')).toBeInTheDocument();
    });

    it('should enable Confirm only after the guild ID is typed', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      const confirmBtn = screen.getByRole('button', { name: /remove guild/i });
      expect(confirmBtn).toBeDisabled();

      await userEvent.type(screen.getByRole('textbox'), '111111111111111111');
      expect(confirmBtn).not.toBeDisabled();
    });

    it('should call the remove API after the user types the guild ID and confirms', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      await userEvent.type(screen.getByRole('textbox'), '111111111111111111');
      await userEvent.click(screen.getByRole('button', { name: /remove guild/i }));

      expect(apiMock.discordRemoveGuild).toHaveBeenCalledWith('111111111111111111');
    });
  });

  describe('Guilds tab — Register commands', () => {
    /** Guild-row helper: locates the `<tr>` containing `guildId`'s cell so assertions can scope to one row. */
    function guildRow(guildId: string): HTMLElement {
      const cell = screen.getByText(guildId);
      const row = cell.closest('tr');
      if (!row) throw new Error(`No <tr> ancestor found for guild ${guildId}`);
      return row;
    }

    it('should flip the guild badge to registered and show a success toast when registration succeeds', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      expect(within(guildRow('111111111111111111')).getByText('not registered')).toBeInTheDocument();

      await userEvent.click(within(guildRow('111111111111111111')).getByRole('button', { name: 'Register' }));

      expect(apiMock.discordRegisterCommands).toHaveBeenCalledWith('111111111111111111');
      expect(within(guildRow('111111111111111111')).getByText('registered')).toBeInTheDocument();
      expect(toastMock.success).toHaveBeenCalledWith('Commands registered');
      expect(toastMock.error).not.toHaveBeenCalled();
    });

    it("should show an error toast with Discord's message and leave the badge unregistered when registration fails", async () => {
      apiMock.discordRegisterCommands.mockResolvedValueOnce({
        success: false,
        message: 'Discord returned 401: invalid bot token',
      });
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(within(guildRow('111111111111111111')).getByRole('button', { name: 'Register' }));

      expect(toastMock.error).toHaveBeenCalledWith(
        'Registration failed for guild 111111111111111111',
        expect.objectContaining({ description: 'Discord returned 401: invalid bot token' }),
      );
      expect(toastMock.success).not.toHaveBeenCalled();
      // Badge must stay in the not-registered state — the operator needs to see
      // the failure and retry, not be told a registration that never happened succeeded.
      expect(within(guildRow('111111111111111111')).getByText('not registered')).toBeInTheDocument();
      expect(within(guildRow('111111111111111111')).queryByText('registered')).not.toBeInTheDocument();
    });

    it('should leave the badge unregistered when the register-commands call itself rejects', async () => {
      apiMock.discordRegisterCommands.mockRejectedValueOnce(new Error('IPC bridge unavailable'));
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(within(guildRow('111111111111111111')).getByRole('button', { name: 'Register' }));

      expect(toastMock.error).toHaveBeenCalledWith(
        'Registration failed for guild 111111111111111111',
        expect.objectContaining({ description: 'IPC bridge unavailable' }),
      );
      expect(within(guildRow('111111111111111111')).getByText('not registered')).toBeInTheDocument();
    });

    it('should report the failing guild and leave only that guild unregistered on a partial bulk failure', async () => {
      const TWO_GUILD_CONFIG = {
        ...REDACTED_CONFIG,
        allowedGuilds: ['111111111111111111', '222222222222222222'],
      };
      apiMock.discordConfig.mockResolvedValue(TWO_GUILD_CONFIG);
      apiMock.discordRegisterCommands.mockImplementation((guildId: string) =>
        guildId === '222222222222222222'
          ? Promise.resolve({ success: false, message: 'Discord returned 429: rate limited' })
          : Promise.resolve({ success: true, message: 'Registered 4 commands.' }),
      );
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(screen.getByRole('button', { name: 'Register commands in all guilds' }));

      // Sequential dispatch — wait for both calls to have landed before asserting.
      await vi.waitFor(() => {
        expect(apiMock.discordRegisterCommands).toHaveBeenCalledWith('111111111111111111');
        expect(apiMock.discordRegisterCommands).toHaveBeenCalledWith('222222222222222222');
      });

      expect(within(guildRow('111111111111111111')).getByText('registered')).toBeInTheDocument();
      expect(within(guildRow('222222222222222222')).getByText('not registered')).toBeInTheDocument();
      expect(toastMock.error).toHaveBeenCalledWith(
        'Registration failed for guild 222222222222222222',
        expect.objectContaining({ description: 'Discord returned 429: rate limited' }),
      );
    });
  });

  describe('Credentials tab — Save', () => {
    it('should show a success toast after saving credentials', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByRole('tab', { name: 'Credentials' });
      await userEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

      expect(toastMock.success).toHaveBeenCalledWith('Credentials saved');
    });

    it('should show an error toast when saving credentials fails', async () => {
      apiMock.discordSaveCredentials.mockRejectedValueOnce(new Error('unauthorized'));
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByRole('tab', { name: 'Credentials' });
      await userEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

      expect(toastMock.error).toHaveBeenCalledWith(
        'Action failed',
        expect.objectContaining({ description: 'unauthorized' }),
      );
    });

    it('should show the fallback description when saving credentials fails with an unknown error', async () => {
      apiMock.discordSaveCredentials.mockRejectedValueOnce('not an Error');
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByRole('tab', { name: 'Credentials' });
      await userEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

      expect(toastMock.error).toHaveBeenCalledWith(
        'Action failed',
        expect.objectContaining({ description: 'An unknown error occurred' }),
      );
    });

    it('should omit clientId from the save payload when the field is cleared, instead of wiping it', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await screen.findByRole('tab', { name: 'Credentials' });
      const clientIdInput = screen.getByLabelText('Application (Client) ID');
      await userEvent.clear(clientIdInput);
      await userEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

      expect(apiMock.discordSaveCredentials).toHaveBeenCalledWith(
        expect.not.objectContaining({ clientId: expect.anything() }),
      );
    });
  });

  describe('Admins tab — Remove admin', () => {
    const CONFIG_WITH_ADMINS = {
      ...REDACTED_CONFIG,
      admins: {
        userIds: ['111222333444555666'],
        roleIds: ['999888777666555444'],
      },
    };

    it('should open a confirmation dialog when the X button is clicked on an admin user ID chip', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));

      await userEvent.click(screen.getByRole('button', { name: /remove 111222333444555666/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Remove admin?')).toBeInTheDocument();
    });

    it('should open a confirmation dialog when the X button is clicked on an admin role ID chip', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));

      await userEvent.click(screen.getByRole('button', { name: /remove 999888777666555444/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should remove the user ID from the chip list after the user confirms', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));
      await userEvent.click(screen.getByRole('button', { name: /remove 111222333444555666/i }));
      await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));

      expect(screen.queryByText('111222333444555666')).not.toBeInTheDocument();
    });
  });
});
