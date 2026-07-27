/**
 * Electron IPC mock helpers for Playwright e2e specs running in the `electron`
 * Playwright project.
 *
 * These helpers drive `window.hyveon.__test.mock()` — the test seam exposed by the
 * preload script when the app is launched with `HYVEON_TEST_MODE=1`. They are
 * intentionally separate from the HTTP-stub helpers in `index.ts` (which use
 * `page.route()` for the `chromium` project) so the two seams never bleed into
 * each other.
 *
 * Usage pattern in an Electron spec:
 * ```ts
 * const app = await _electron.launch({ args: [electronMain], env: electronEnv });
 * const win  = await app.firstWindow();
 *
 * await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
 * // ... drive the UI ...
 * await clearElectronMocks(win);
 * await app.close();
 * ```
 */

import type { Page } from '@playwright/test';
import type { DiscordConfigRedacted } from '@/api.service.js';

/**
 * Seeds all Discord IPC channels in the Electron mock registry with canned
 * responses derived from `config`.
 *
 * Every `window.hyveon.discord.*` method that the DiscordPage exercises is covered
 * so specs can navigate to `/discord` without the Nest main process being
 * reachable. Mutation channels (`putConfig`, `addGuild`, `removeGuild`,
 * `registerCommands`, `putAdmins`, `putPermission`, `deletePermission`) return
 * minimal success payloads based on the seed config so optimistic UI updates
 * work without a real server round-trip.
 *
 * @param win    - The Electron renderer window obtained from `app.firstWindow()`.
 * @param config - The `DiscordConfigRedacted` fixture to seed all channels with.
 */
export async function seedDiscordMocks(win: Page, config: DiscordConfigRedacted): Promise<void> {
  await win.evaluate((cfg) => {
    const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
      __test: { mock: (channel: string, handler: unknown) => void };
    };

    // Read channel — returns the full config.
    hyveon.__test.mock('discord.getConfig', () => Promise.resolve(cfg));

    // Credentials update — echoes the same config back as a success result.
    hyveon.__test.mock('discord.putConfig', () =>
      Promise.resolve({ success: true, config: cfg }),
    );

    // Guild list — split into dynamic (allowedGuilds) and Terraform-base
    // (baseAllowedGuilds) so the Guilds tab renders the correct table rows.
    hyveon.__test.mock('discord.listGuilds', () =>
      Promise.resolve({ guilds: cfg.allowedGuilds, baseGuilds: cfg.baseAllowedGuilds }),
    );

    // Guild mutations — return the same list as the seed so the UI
    // doesn't visually change after an optimistic update in the mock.
    hyveon.__test.mock('discord.addGuild', () =>
      Promise.resolve({
        success: true,
        guilds: cfg.allowedGuilds,
        baseGuilds: cfg.baseAllowedGuilds,
      }),
    );
    hyveon.__test.mock('discord.removeGuild', () =>
      Promise.resolve({
        success: true,
        guilds: cfg.allowedGuilds,
        baseGuilds: cfg.baseAllowedGuilds,
      }),
    );

    // Slash-command registration — succeeds with a generic message.
    hyveon.__test.mock('discord.registerCommands', () =>
      Promise.resolve({ success: true, message: 'Registered' }),
    );

    // Admin read/write channels.
    hyveon.__test.mock('discord.getAdmins', () =>
      Promise.resolve({ ...cfg.admins, baseAdmins: cfg.baseAdmins }),
    );
    hyveon.__test.mock('discord.putAdmins', () =>
      Promise.resolve({ success: true, admins: cfg.admins, baseAdmins: cfg.baseAdmins }),
    );

    // Per-game permission channels.
    hyveon.__test.mock('discord.getPermissions', () =>
      Promise.resolve(cfg.gamePermissions),
    );
    hyveon.__test.mock('discord.putPermission', () =>
      Promise.resolve({ success: true, permissions: cfg.gamePermissions }),
    );
    hyveon.__test.mock('discord.deletePermission', () =>
      Promise.resolve({ success: true, permissions: cfg.gamePermissions }),
    );
  }, config);
}

/**
 * Clears all IPC mock handlers registered in the Electron window via the
 * `window.hyveon.__test` surface.
 *
 * Call this in `afterEach` (or the `finally` block of a test that shares an
 * `ElectronApplication` across multiple cases) so stale mock handlers do not
 * bleed into later tests.
 *
 * @param win - The Electron renderer window obtained from `app.firstWindow()`.
 */
export async function clearElectronMocks(win: Page): Promise<void> {
  await win.evaluate(() => {
    const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
      __test: { clearMocks: () => void };
    };
    hyveon.__test.clearMocks();
  });
}
