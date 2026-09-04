import { Link } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.component';
import { PollingIndicator } from '../../polling/polling-indicator.component.js';
import { PageHeader } from '../../components/page-header.component.js';
import { ServerlessBadge } from './serverless-badge.component.js';
import { SetupWizard } from './setup-wizard.component.js';
import { CredentialsSection } from './credentials-section.component.js';
import { GuildsSection } from './guilds-section.component.js';
import { AdminsSection } from './admins-section.component.js';
import { PermissionsSection } from './permissions-section.component.js';
import { useDiscordConfig } from './use-discord-config.hook.js';

/**
 * Discord settings route (`/discord`).
 *
 * Replaces the old `DiscordPanel` that was crammed into the bottom of the
 * dashboard. Renders a setup wizard for first-time operators, and otherwise
 * a tabbed view: Credentials, Guilds, Admins, and per-game permissions.
 *
 * All persistence still goes through the existing `discord.*` IPC channels —
 * neither the bot token nor the public key is ever echoed back to the client.
 */
export function DiscordPage() {
  const {
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
  } = useDiscordConfig();

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
          {/* Re-keyed on the fields the local draft seeds from, so a refresh (e.g. after Save) resyncs the fields instead of showing stale draft state. */}
          <CredentialsSection
            key={`${cfg.clientId}:${cfg.botTokenSet}:${cfg.publicKeySet}`}
            cfg={cfg}
            busy={busy}
            onSave={saveCredentials}
          />
        </TabsContent>

        <TabsContent value="guilds" className="mt-6">
          <GuildsSection
            cfg={cfg}
            busy={busy}
            onAdd={addGuild}
            onRemove={removeGuild}
            onRegister={registerCommands}
          />
        </TabsContent>

        <TabsContent value="admins" className="mt-6">
          {/* Re-keyed on cfg.admins so a refresh resyncs the chip lists instead of showing stale draft state. */}
          <AdminsSection key={JSON.stringify(cfg.admins)} cfg={cfg} busy={busy} onSave={saveAdmins} />
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <PermissionsSection
            cfg={cfg}
            games={games}
            busy={busy}
            onSave={savePermission}
            onDelete={deletePermission}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
