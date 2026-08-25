import { Badge } from './ui/badge.component.js';

/**
 * Read-only "partial" badge shown next to an apply run's status badge when its record carries
 * `partialApply: true` — the Pulumi engine mutated some resources before the run failed or was
 * aborted. Shared verbatim by the run-history table and the read-only run-detail view.
 */
export function PartialApplyBadge() {
  return (
    <Badge
      variant="warning"
      title="Apply stopped partway through — some resources were already changed before this run failed or was aborted."
    >
      partial
    </Badge>
  );
}
