import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  api,
  type DiscordAdmins,
  type DiscordConfigRedacted,
  type DiscordGamePermission,
  type DiscordMutationResult,
} from '../../api.service.js';

/**
 * Owns the Discord config's fetch/refresh/mutate lifecycle for {@link DiscordPage}'s
 * Credentials/Guilds/Admins/Permissions tabs, so the page component is just layout.
 *
 * @returns Config state (`cfg`, `games`, `busy`, `loadError`, `showWizard`) plus one
 * mutation function per tab action. Every mutation refreshes `cfg` after it resolves and
 * reports success/failure via `sonner` toasts; none reject — failures resolve to `undefined`
 * (or, for `registerCommands`, to a `{ success: false, message }` result) so call sites can
 * fire-and-forget them.
 */
export function useDiscordConfig() {
  const [cfg, setCfg] = useState<DiscordConfigRedacted | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [games, setGames] = useState<string[]>([]);
  // "The operator still has setup to do." Latched the first time a config
  // arrives with no allowlisted guilds, and never cleared directly — the
  // wizard's visibility is derived from this plus `allStepsDone` below.
  const [wizardLatched, setWizardLatched] = useState(false);

  useEffect(() => {
    // `api.games()` now resolves `GameListEntry[]` (declared + deployed view,
    // see issue #92) — the permissions UI only needs the game keys.
    api.games().then((g) => setGames(g.games.map((entry) => entry.name))).catch(() => undefined);
  }, []);

  /**
   * Re-fetch the (redacted) Discord config from the API after mutations.
   *
   * The wizard latch is set here rather than in an effect watching `cfg`:
   * this is the only place a config ever arrives, so it is the natural point
   * to record "this install still has no guilds", and it keeps the setState
   * calls in an async callback instead of synchronously inside an effect
   * (`react-hooks/set-state-in-effect`).
   */
  async function refresh() {
    try {
      const next = await api.discordConfig();
      setCfg(next);
      setLoadError(false);
      if (next.allowedGuilds.length === 0) setWizardLatched(true);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, []);

  const allStepsDone =
    !!cfg?.clientId &&
    !!cfg?.botTokenSet &&
    !!cfg?.publicKeySet &&
    !!cfg?.interactionsEndpointUrl &&
    (cfg?.allowedGuilds.length ?? 0) > 0;

  // Derived rather than stored: the wizard is open while setup is
  // outstanding and closes as soon as all four steps are satisfied.
  //
  // This collapses in the same render that would have shown the fourth check
  // green, where the previous effect-based version deliberately let that
  // render paint first. The frame of all-green feedback is lost; the trade is
  // that visibility is now a pure function of the config, so it cannot get
  // stuck open or closed if a refresh interleaves with a mutation.
  const showWizard = wizardLatched && !allStepsDone;

  /**
   * Guard a mutating API call with the `busy` flag and refresh config after
   * it resolves so the UI reflects the server-side change.
   */
  async function wrap<T>(fn: () => Promise<T>, successMsg?: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      toast.error('Action failed', {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
      throw err;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Register-commands-specific counterpart to `wrap()`.
   *
   * `DiscordCommandRegistrar.registerForGuild` (the desktop-main service
   * behind `discord.registerCommands`) never throws — every failure mode
   * (malformed snowflake, missing token, Discord's own 4xx/5xx) resolves as
   * `{ success: false, message }` instead of a rejected promise, precisely so
   * the IPC controller can pass it straight through without the exception
   * ever crossing the Electron IPC boundary (a thrown `BadRequestException`
   * there does not reliably reach the renderer with a usable message — the
   * NestJS microservices context wraps it in an RxJS `Observable` that
   * neither `nestjs-electron-ipc-transport` nor `ipcMain.handle` unwraps).
   * `wrap()` alone can't see this: it only reacts to *thrown* errors, so a
   * Discord-rejected registration would still resolve `fn()` successfully and
   * fire the "success" toast. This wrapper inspects `result.success`
   * directly instead, and folds a genuine transport-level rejection into the
   * same `{ success: false, message }` shape so callers only ever have to
   * check one field. The guild ID is threaded through so a failure toast
   * always says which guild it was — this matters for the "Register commands
   * in all guilds" bulk button, where multiple calls can be in flight/queued.
   */
  async function wrapRegisterResult(
    guildId: string,
    fn: () => Promise<DiscordMutationResult>,
  ): Promise<DiscordMutationResult> {
    setBusy(true);
    try {
      const result = await fn();
      if (result.success) {
        toast.success('Commands registered');
      } else {
        toast.error(`Registration failed for guild ${guildId}`, { description: result.message });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      toast.error(`Registration failed for guild ${guildId}`, { description: message });
      return { success: false, message };
    } finally {
      setBusy(false);
    }
  }

  /** Save credentials (Client ID / Bot Token / Public Key); any field may be omitted to leave it unchanged. */
  function saveCredentials(body: { botToken?: string; clientId?: string; publicKey?: string }): Promise<void> {
    return wrap(() => api.discordSaveCredentials(body), 'Credentials saved').catch(() => undefined);
  }

  /** Add a guild to the dynamic allowlist. */
  function addGuild(guildId: string): Promise<void> {
    return wrap(() => api.discordAddGuild(guildId), 'Guild added').catch(() => undefined);
  }

  /** Remove a guild from the dynamic allowlist. */
  function removeGuild(guildId: string): Promise<void> {
    return wrap(() => api.discordRemoveGuild(guildId), 'Guild removed').catch(() => undefined);
  }

  /** Register slash commands for one guild; resolves rather than throws, see `wrapRegisterResult`. */
  function registerCommands(guildId: string): Promise<DiscordMutationResult> {
    return wrapRegisterResult(guildId, () => api.discordRegisterCommands(guildId));
  }

  /** Save the server-wide admin user/role ID lists. */
  function saveAdmins(admins: DiscordAdmins): Promise<void> {
    return wrap(() => api.discordSaveAdmins(admins), 'Admins saved').catch(() => undefined);
  }

  /** Save one game's permission entry. */
  function savePermission(game: string, perm: DiscordGamePermission): Promise<void> {
    return wrap(() => api.discordSavePermission(game, perm), 'Permissions saved').catch(() => undefined);
  }

  /** Clear one game's permission entry. */
  function deletePermission(game: string): Promise<void> {
    return wrap(() => api.discordDeletePermission(game), 'Permissions cleared').catch(() => undefined);
  }

  return {
    cfg,
    games,
    busy,
    loadError,
    showWizard,
    saveCredentials,
    addGuild,
    removeGuild,
    registerCommands,
    saveAdmins,
    savePermission,
    deletePermission,
  };
}
