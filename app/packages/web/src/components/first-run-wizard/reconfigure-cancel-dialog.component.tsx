import { ConfirmDialog } from '../confirm-dialog.component.js';

/** Props for {@link ReconfigureCancelDialog}. */
export interface ReconfigureCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Leaves Reconfigure and returns to Settings. */
  onConfirm: () => void;
}

// @spec APP-WIZARD-RECONF-008
/** Confirms leaving Reconfigure after AWS-side changes were applied, stating that those changes are not undone. */
export function ReconfigureCancelDialog({ open, onOpenChange, onConfirm }: ReconfigureCancelDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel Reconfigure?"
      description="Changes this session already applied to AWS, such as a rotated access key or bootstrap bucket settings, remain in place and were not undone. Answers you did not finish are discarded."
      confirmLabel="Cancel Reconfigure"
      onConfirm={onConfirm}
    />
  );
}
