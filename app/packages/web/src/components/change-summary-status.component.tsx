import type { ChangeSummary, OpType } from '@hyveon/desktop-preload';
import { Badge } from './ui/badge.component.js';

/**
 * {@link OpType} keys bucketed for display. Each bucket sums to a
 * single badge rather than rendering one badge per raw `OpType` — most runs
 * only ever populate a handful of the 15 possible keys, and the replacement
 * pair (`create-replacement`/`delete-replaced`) plus `import`/
 * `import-replacement` all read as "a resource came into existence" to an
 * operator skimming the summary, same for the two delete variants.
 */
const CREATE_OPS: readonly OpType[] = ['create', 'create-replacement', 'import', 'import-replacement'];
const DELETE_OPS: readonly OpType[] = ['delete', 'delete-replaced'];
/**
 * The rare, mostly-internal engine ops (refresh bookkeeping, discarded steps,
 * pending-replace cancellations, plain reads) — summed into a single "other"
 * badge rather than given their own bucket. Omitted entirely from the
 * summary when none of them fired.
 */
const OTHER_OPS: readonly OpType[] = [
  'read',
  'read-replacement',
  'refresh',
  'discard',
  'discard-replaced',
  'remove-pending-replace',
];

/** Sums `summary`'s counts across the given {@link OpType} keys, treating an absent key as 0. */
function sumOps(summary: ChangeSummary, ops: readonly OpType[]): number {
  return ops.reduce((total, op) => total + (summary[op] ?? 0), 0);
}

/**
 * True when `summary` is absent, or present but every {@link OpType} key on
 * it is absent/zero. Per `ChangeSummary`'s own TSDoc
 * (`@hyveon/shared/src/changeSummary.ts`) this means the engine's structured
 * summary event was never observed for the run (e.g. the process was killed
 * before it fired) — it must never be read as "no changes happened". A
 * genuine no-op reports `{ same: N }` for N ≥ 1, which fails this check.
 *
 * A stack with zero resources total is the one legitimately ambiguous edge
 * case: Pulumi would also report `{}` for it, indistinguishable from a
 * summary that was never observed. This function deliberately treats that
 * case as "unavailable" too rather than guessing "no changes" — an operator
 * seeing "summary unavailable" on a genuinely empty stack loses nothing (the
 * log above still shows the run completed successfully), whereas guessing
 * "no changes" on a run that actually failed to report anything would be a
 * false reassurance.
 */
function isSummaryUnavailable(summary: ChangeSummary | undefined): boolean {
  if (!summary) return true;
  return Object.values(summary).every((count) => !count);
}

/** True when `summary` reports changes via `same` only — a genuine no-op run, distinct from "unavailable" (see {@link isSummaryUnavailable}). */
function isNoOpSummary(summary: ChangeSummary): boolean {
  const { same, ...rest } = summary;
  return (same ?? 0) > 0 && Object.values(rest).every((count) => !count);
}

/**
 * Resource-change summary display shared by the plan, apply, and destroy
 * sections — reads the structured {@link ChangeSummary} the Pulumi engine
 * reports directly off the persisted run record. Renders one of three
 * states: "summary unavailable" when the structured event was never
 * observed, a dedicated no-op message when the run only reports `same`, or
 * grouped badges for the ops that actually changed something.
 *
 * Exported so the live Plan/Apply page, the read-only run-history table, and
 * the run-detail view can all reuse this exact three-way distinction instead
 * of reimplementing it.
 */
export function ChangeSummaryStatus({ summary }: { summary: ChangeSummary | undefined }) {
  if (isSummaryUnavailable(summary)) {
    return <span className="text-sm italic text-[var(--color-muted-foreground)]">Change summary unavailable</span>;
  }

  // Non-null: isSummaryUnavailable(summary) === false only when summary is present.
  const s = summary!;

  if (isNoOpSummary(s)) {
    return <Badge variant="secondary">No changes — {s.same} unchanged</Badge>;
  }

  const creates = sumOps(s, CREATE_OPS);
  const updates = s.update ?? 0;
  const replaces = s.replace ?? 0;
  const deletes = sumOps(s, DELETE_OPS);
  const other = sumOps(s, OTHER_OPS);
  const unchanged = s.same ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {creates > 0 && <Badge variant="cyan">{creates} to create</Badge>}
      {updates > 0 && <Badge variant="warning">{updates} to update</Badge>}
      {replaces > 0 && <Badge variant="outline">{replaces} to replace</Badge>}
      {deletes > 0 && <Badge variant="destructive">{deletes} to delete</Badge>}
      {other > 0 && <Badge variant="default">{other} other</Badge>}
      {unchanged > 0 && <Badge variant="secondary">{unchanged} unchanged</Badge>}
    </div>
  );
}
