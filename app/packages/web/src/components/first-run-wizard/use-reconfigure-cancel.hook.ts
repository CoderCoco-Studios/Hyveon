import { useState } from 'react';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';

/** Options for {@link useReconfigureCancel}. */
export interface UseReconfigureCancelOptions {
  /** Leaves Reconfigure and returns to Settings. */
  onCancel?: () => void;
  /** Per-resource bootstrap outcomes; any resource that left `pending` means a bootstrap run started and may have touched AWS. */
  bootstrapStatuses: Record<BootstrapResourceKey, BootstrapResourceState>;
}

/** Return value of {@link useReconfigureCancel}. */
export interface UseReconfigureCancelResult {
  /** Records that guided rotation completed this session. */
  markGuidedRotated: () => void;
  /** Records that the buffered answers were written to the store on entering stack-init. */
  markCommitted: () => void;
  cancelConfirmOpen: boolean;
  setCancelConfirmOpen: (open: boolean) => void;
  /** Cancel click: leaves at once when nothing was applied, otherwise opens the confirmation. */
  handleCancel: () => void;
}

// @spec APP-WIZARD-RECONF-007, APP-WIZARD-RECONF-008
/**
 * Owns Reconfigure's Cancel bookkeeping: whether anything Cancel cannot undo has happened (a guided rotation, a
 * bootstrap run, or the commit made on entering stack-init) and the confirmation dialog that states so.
 */
export function useReconfigureCancel({ onCancel, bootstrapStatuses }: UseReconfigureCancelOptions): UseReconfigureCancelResult {
  const [guidedRotated, setGuidedRotated] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  // A failed or in-flight step may still have created a bucket or the runs table, and a retry resets earlier outcomes.
  const changed = guidedRotated || committed || Object.values(bootstrapStatuses).some((status) => status !== 'pending');

  function handleCancel() {
    if (changed) setCancelConfirmOpen(true);
    else onCancel?.();
  }

  return {
    markGuidedRotated: () => setGuidedRotated(true),
    markCommitted: () => setCommitted(true),
    cancelConfirmOpen,
    setCancelConfirmOpen,
    handleCancel,
  };
}
