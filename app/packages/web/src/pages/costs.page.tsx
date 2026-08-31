import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Search } from 'lucide-react';
import { api, type CostEstimates, type GameEstimate } from '../api.service.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.component';
import { cn } from '@/lib/utils.utils';
import { PageHeader } from '../components/page-header.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

/**
 * Per-game color tokens used by the estimates table's game swatches. Order is
 * the spec recommendation (cyan, purple, orange, pink), with extra accents
 * appended so we don't run out as new games are added.
 */
const GAME_COLOR_VARS = [
  '--color-cyan',
  '--color-primary',
  '--color-orange',
  '--color-pink',
  '--color-primary-light',
  '--color-cyan-light',
  '--color-amber',
  '--color-green',
  '--color-red',
] as const;

/** Static AWS Cost Explorer console home URL — no query-string filters (design.md D4: undocumented deep-link params could break silently on an AWS console update). */
const AWS_COST_EXPLORER_URL = 'https://console.aws.amazon.com/cost-management/home#/cost-explorer';

/** Sortable column keys for the estimates table. */
type SortKey = 'game' | 'vcpu' | 'memoryGb' | 'costPerHour' | 'costPerDay24h' | 'costPerMonth4hpd';
type SortDir = 'asc' | 'desc';

interface EstimateRow extends GameEstimate {
  game: string;
}

/** Format a dollar amount with sensible precision for the value's magnitude. */
function formatUsd(value: number, opts: { precise?: boolean } = {}): string {
  const digits = opts.precise ? (value < 1 ? 4 : 2) : 2;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Fetches the per-game Fargate cost estimates once on mount. The app makes no
 * AWS Cost Explorer API calls — see `openspec/changes/remove-cost-explorer-calls`.
 */
function useCostEstimates(): { estimates: CostEstimates | null } {
  const [estimates, setEstimates] = useState<CostEstimates | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.costsEstimate()
      .then((est) => {
        if (!cancelled) setEstimates(est);
      })
      .catch(() => { /* leave estimates null; the table renders an empty state */ });
    return () => { cancelled = true; };
  }, []);

  return { estimates };
}

/**
 * Cost analysis route (`/costs`). Renders a sortable per-game Fargate cost
 * estimate table plus a callout linking out to the AWS Cost Explorer console
 * for real billed spend. The app makes no AWS Cost Explorer API calls, ever —
 * see `openspec/changes/remove-cost-explorer-calls`.
 */
export function CostsPage() {
  const { estimates } = useCostEstimates();

  const games = useMemo(
    () => (estimates ? Object.keys(estimates.games).sort() : []),
    [estimates],
  );
  const colorByGame = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    games.forEach((g, i) => {
      map[g] = `var(${GAME_COLOR_VARS[i % GAME_COLOR_VARS.length]})`;
    });
    return map;
  }, [games]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Cost Analysis"
        subtitle="Per-game Fargate cost estimates. For real billed spend, see AWS Cost Explorer."
      >
        <PollingIndicator />
      </PageHeader>

      <CostExplorerCallout />

      <EstimatesTable estimates={estimates} colorByGame={colorByGame} />
    </div>
  );
}

/** Callout card linking out to the real AWS Cost Explorer console — the app itself renders no actual-billed-spend figures. */
function CostExplorerCallout() {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
        <div>
          <p className="text-sm font-medium text-[var(--color-foreground)]">Want real billed spend?</p>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            The table below is a Fargate-spec estimate, not a bill. See actual dollars charged to
            your AWS account in Cost Explorer.
          </p>
        </div>
        <a
          href={AWS_COST_EXPLORER_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 text-sm text-[var(--color-primary-light)] underline-offset-4 hover:underline"
        >
          Open AWS Cost Explorer
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </CardContent>
    </Card>
  );
}

/** Sortable, filterable per-game estimates table. Default sort is `$/hr` descending. */
function EstimatesTable({
  estimates,
  colorByGame,
}: {
  estimates: CostEstimates | null;
  colorByGame: Record<string, string>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('costPerHour');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filter, setFilter] = useState('');

  const rows: EstimateRow[] = useMemo(
    () =>
      estimates
        ? Object.entries(estimates.games).map(([game, est]) => ({ game, ...est }))
        : [],
    [estimates],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.game.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'game' ? 'asc' : 'desc');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-4">
        <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
          Per-game estimates
        </CardTitle>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter games…"
            className="pl-7 h-8 text-xs"
          />
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            No estimates available.
          </div>
        ) : (
          <>
            {/* Mobile card stack — visible below md */}
            <div className="md:hidden space-y-3">
              {sorted.map((r) => (
                <div key={r.game} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="size-2.5 rounded-sm shrink-0"
                      style={{ background: colorByGame[r.game] ?? 'var(--color-muted-foreground)' }}
                      aria-hidden
                    />
                    <span className="capitalize font-medium text-sm text-[var(--color-foreground)]">{r.game}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-[var(--color-muted-foreground)]">vCPU</span>
                    <span className="font-[var(--font-mono)] text-right">{r.vcpu}</span>
                    <span className="text-[var(--color-muted-foreground)]">Memory</span>
                    <span className="font-[var(--font-mono)] text-right">{r.memoryGb} GB</span>
                    <span className="text-[var(--color-muted-foreground)]">$/hour</span>
                    <span className="font-[var(--font-mono)] text-right text-[var(--color-primary-light)]">{formatUsd(r.costPerHour, { precise: true })}</span>
                    <span className="text-[var(--color-muted-foreground)]">$/day</span>
                    <span className="font-[var(--font-mono)] text-right">{formatUsd(r.costPerDay24h)}</span>
                    <span className="text-[var(--color-muted-foreground)]">$/month</span>
                    <span className="font-[var(--font-mono)] text-right">{formatUsd(r.costPerMonth4hpd)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table — visible at md+ */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader label="Game"     sortKey="game"            currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
                    <SortableHeader label="vCPU"     sortKey="vcpu"            currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                    <SortableHeader label="Memory"   sortKey="memoryGb"        currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                    <SortableHeader label="$/hour"   sortKey="costPerHour"     currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                    <SortableHeader label="$/day"    sortKey="costPerDay24h"   currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                    <SortableHeader label="$/month"  sortKey="costPerMonth4hpd" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => (
                    <TableRow key={r.game}>
                      <TableCell className="capitalize">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-sm shrink-0"
                            style={{ background: colorByGame[r.game] ?? 'var(--color-muted-foreground)' }}
                            aria-hidden
                          />
                          {r.game}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-[var(--font-mono)]">{r.vcpu}</TableCell>
                      <TableCell className="text-right font-[var(--font-mono)]">{r.memoryGb} GB</TableCell>
                      <TableCell className="text-right font-[var(--font-mono)] text-[var(--color-primary-light)]">
                        {formatUsd(r.costPerHour, { precise: true })}
                      </TableCell>
                      <TableCell className="text-right font-[var(--font-mono)]">
                        {formatUsd(r.costPerDay24h)}
                      </TableCell>
                      <TableCell className="text-right font-[var(--font-mono)]">
                        {formatUsd(r.costPerMonth4hpd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <p className="mt-3 text-[0.7rem] text-[var(--color-muted-foreground)]">
          $/day assumes 24 hr/day. $/month assumes 4 hr/day × 30 days.
        </p>
      </CardContent>
    </Card>
  );
}

/** Header cell that renders a sort indicator and toggles sort state on click. */
function SortableHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  onClick: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = sortKey === currentKey;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onClick(sortKey)}
        className={cn(
          'h-7 px-1 -mx-1 gap-1 text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
          align === 'right' && 'ml-auto',
          isActive && 'text-[var(--color-foreground)]',
        )}
      >
        {label}
        <Icon className="size-3" aria-hidden="true" />
      </Button>
    </TableHead>
  );
}
