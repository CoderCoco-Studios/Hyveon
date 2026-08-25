import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button.component';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';
import { ConfirmDialog } from '../../components/confirm-dialog.component.js';
import type { DiscordConfigRedacted, DiscordMutationResult } from '../../api.service.js';
import { AddGuildForm } from './add-guild-form.component.js';
import { GuildRow } from './guild-row.component.js';

/**
 * Guild allowlist editor. Merges the base-config and dynamic allowlists
 * (deduped by guild ID, base-config entry wins so the row shows as locked),
 * then renders the add-guild form and one {@link GuildRow} per entry with a
 * "registered this session" badge that flips after the operator clicks
 * Register.
 */
export function GuildsSection({
  cfg,
  busy,
  onAdd,
  onRemove,
  onRegister,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onAdd: (g: string) => void;
  onRemove: (g: string) => void;
  onRegister: (g: string) => Promise<DiscordMutationResult>;
}) {
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  // Merge the base-config and dynamic allowlists, deduping by guild ID
  // so a guild that appears in both never renders twice (which would collide
  // React keys and produce conflicting per-row actions). The base-config entry
  // wins so the row is shown as locked.
  const allGuilds = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; locked: boolean }[] = [];
    for (const g of cfg.baseAllowedGuilds) {
      if (!seen.has(g)) {
        seen.add(g);
        out.push({ id: g, locked: true });
      }
    }
    for (const g of cfg.allowedGuilds) {
      if (!seen.has(g)) {
        seen.add(g);
        out.push({ id: g, locked: false });
      }
    }
    return out;
  }, [cfg.allowedGuilds, cfg.baseAllowedGuilds]);

  /**
   * Dispatch the register-commands API call, then mark the guild as
   * registered-this-session only if `result.success` is true. `onRegister`
   * (wired to `wrapRegisterResult` in the parent) never throws — both a
   * Discord-reported failure (`{ success: false, message }`) and a genuine
   * transport-level rejection resolve through the same shape — so the badge
   * simply mirrors `result.success` and stays "not registered" on any
   * failure, letting the operator see it and retry.
   */
  async function handleRegister(guildId: string) {
    const result = await onRegister(guildId);
    if (result.success) {
      setRegistered((prev) => new Set(prev).add(guildId));
    }
  }

  /**
   * Bulk-register every allowlisted guild — sequential (not `Promise.all`) so
   * each row's badge and toast update one at a time as results come back.
   * Continues past a failed guild rather than aborting the loop: one guild's
   * Discord-side error (bad token, rate limit, etc.) shouldn't block the rest
   * of the allowlist from picking up the current command set, and
   * `wrapRegisterResult`'s guild-scoped toast title makes each failure
   * individually attributable even when several fire in the same run.
   */
  async function handleRegisterAll() {
    for (const g of allGuilds) {
      await handleRegister(g.id);
    }
  }

  return (
    <>
      <ConfirmDialog
        open={pendingRemoveId !== null}
        onOpenChange={(o) => { if (!o) setPendingRemoveId(null); }}
        title="Remove guild?"
        description="The bot will no longer respond to commands from this guild."
        confirmLabel="Remove guild"
        typeToConfirm={pendingRemoveId ?? ''}
        onConfirm={() => {
          if (pendingRemoveId) {
            void onRemove(pendingRemoveId);
            // Drop the id so a later re-add doesn't render a stale "registered" badge.
            setRegistered((prev) => {
              if (!prev.has(pendingRemoveId)) return prev;
              const next = new Set(prev);
              next.delete(pendingRemoveId);
              return next;
            });
          }
          setPendingRemoveId(null);
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Guilds</CardTitle>
          <CardDescription>
            The interactions Lambda rejects commands from any server whose ID isn&apos;t in this
            allowlist. Enable Discord Developer Mode (Settings → Advanced) to copy server IDs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddGuildForm
            existingIds={[...cfg.baseAllowedGuilds, ...cfg.allowedGuilds]}
            busy={busy}
            onAdd={onAdd}
          />

          {allGuilds.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)] py-6 text-center">
              No guilds allowlisted yet.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={handleRegisterAll}
                >
                  Register commands in all guilds
                </Button>
              </div>
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Guild ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allGuilds.map(({ id, locked }) => (
                    <GuildRow
                      key={id}
                      id={id}
                      locked={locked}
                      busy={busy}
                      registered={registered.has(id)}
                      onRegister={handleRegister}
                      onRequestRemove={setPendingRemoveId}
                    />
                  ))}
                </TableBody>
              </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
