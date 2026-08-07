import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.service.js';

/**
 * Builds a fresh `window.hyveon` IPC-bridge double. Every namespace method is a
 * `vi.fn()` returning a minimal payload of the right shape, so each `api.*`
 * wrapper has something to await and we can assert it delegated to the matching
 * bridge method with the right arguments.
 */
function makeHyveonMock() {
  return {
    games: {
      list: vi.fn().mockResolvedValue({ games: [] }),
      status: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
      start: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      create: vi.fn().mockResolvedValue({ ok: true, games: [] }),
      update: vi.fn().mockResolvedValue({ ok: true, games: [] }),
      delete: vi.fn().mockResolvedValue({ ok: true, games: [] }),
    },
    costs: {
      estimate: vi.fn().mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 }),
    },
    logs: {
      get: vi.fn().mockResolvedValue({ game: 'minecraft', lines: [] }),
      stream: vi.fn(),
    },
    files: {
      list: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
      start: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    },
    discord: {
      getConfig: vi.fn().mockResolvedValue({ clientId: '', allowedGuilds: [], gamePermissions: {} }),
      putConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
      listGuilds: vi.fn().mockResolvedValue({ guilds: [], baseGuilds: [] }),
      addGuild: vi.fn().mockResolvedValue({ success: true, guilds: [], baseGuilds: [] }),
      removeGuild: vi.fn().mockResolvedValue({ success: true, guilds: [], baseGuilds: [] }),
      registerCommands: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      getAdmins: vi.fn().mockResolvedValue({ userIds: [], roleIds: [], baseAdmins: { userIds: [], roleIds: [] } }),
      putAdmins: vi.fn().mockResolvedValue({ success: true, admins: { userIds: [], roleIds: [] }, baseAdmins: { userIds: [], roleIds: [] } }),
      getPermissions: vi.fn().mockResolvedValue({}),
      putPermission: vi.fn().mockResolvedValue({ success: true, permissions: {} }),
      deletePermission: vi.fn().mockResolvedValue({ success: true, permissions: {} }),
    },
    env: {
      get: vi.fn().mockResolvedValue({ region: 'us-east-1', domain: 'example.com', environment: 'dev' }),
    },
    diagnostics: {
      tail: vi.fn().mockResolvedValue({ lines: [] }),
      path: vi.fn().mockResolvedValue({ path: '/var/log/today.log' }),
    },
    drift: {
      get: vi.fn().mockResolvedValue({ entries: [] }),
    },
    audit: {
      list: vi.fn().mockResolvedValue({ entries: [] }),
    },
  };
}

let hyveon: ReturnType<typeof makeHyveonMock>;

beforeEach(() => {
  hyveon = makeHyveonMock();
  vi.stubGlobal('hyveon', hyveon);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IPC bridge delegation', () => {
  it('should delegate api.env() to window.hyveon.env.get()', async () => {
    await api.env();
    expect(hyveon.env.get).toHaveBeenCalledOnce();
  });

  it('should delegate api.games() to window.hyveon.games.list()', async () => {
    await api.games();
    expect(hyveon.games.list).toHaveBeenCalledOnce();
  });

  it('should delegate api.status() to window.hyveon.games.status()', async () => {
    await api.status();
    expect(hyveon.games.status).toHaveBeenCalledOnce();
  });

  it('should delegate api.statusGame() to window.hyveon.games.getStatus() with the game id', async () => {
    await api.statusGame('minecraft');
    expect(hyveon.games.getStatus).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.start() to window.hyveon.games.start() with the game id', async () => {
    await api.start('minecraft');
    expect(hyveon.games.start).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.stop() to window.hyveon.games.stop() with the game id', async () => {
    await api.stop('palworld');
    expect(hyveon.games.stop).toHaveBeenCalledWith('palworld');
  });

  it('should delegate api.costsEstimate() to window.hyveon.costs.estimate()', async () => {
    await api.costsEstimate();
    expect(hyveon.costs.estimate).toHaveBeenCalledOnce();
  });

  it('should not expose a costsActual method on the api object', () => {
    expect('costsActual' in api).toBe(false);
  });

  it('should delegate api.filesMgrStatus() to window.hyveon.files.list() with the game id', async () => {
    await api.filesMgrStatus('minecraft');
    expect(hyveon.files.list).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.filesMgrStart() to window.hyveon.files.start() with the game id', async () => {
    await api.filesMgrStart('minecraft');
    expect(hyveon.files.start).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.filesMgrStop() to window.hyveon.files.stop() with the game id', async () => {
    await api.filesMgrStop('minecraft');
    expect(hyveon.files.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.createGame() to window.hyveon.games.create() with the exact payload', async () => {
    const payload = {
      name: 'minecraft',
      config: {
        image: 'itzg/minecraft-server',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'data', container_path: '/data' }],
      },
    };
    await api.createGame(payload);
    expect(hyveon.games.create).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.updateGame() to window.hyveon.games.update() with the exact payload', async () => {
    const payload = {
      name: 'minecraft',
      config: {
        image: 'itzg/minecraft-server',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'data', container_path: '/data' }],
      },
    };
    await api.updateGame(payload);
    expect(hyveon.games.update).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.deleteGame() to window.hyveon.games.delete() with the exact payload', async () => {
    const payload = { name: 'minecraft' };
    await api.deleteGame(payload);
    expect(hyveon.games.delete).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.discordConfig() to window.hyveon.discord.getConfig()', async () => {
    await api.discordConfig();
    expect(hyveon.discord.getConfig).toHaveBeenCalledOnce();
  });

  it('should delegate api.discordSaveCredentials() to window.hyveon.discord.putConfig() with the body', async () => {
    const body = { botToken: 't', clientId: 'c', publicKey: 'k' };
    await api.discordSaveCredentials(body);
    expect(hyveon.discord.putConfig).toHaveBeenCalledWith(body);
  });

  it('should delegate api.discordAddGuild() to window.hyveon.discord.addGuild() with the guild id', async () => {
    await api.discordAddGuild('G1');
    expect(hyveon.discord.addGuild).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordRemoveGuild() to window.hyveon.discord.removeGuild() with the guild id', async () => {
    await api.discordRemoveGuild('G1');
    expect(hyveon.discord.removeGuild).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordRegisterCommands() to window.hyveon.discord.registerCommands() with the guild id', async () => {
    await api.discordRegisterCommands('G1');
    expect(hyveon.discord.registerCommands).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordSaveAdmins() to window.hyveon.discord.putAdmins() with the admins', async () => {
    const admins = { userIds: ['u1'], roleIds: ['r1'] };
    await api.discordSaveAdmins(admins);
    expect(hyveon.discord.putAdmins).toHaveBeenCalledWith(admins);
  });

  it('should delegate api.discordSavePermission() to window.hyveon.discord.putPermission() with the game and permission', async () => {
    const perm = { userIds: ['u1'], roleIds: [], actions: ['start' as const] };
    await api.discordSavePermission('minecraft', perm);
    expect(hyveon.discord.putPermission).toHaveBeenCalledWith('minecraft', perm);
  });

  it('should delegate api.discordDeletePermission() to window.hyveon.discord.deletePermission() with the game', async () => {
    await api.discordDeletePermission('minecraft');
    expect(hyveon.discord.deletePermission).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.diagnosticsTail() to window.hyveon.diagnostics.tail()', async () => {
    await api.diagnosticsTail();
    expect(hyveon.diagnostics.tail).toHaveBeenCalledOnce();
  });

  it('should delegate api.diagnosticsLogPath() to window.hyveon.diagnostics.path()', async () => {
    await api.diagnosticsLogPath();
    expect(hyveon.diagnostics.path).toHaveBeenCalledOnce();
  });

  it('should resolve api.drift() with the bridge drift.get() result', async () => {
    const report = { entries: [{ game: 'minecraft', kind: 'pending_create' as const }] };
    hyveon.drift.get.mockResolvedValueOnce(report);
    await expect(api.drift()).resolves.toEqual(report);
    expect(hyveon.drift.get).toHaveBeenCalledOnce();
  });

  it('should delegate api.audit() to window.hyveon.audit.list() with the opts', async () => {
    const opts = { limit: 10, before: '2026-01-01T00:00:00.000Z#01H' };
    await api.audit(opts);
    expect(hyveon.audit.list).toHaveBeenCalledWith(opts);
  });

  it('should delegate api.audit() to window.hyveon.audit.list() with undefined when opts is omitted', async () => {
    await api.audit();
    expect(hyveon.audit.list).toHaveBeenCalledWith(undefined);
  });

  it('should resolve api.audit() with the bridge audit.list() result', async () => {
    const page = {
      entries: [
        {
          sk: '2026-01-01T00:00:00.000Z#01H',
          timestamp: '2026-01-01T00:00:00.000Z',
          actor: 'operator',
          action: 'edit' as const,
          game: 'minecraft',
          before: null,
          after: null,
        },
      ],
      nextBefore: '2025-12-31T00:00:00.000Z#01G',
    };
    hyveon.audit.list.mockResolvedValueOnce(page);
    await expect(api.audit()).resolves.toEqual(page);
  });

  it('should return the payload resolved by the bridge', async () => {
    const entries = [
      { name: 'minecraft', declared: false, deployed: true },
      { name: 'palworld', declared: false, deployed: false },
    ];
    hyveon.games.list.mockResolvedValueOnce({ games: entries });
    await expect(api.games()).resolves.toEqual({ games: entries });
  });
});

describe('missing IPC bridge', () => {
  it('should throw a descriptive error when window.hyveon is unavailable', async () => {
    vi.stubGlobal('hyveon', undefined);
    await expect(api.env()).rejects.toThrow('window.hyveon IPC bridge is unavailable');
  });

  it('should reject api.drift() with a descriptive error when window.hyveon is unavailable', async () => {
    vi.stubGlobal('hyveon', undefined);
    await expect(api.drift()).rejects.toThrow('window.hyveon IPC bridge is unavailable');
  });
});
