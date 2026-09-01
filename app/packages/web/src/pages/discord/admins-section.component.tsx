import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import { Label } from '@/components/ui/label.component';
import { ConfirmDialog } from '../../components/confirm-dialog.component.js';
import { isSuppressed } from '../../lib/confirm-skip.utils.js';
import { SnowflakeChipsInput } from '../../components/snowflake-chips-input.component.js';
import type { DiscordAdmins, DiscordConfigRedacted } from '../../api.service.js';
import { BaseAdminsPanel } from './base-admins-panel.component.js';

/**
 * Server-wide admin editor: chip-based User ID and Role ID lists. Bulk paste
 * (newline / comma / whitespace separated) is normalized to chips on commit.
 */
export function AdminsSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onSave: (a: DiscordAdmins) => void;
}) {
  const [userIds, setUserIds] = useState<string[]>(cfg.admins.userIds);
  const [roleIds, setRoleIds] = useState<string[]>(cfg.admins.roleIds);
  const [pendingRemove, setPendingRemove] = useState<{ list: 'user' | 'role'; id: string } | null>(null);

  const dirty =
    JSON.stringify(userIds) !== JSON.stringify(cfg.admins.userIds) ||
    JSON.stringify(roleIds) !== JSON.stringify(cfg.admins.roleIds);

  return (
    <>
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => { if (!o) setPendingRemove(null); }}
        title="Remove admin?"
        description="This ID will no longer have admin-level access."
        confirmLabel="Remove"
        confirmKey="remove-admin"
        onConfirm={() => {
          if (pendingRemove) {
            if (pendingRemove.list === 'user') {
              setUserIds((cur) => cur.filter((v) => v !== pendingRemove.id));
            } else {
              setRoleIds((cur) => cur.filter((v) => v !== pendingRemove.id));
            }
          }
          setPendingRemove(null);
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Admins</CardTitle>
          <CardDescription>
            Admins can run every command on every game. Right-click a user or role with Discord
            Developer Mode enabled to copy their ID.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Admin User IDs</Label>
            <SnowflakeChipsInput
              value={userIds}
              onChange={setUserIds}
              placeholder="Paste or type a user ID, then press Enter"
              onRemoveChip={(id) => {
                if (isSuppressed('remove-admin')) {
                  setUserIds((cur) => cur.filter((v) => v !== id));
                } else {
                  setPendingRemove({ list: 'user', id });
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Admin Role IDs</Label>
            <SnowflakeChipsInput
              value={roleIds}
              onChange={setRoleIds}
              placeholder="Paste or type a role ID, then press Enter"
              onRemoveChip={(id) => {
                if (isSuppressed('remove-admin')) {
                  setRoleIds((cur) => cur.filter((v) => v !== id));
                } else {
                  setPendingRemove({ list: 'role', id });
                }
              }}
            />
          </div>

          <div className="flex justify-end">
            <Button disabled={busy || !dirty} onClick={() => onSave({ userIds, roleIds })}>
              Save admins
            </Button>
          </div>

          <BaseAdminsPanel admins={cfg.baseAdmins} />
        </CardContent>
      </Card>
    </>
  );
}
