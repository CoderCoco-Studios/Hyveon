import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog.component';
import { Input } from '@/components/ui/input.component';
import { suppress } from '../lib/confirm-skip.utils.js';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /**
   * When provided, shows a "Don't ask again for this session" checkbox.
   * The key is stored in the module-level session store so the caller can
   * bypass opening the dialog on future clicks via `isSuppressed(confirmKey)`.
   */
  confirmKey?: string;
  /**
   * When provided, shows a text input; the confirm button stays disabled
   * until the typed value exactly matches this string (e.g. a guild ID).
   */
  typeToConfirm?: string;
}

/**
 * Generic confirmation dialog for destructive actions. Wraps shadcn AlertDialog
 * with optional type-to-confirm input and "don't ask again" session suppression.
 * ESC, focus-trap, and reduce-motion are handled by Radix automatically.
 */
export function ConfirmDialog({ open, onOpenChange, ...body }: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/*
        The per-opening form state lives in ConfirmDialogBody, which Radix
        unmounts whenever the dialog closes. That makes "clear the typed value
        and the don't-ask-again checkbox between openings" a consequence of the
        component's lifecycle rather than an effect that watches `open` and
        calls setState (`react-hooks/set-state-in-effect`). The explicit `key`
        pins the guarantee: even if AlertDialogContent were ever given
        `forceMount`, flipping `open` still produces a fresh body.
      */}
      <AlertDialogContent>
        <ConfirmDialogBody key={String(open)} {...body} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Inner form of {@link ConfirmDialog}. Split out purely so its state is scoped
 * to one opening of the dialog — see the comment at the call site.
 */
function ConfirmDialogBody({
  title,
  description,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmKey,
  typeToConfirm,
}: Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>) {
  const [typed, setTyped] = useState('');
  const [skipSession, setSkipSession] = useState(false);

  const confirmDisabled = typeToConfirm !== undefined && typed !== typeToConfirm;

  function handleConfirm() {
    if (confirmKey && skipSession) suppress(confirmKey);
    onConfirm();
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>

      {typeToConfirm !== undefined && (
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={typeToConfirm}
          className="font-[var(--font-mono)]"
          aria-label="Type to confirm"
        />
      )}

      {confirmKey && (
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] cursor-pointer">
          <input
            type="checkbox"
            checked={skipSession}
            onChange={(e) => setSkipSession(e.target.checked)}
            className="size-3.5 rounded"
          />
          Don&apos;t ask again for this session
        </label>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={handleConfirm} disabled={confirmDisabled}>
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
