import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';
import { ConfirmDialog } from '../../components/confirm-dialog.component.js';
import { isSuppressed } from '../../lib/confirm-skip.utils.js';
import { SnowflakeChipsInput } from '../../components/snowflake-chips-input.component.js';
import type { DiscordAction, DiscordConfigRedacted, DiscordGamePermission } from '../../api.service.js';

const ALL_ACTIONS: DiscordAction[] = ['start', 'stop', 'status'];

/**
 * Per-game permissions table. Each row is independently editable with its own
 * Save button so operators can tune one game without touching the others.
 */
export function PermissionsSection({
  cfg,
  games,
  busy,
  onSave,
  onDelete,
}: {
  cfg: DiscordConfigRedacted;
  games: string[];
  busy: boolean;
  onSave: (game: string, perm: DiscordGamePermission) => void;
  onDelete: (game: string) => void;
}) {
  if (!games.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
          No games configured yet — declare one on the{' '}
          <Link to="/games" className="underline underline-offset-2">
            Games
          </Link>{' '}
          page, then plan and apply from{' '}
          <Link to="/iac" className="underline underline-offset-2">
            Infrastructure
          </Link>
          .
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Game Permissions</CardTitle>
        <CardDescription>
          One row per game. Edit the chips and action checkboxes inline, then Save the row. Clear
          drops the entry entirely.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Game</TableHead>
              <TableHead>User IDs</TableHead>
              <TableHead>Role IDs</TableHead>
              <TableHead className="w-[200px]">Allowed actions</TableHead>
              <TableHead className="w-[160px] text-right">Save</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {games.map((game) => {
              const initial =
                cfg.gamePermissions[game] ?? { userIds: [], roleIds: [], actions: [] };
              // Re-key the row whenever the server-side entry changes so the
              // local userIds/roleIds/actions state reinitialises after Save
              // or Clear — without this, clearing leaves the chips and
              // checkboxes from the deleted entry on screen until reload.
              return (
                <PermissionRow
                  key={`${game}:${JSON.stringify(initial)}`}
                  game={game}
                  initial={initial}
                  busy={busy}
                  onSave={(perm) => onSave(game, perm)}
                  onDelete={() => onDelete(game)}
                />
              );
            })}
          </TableBody>
        </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Single editable row in the per-game permissions table. Holds its own draft
 * state so Save/Clear only fire on the row the operator is touching.
 */
function PermissionRow({
  game,
  initial,
  busy,
  onSave,
  onDelete,
}: {
  game: string;
  initial: DiscordGamePermission;
  busy: boolean;
  onSave: (perm: DiscordGamePermission) => void;
  onDelete: () => void;
}) {
  const [userIds, setUserIds] = useState<string[]>(initial.userIds);
  const [roleIds, setRoleIds] = useState<string[]>(initial.roleIds);
  const [actions, setActions] = useState<DiscordAction[]>(initial.actions);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const dirty =
    JSON.stringify(userIds) !== JSON.stringify(initial.userIds) ||
    JSON.stringify(roleIds) !== JSON.stringify(initial.roleIds) ||
    JSON.stringify([...actions].sort()) !== JSON.stringify([...initial.actions].sort());

  /** Toggle an action in or out of the allowed-actions set. */
  function toggle(a: DiscordAction) {
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));
  }

  return (
    <>
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title={`Clear permissions for ${game}?`}
        description="Per-game permissions will be reset. This is recoverable from infrastructure-as-code."
        confirmLabel="Clear"
        confirmKey="clear-permissions"
        onConfirm={() => { void onDelete(); }}
      />
      <TableRow>
        <TableCell className="font-medium capitalize align-top pt-4">{game}</TableCell>
        <TableCell className="align-top">
          <SnowflakeChipsInput value={userIds} onChange={setUserIds} placeholder="User IDs" />
        </TableCell>
        <TableCell className="align-top">
          <SnowflakeChipsInput value={roleIds} onChange={setRoleIds} placeholder="Role IDs" />
        </TableCell>
        <TableCell className="align-top pt-4">
          <div className="flex flex-col gap-1.5">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={actions.includes(a)}
                  onChange={() => toggle(a)}
                  className="size-3.5 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
                />
                <span className="capitalize">{a}</span>
              </label>
            ))}
          </div>
        </TableCell>
        <TableCell className="text-right align-top pt-4">
          <div className="inline-flex flex-col gap-1.5">
            <Button
              size="sm"
              disabled={busy || !dirty}
              onClick={() => onSave({ userIds, roleIds, actions })}
            >
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (isSuppressed('clear-permissions')) {
                  void onDelete();
                } else {
                  setClearDialogOpen(true);
                }
              }}
            >
              Clear
            </Button>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}
