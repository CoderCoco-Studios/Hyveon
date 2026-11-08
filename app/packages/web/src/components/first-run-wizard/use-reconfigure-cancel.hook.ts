import { useState } from 'react';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';

/** Options for {@link useReconfigureCancel}. */
export interface UseReconfigureCancelOptions {
  /** Leaves Reconfigure and returns to Settings. */
  onCancel?: () => void;
  /** Per-resource bootstrap outcomes; a `created` or `exists` resource means AWS was already touched; a `failed` one created nothing. */
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
  const changed = guidedRotated || committed || Object.values(bootstrapStatuses).some((status) => status === 'created' || status === 'exists');

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
