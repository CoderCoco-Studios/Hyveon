import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge.component';
import { Label } from '@/components/ui/label.component';
import type { DiscordAdmins } from '../../api.service.js';

/** Read-only badge list; used to display base-config user/role IDs that the operator can't edit from the UI. */
function ChipList({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {ids.map((id) => (
        <Badge key={id} variant="secondary" className="font-[var(--font-mono)]">
          {id}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Read-only base-config (Pulumi-applied) admin user/role IDs, shown beneath
 * the editable admin lists. Renders nothing when the base config has no
 * admins.
 */
export function BaseAdminsPanel({ admins }: { admins: DiscordAdmins }) {
  const hasBaseAdmins = admins.userIds.length > 0 || admins.roleIds.length > 0;
  if (!hasBaseAdmins) return null;

  return (
    <div className="border-t border-[var(--color-border)] pt-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <ShieldCheck className="size-3.5" />
        Base config (read-only)
      </div>
      {admins.userIds.length > 0 && (
        <div>
          <Label className="text-xs text-[var(--color-muted-foreground)]">Admin User IDs</Label>
          <ChipList ids={admins.userIds} />
        </div>
      )}
      {admins.roleIds.length > 0 && (
        <div>
          <Label className="text-xs text-[var(--color-muted-foreground)]">Admin Role IDs</Label>
          <ChipList ids={admins.roleIds} />
        </div>
      )}
    </div>
  );
}
