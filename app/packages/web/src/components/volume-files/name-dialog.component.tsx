import { useState, type FormEvent } from 'react';
import { isValidEntryName } from '@hyveon/shared/volumeFiles';
import { Button } from '@/components/ui/button.component';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.component';
import { Input } from '@/components/ui/input.component';
import { InlineAlert } from '../inline-alert.component.js';

/** Message shown for a name {@link isValidEntryName} rejects. */
export const INVALID_NAME_MESSAGE = "Names can't be empty, . or .., contain / or \\, or be longer than 255 bytes.";

/** Props for {@link NameDialog}. */
export interface NameDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /** Accessible label of the name input. */
  label: string;
  submitLabel: string;
  initialValue?: string;
  /** Called with a valid name; the dialog closes right after. */
  onSubmit(name: string): void;
}

/** Form body, mounted per opening so the typed value and error reset between openings. */
function NameForm({ label, submitLabel, initialValue = '', onSubmit, onCancel }: Pick<NameDialogProps, 'label' | 'submitLabel' | 'initialValue' | 'onSubmit'> & { onCancel(): void }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidEntryName(value)) {
      setError(INVALID_NAME_MESSAGE);
      return;
    }
    onSubmit(value);
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <Input
        aria-label={label}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        autoFocus
      />
      <InlineAlert message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Prompts for one entry name (new folder or rename) and validates it with `isValidEntryName` before submitting.
 *
 * @param props - See {@link NameDialogProps}.
 */
export function NameDialog({ open, onOpenChange, title, label, submitLabel, initialValue, onSubmit }: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Enter a name for this entry.</DialogDescription>
        </DialogHeader>
        <NameForm
          key={String(open)}
          label={label}
          submitLabel={submitLabel}
          initialValue={initialValue}
          onSubmit={(name) => {
            onSubmit(name);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
