import { Link } from 'react-router-dom';

/**
 * "Rollback of apply run X" line linking to the apply run a plan/run record was restored from —
 * shared by the live Plan/Apply page and the read-only run-detail view, both of which render it
 * only when the record carries `rolledBackFrom`.
 */
export function RolledBackFromLink({ applyRunId }: { applyRunId: string }) {
  return (
    <p className="text-sm text-[var(--color-muted-foreground)]">
      Rollback of{' '}
      <Link to={`/iac/history/${applyRunId}`} className="text-[var(--color-primary)] underline underline-offset-2">
        apply run {applyRunId}
      </Link>
    </p>
  );
}
