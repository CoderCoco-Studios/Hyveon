import { Badge } from '@/components/ui/badge.component';
import { Button } from '@/components/ui/button.component';
import { TableCell, TableRow } from '@/components/ui/table.component';

/**
 * Single row in the guild allowlist table: guild ID, registered/locked
 * status badges, and Register/Remove actions. Base-config guilds are locked
 * (non-removable) but still registerable.
 */
export function GuildRow({
  id,
  locked,
  busy,
  registered,
  onRegister,
  onRequestRemove,
}: {
  id: string;
  locked: boolean;
  busy: boolean;
  registered: boolean;
  onRegister: (id: string) => void;
  onRequestRemove: (id: string) => void;
}) {
  return (
    <TableRow>
      <TableCell className="font-[var(--font-mono)] text-xs">{id}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {registered ? (
            <Badge variant="success">registered</Badge>
          ) : (
            <Badge variant="secondary">not registered</Badge>
          )}
          {locked && (
            <Badge variant="outline" className="text-[0.65rem]">
              base
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRegister(id)}>
            Register
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || locked}
            onClick={() => onRequestRemove(id)}
            title={
              locked
                ? 'Locked by the base deployment config — edit "Base allowed guild IDs" on the Settings page, then plan and apply.'
                : undefined
            }
          >
            Remove
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
