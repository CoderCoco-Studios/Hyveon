import { useMemo } from 'react';
import { Server, DollarSign, TrendingUp, Bell } from 'lucide-react';
import { type CostEstimates, type GameStatus } from '../api.service.js';
import { cn } from '../lib/utils.utils.js';
import { formatUsd } from '../lib/format.utils.js';

interface Props {
  statuses: GameStatus[];
  estimates: CostEstimates | null;
}

type AccentColor = 'purple' | 'cyan' | 'orange' | 'pink';

interface TileSpec {
  accent: AccentColor;
  label: string;
  Icon: typeof Server;
  value: string;
  delta?: { text: string; tone: 'good' | 'bad' | 'neutral' } | null;
}

/**
 * Tailwind class lookup keyed by accent color and the visual element it
 * styles. Grouped so each tile pulls its rule / icon classes from the
 * same place — `ACCENT.rule[accent]`, `ACCENT.icon[accent]`.
 */
const ACCENT: Record<'rule' | 'icon', Record<AccentColor, string>> = {
  rule: {
    purple: 'bg-[var(--color-primary)]',
    cyan:   'bg-[var(--color-cyan)]',
    orange: 'bg-[var(--color-orange)]',
    pink:   'bg-[var(--color-pink)]',
  },
  icon: {
    purple: 'text-[var(--color-primary-light)]',
    cyan:   'text-[var(--color-cyan-light)]',
    orange: 'text-[var(--color-orange)]',
    pink:   'text-[var(--color-pink)]',
  },
};

/** Calendar days in the current month — used by the "Est. month cap" tile. */
function currentMonthDays(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/**
 * KPI strip rendered at the top of the Dashboard. Shows four tiles —
 * Servers running, Current run rate, Est. month cap, Active alerts — each
 * with a top color accent rule. "Current run rate" (the sum of `costPerHour`
 * across games whose current status is `running`) and "Est. month cap"
 * (`totalPerHourIfAllOn × 24 × days in the current month`) are derived
 * entirely from the free per-game Fargate estimate (`estimates`) and current
 * run state (`statuses`) — the app makes no AWS Cost Explorer API calls, ever
 * (see `openspec/changes/remove-cost-explorer-calls`).
 */
export function KpiStrip({ statuses, estimates }: Props) {
  const tiles = useMemo<TileSpec[]>(() => {
    const total = statuses.length;
    const running = statuses.filter((s) => s.state === 'running').length;
    const errors  = statuses.filter((s) => s.state === 'error').length;

    const runRate = statuses
      .filter((s) => s.state === 'running')
      .reduce((sum, s) => sum + (estimates?.games[s.game]?.costPerHour ?? 0), 0);

    const totalIfAllOn = estimates?.totalPerHourIfAllOn ?? 0;
    const monthCap = totalIfAllOn * 24 * currentMonthDays();

    return [
      {
        accent: 'purple',
        label: 'Servers running',
        Icon: Server,
        value: total === 0 ? '—' : `${running}/${total}`,
        delta: total === 0
          ? null
          : { text: running === 0 ? 'all idle' : `${running} active`, tone: 'neutral' },
      },
      {
        accent: 'cyan',
        label: 'Current run rate',
        Icon: DollarSign,
        value: formatUsd(runRate, { digits: 2, grouping: false }),
        delta: { text: 'per hour', tone: 'neutral' },
      },
      {
        accent: 'orange',
        label: 'Est. month cap',
        Icon: TrendingUp,
        value: formatUsd(monthCap, { digits: 2, grouping: false }),
        delta: { text: 'if every game ran all month', tone: 'neutral' },
      },
      {
        accent: 'pink',
        label: 'Active alerts',
        Icon: Bell,
        value: String(errors),
        delta: errors === 0
          ? { text: 'all healthy', tone: 'good' }
          : { text: `${errors} need attention`, tone: 'bad' },
      },
    ];
  }, [statuses, estimates]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {tiles.map((t) => (
        <KpiTile key={t.label} {...t} />
      ))}
    </div>
  );
}

function KpiTile({ accent, label, Icon, value, delta }: TileSpec) {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {/* Top accent rule */}
      <div className={cn('absolute top-0 left-0 right-0 h-0.5', ACCENT.rule[accent])} />

      <div className="flex items-center justify-between mb-3">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-[var(--color-muted-foreground)]">
          {label}
        </span>
        <Icon className={cn('size-4', ACCENT.icon[accent])} aria-hidden="true" />
      </div>

      <div className="font-[var(--font-ui)] text-2xl font-bold leading-none mb-2 text-[var(--color-foreground)]">
        {value}
      </div>

      {delta && (
        <div
          className={cn(
            'text-[0.7rem]',
            delta.tone === 'good' && 'text-[var(--color-green)]',
            delta.tone === 'bad'  && 'text-[var(--color-red)]',
            delta.tone === 'neutral' && 'text-[var(--color-muted-foreground)]',
          )}
        >
          {delta.text}
        </div>
      )}
    </div>
  );
}
