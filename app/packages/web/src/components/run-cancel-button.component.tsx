import { useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import type { IacRunKind } from '@hyveon/desktop-preload';
import { Button } from './ui/button.component.js';
import { ConfirmDialog } from './confirm-dialog.component.js';

// @spec IAC-RUN-CANCEL-005, IAC-RUN-CANCEL-006
/**
 * "Cancel" control for a streaming plan, apply or destroy run. A plan changes nothing, so it cancels at once; an apply
 * or destroy first asks for confirmation, because stopping the engine mid-operation can leave the infrastructure
 * partially changed.
 *
 * @param kind - Which operation the run is.
 * @param cancelling - Whether a cancel has been requested and the run has not yet settled; disables the button.
 * @param onCancel - Called once the operator has cancelled (and, for apply and destroy, confirmed).
 */
export function RunCancelButton({
  kind,
  cancelling,
  onCancel,
}: {
  kind: IacRunKind;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const needsConfirm = kind !== 'plan';

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={cancelling}
        onClick={() => (needsConfirm ? setConfirmOpen(true) : onCancel())}
      >
        {cancelling ? <Loader2 className="animate-spin" /> : <Square />}
        {cancelling ? 'Cancelling…' : `Cancel ${kind}`}
      </Button>
      {needsConfirm && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Cancel this ${kind}?`}
          description={
            'Cancelling stops the engine mid-operation and can leave the infrastructure partially changed. ' +
            'The run is recorded as aborted; review the stack state before applying again.'
          }
          onConfirm={onCancel}
          confirmLabel={`Stop ${kind}`}
        />
      )}
    </>
  );
}
