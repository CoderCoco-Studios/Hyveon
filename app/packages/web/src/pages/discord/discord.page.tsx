import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, type DiscordConfigRedacted, type DiscordMutationResult } from '../../api.service.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.component';
import { PollingIndicator } from '../../polling/polling-indicator.component.js';
import { PageHeader } from '../../components/page-header.component.js';
import { ServerlessBadge } from './serverless-badge.component.js';
import { SetupWizard } from './setup-wizard.component.js';
import { CredentialsSection } from './credentials-section.component.js';
import { GuildsSection } from './guilds-section.component.js';
import { AdminsSection } from './admins-section.component.js';
import { PermissionsSection } from './permissions-section.component.js';

/**
 * Discord settings route (`/discord`).
 *
 * Replaces the old `DiscordPanel` that was crammed into the bottom of the
 * dashboard. Renders a setup wizard for first-time operators, and otherwise
 * a tabbed view: Credentials, Guilds, Admins, and per-game permissions.
 *
 * All persistence still goes through the existing `/api/discord/*` routes —
 * neither the bot token nor the public key is ever echoed back to the client.
 */
export function DiscordPage() {
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
      await refresh();
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

  if (!cfg) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Discord"
          subtitle={
            loadError ? (
              <>
                Discord config unavailable — infrastructure not deployed yet. Run a plan and apply from the{' '}
                <Link to="/iac" className="underline underline-offset-2">
                  Infrastructure
                </Link>{' '}
                page first.
              </>
            ) : (
              'Loading…'
            )
          }
        >
          <PollingIndicator />
        </PageHeader>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Discord"
        subtitle="Slash-command bot configuration: credentials, guild allowlist, admins, and per-game permissions."
      >
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <ServerlessBadge cfg={cfg} />
        </div>
      </PageHeader>

      {showWizard && <SetupWizard cfg={cfg} />}

      <Tabs defaultValue="credentials" className="w-full">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="guilds">Guilds</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
          <TabsTrigger value="permissions">Per-Game Permissions</TabsTrigger>
        </TabsList>

        <TabsContent value="credentials" className="mt-6">
          <CredentialsSection
            cfg={cfg}
            busy={busy}
            onSave={(body) => { void wrap(() => api.discordSaveCredentials(body), 'Credentials saved').catch(() => undefined); }}
          />
        </TabsContent>

        <TabsContent value="guilds" className="mt-6">
          <GuildsSection
            cfg={cfg}
            busy={busy}
            onAdd={(g) => { void wrap(() => api.discordAddGuild(g), 'Guild added').catch(() => undefined); }}
            onRemove={(g) => { void wrap(() => api.discordRemoveGuild(g), 'Guild removed').catch(() => undefined); }}
            onRegister={(g) => wrapRegisterResult(g, () => api.discordRegisterCommands(g))}
          />
        </TabsContent>

        <TabsContent value="admins" className="mt-6">
          <AdminsSection
            cfg={cfg}
            busy={busy}
            onSave={(a) => { void wrap(() => api.discordSaveAdmins(a), 'Admins saved').catch(() => undefined); }}
          />
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <PermissionsSection
            cfg={cfg}
            games={games}
            busy={busy}
            onSave={(game, perm) => { void wrap(() => api.discordSavePermission(game, perm), 'Permissions saved').catch(() => undefined); }}
            onDelete={(game) => { void wrap(() => api.discordDeletePermission(game), 'Permissions cleared').catch(() => undefined); }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
