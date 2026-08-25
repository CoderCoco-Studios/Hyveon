import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Badge } from './ui/badge.component.js';
import { cn } from '../lib/utils.utils.js';
import { parseSnowflakes, uniq } from '../lib/snowflake.utils.js';

/**
 * Editable chip-input for Discord snowflake IDs, shared by the Discord page
 * (Admins tab, per-game permissions) and the deployment-settings form's base
 * allowlist fields. Tokens are committed on Enter, comma, blur, or
 * paste-with-separators; a malformed token stays in the draft input with an
 * inline error instead of silently becoming a chip.
 */
export function SnowflakeChipsInput({
  value,
  onChange,
  placeholder,
  id,
  onRemoveChip,
  issues,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Applied to the draft `<input>`, e.g. so a `<Label htmlFor>` can target it. */
  id?: string;
  /** When provided, called instead of removing the chip immediately — caller handles confirmation. */
  onRemoveChip?: (id: string) => void;
  /** External validation issues (e.g. from a form-level validator) rendered alongside this input's own parse errors. */
  issues?: string[];
}) {
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  /**
   * Parse the current draft (plus optional pasted text) and commit any valid
   * snowflakes as chips. Invalid tokens are left in the input for the operator
   * to correct.
   */
  function commit(extra?: string) {
    const combined = (draft + (extra ? ' ' + extra : '')).trim();
    if (!combined) return;
    const { valid, invalid } = parseSnowflakes(combined);
    if (valid.length) onChange(uniq([...value, ...valid]));
    setDraft(invalid.join(', '));
    setParseError(invalid.length ? `Not a snowflake: ${invalid.join(', ')}` : null);
  }

  /** Remove a chip by id. */
  function removeAt(id: string) {
    onChange(value.filter((v) => v !== id));
  }

  const allErrors = [...(issues ?? []), ...(parseError ? [parseError] : [])];

  return (
    <div>
      <div
        className={cn(
          'flex flex-wrap gap-1.5 p-2 min-h-9 rounded-[var(--radius-sm)] border bg-[var(--color-surface-2)] focus-within:ring-1 focus-within:ring-[var(--color-primary)]',
          allErrors.length ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
        )}
      >
        {value.map((chipId) => (
          <Badge key={chipId} variant="secondary" className="font-[var(--font-mono)] gap-1">
            {chipId}
            <button
              type="button"
              // Blur on the draft input commits it before a click fires; prevent the
              // mousedown-triggered blur so removing a chip doesn't also commit a
              // half-typed draft first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (onRemoveChip ? onRemoveChip(chipId) : removeAt(chipId))}
              aria-label={`Remove ${chipId}`}
              className="hover:text-[var(--color-red)]"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          className="flex-1 min-w-[180px] bg-transparent outline-none text-sm font-[var(--font-mono)] placeholder:text-[var(--color-muted-foreground)]"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (parseError) setParseError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && value.length) {
              const last = value[value.length - 1];
              if (onRemoveChip) {
                onRemoveChip(last);
              } else {
                onChange(value.slice(0, -1));
              }
            }
          }}
          onBlur={() => commit()}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[\s,\n]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder={placeholder}
        />
      </div>
      {allErrors.map((message, index) => (
        <p key={index} role="alert" className="mt-1 text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      ))}
    </div>
  );
}
