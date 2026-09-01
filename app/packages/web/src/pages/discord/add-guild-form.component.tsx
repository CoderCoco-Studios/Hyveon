import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { isSnowflake } from './snowflake.utils.js';

/**
 * "Add a guild" input. Validates the entered ID as a Discord snowflake and
 * rejects one already present in `existingIds` before calling `onAdd`.
 */
export function AddGuildForm({
  existingIds,
  busy,
  onAdd,
}: {
  /** Every guild ID already allowlisted (base config + dynamic), used to reject a duplicate add. */
  existingIds: string[];
  busy: boolean;
  onAdd: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Validate and submit the draft guild ID; shows an inline error if malformed or already listed. */
  function handleAdd() {
    const id = draft.trim();
    if (!id) return;
    if (!isSnowflake(id)) {
      setError('Guild IDs are 17–20 digit Discord snowflakes.');
      return;
    }
    if (existingIds.includes(id)) {
      setError('That guild is already allowlisted.');
      return;
    }
    setError(null);
    setDraft('');
    onAdd(id);
  }

  return (
    <div>
      <Label htmlFor="add-guild" className="mb-2 block">
        Add a guild
      </Label>
      <div className="flex gap-2">
        <Input
          id="add-guild"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Guild (server) ID — 17–20 digits"
          aria-invalid={error ? 'true' : 'false'}
        />
        <Button variant="secondary" disabled={busy || !draft.trim()} onClick={handleAdd}>
          Add
        </Button>
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertCircle className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
