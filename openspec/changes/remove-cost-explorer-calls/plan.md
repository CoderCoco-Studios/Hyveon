# Remove Cost Explorer Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every AWS Cost Explorer API call the app makes (automatic or manual) end-to-end — UI, IPC, service, provider, SDK dependency — and replace the UI it fed with free Fargate-spec-derived estimates plus a link-out to the real AWS Cost Explorer console.

**Architecture:** Four independently-shippable PRs, each based on the previous: frontend UI swap first (so the backend IPC channel has zero callers before it's touched), then the backend call-chain deletion, then e2e fixtures/specs, then docs + IAM policy cleanup. No infra/Pulumi changes — this is app code, test fixtures, and one IAM policy doc.

**Tech Stack:** TypeScript, React (`@hyveon/web`), NestJS over Electron IPC (`@hyveon/desktop-main`), `@aws-sdk/client-*` (`@hyveon/cloud-aws`), Vitest (unit/component), Playwright (`electron` project, e2e).

## Global Constraints

- `npm run app:lint` must be clean before every PR is opened.
- `npm run app:typecheck` must be clean before every PR is opened.
- `npm run app:test` (full unit suite) must be green before every PR is opened.
- `npm run app:test:integration` runs for PR 2 (controller/service surface changed).
- `npm run app:test:e2e` runs for PR 1 (renderer changed) and PR 3 (e2e specs/fixtures changed).
- TSDoc comments follow the tag order/spec in `.claude/rules/tsdoc-tags.md` (summary → `@remarks` → `@example` → `@typeParam` → `@param` → `@returns` → `@throws`, modifier tags last); no `@fileoverview`, no bare `@link`.
- Test names read as "should …" sentences (e.g. `it('should return null when …')`), per `CLAUDE.md`.
- No `as unknown as T` casts in new/edited test code — use `vi.mocked(fn)` for mocked modules and `Partial<T> + a single as T` for service-shaped stubs, per `CLAUDE.md`.
- No raw `process.env` in business logic (not applicable to this change — no new env access is introduced).

---

## PR 1: costexplorer-1-frontend (base: main)

Swaps the Dashboard KPI tiles and the Costs page UI to free, Fargate-spec-derived data. The backend `costs.actual` IPC channel still exists after this PR (removed in PR 2) but has zero callers once this PR lands — `npm run app:typecheck` stays clean because nothing here changes `api.service.ts`'s exported surface, only which of its exports get called.

### Task 1: KpiStrip — swap cost tiles for free-data tiles

**Files:**
- Modify: `app/packages/web/src/components/kpi-strip.component.tsx` (full rewrite, 209 lines)
- Test: `app/packages/web/src/components/kpi-strip.component.test.tsx` (new file — none exists today)

**Interfaces:**
- Produces: `KpiStrip(props: { statuses: GameStatus[]; estimates: CostEstimates | null }): JSX.Element` — drops the `actualCosts: ActualCosts | null` prop entirely.
- Consumes: `GameStatus`, `CostEstimates`, `GameEstimate` from `../api.service.js` (unchanged shapes).

This is additive from `KpiStrip`'s own point of view (new tile logic) but the test file is genuinely new, so it follows plain new-feature TDD: write the test against the **current, unmodified** component first (which still requires `actualCosts` and renders "Spend today"/"Forecast MTD"), confirm it fails, then rewrite the component.

- [ ] **Step 1: Write the failing test**
```tsx
// app/packages/web/src/components/kpi-strip.component.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CostEstimates, GameStatus } from '../api.service.js';
import { KpiStrip } from './kpi-strip.component.js';

const ESTIMATES: CostEstimates = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
    valheim:   { vcpu: 1, memoryGb: 2, costPerHour: 0.04, costPerDay24h: 0.96, costPerMonth4hpd: 4.8 },
  },
  totalPerHourIfAllOn: 0.12,
};

describe('KpiStrip', () => {
  it('should render Current run rate and Est. month cap tile labels instead of Spend today and Forecast MTD', () => {
    const statuses: GameStatus[] = [
      { game: 'minecraft', state: 'running' },
      { game: 'valheim', state: 'stopped' },
    ];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    expect(screen.getByText('Current run rate')).toBeInTheDocument();
    expect(screen.getByText('Est. month cap')).toBeInTheDocument();
    expect(screen.queryByText('Spend today')).not.toBeInTheDocument();
    expect(screen.queryByText('Forecast MTD')).not.toBeInTheDocument();
  });

  it('should show $0.00 for Current run rate when no games are running', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'stopped' }];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('should sum costPerHour across running games for Current run rate', () => {
    const statuses: GameStatus[] = [
      { game: 'minecraft', state: 'running' },
      { game: 'valheim', state: 'stopped' },
    ];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    // Only minecraft is running: costPerHour 0.08.
    expect(screen.getByText('$0.08')).toBeInTheDocument();
  });

  it('should compute Est. month cap as totalPerHourIfAllOn times 24 times days in the current month', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'stopped' }];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = `$${(0.12 * 24 * daysInMonth).toFixed(2)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('should render $0.00 for both cost tiles when estimates is null', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'running' }];
    render(<KpiStrip statuses={statuses} estimates={null} />);

    expect(screen.getAllByText('$0.00')).toHaveLength(2);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app/packages/web && npx vitest run src/components/kpi-strip.component.test.tsx`
Expected: FAIL — `screen.getByText('Current run rate')` throws `Unable to find an element with the text: Current run rate` (the current component still renders the "Spend today"/"Forecast MTD" labels because `actualCosts` is `undefined` — the mismatch is caught at the assertion, not as a TypeScript prop error, since Vitest transpiles via esbuild without type-checking).
- [ ] **Step 3: Write minimal implementation**
```tsx
// app/packages/web/src/components/kpi-strip.component.tsx (full file)
import { useMemo } from 'react';
import { Server, DollarSign, TrendingUp, Bell } from 'lucide-react';
import { type CostEstimates, type GameStatus } from '../api.service.js';
import { cn } from '../lib/utils.utils.js';

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
        value: `$${runRate.toFixed(2)}`,
        delta: { text: 'per hour', tone: 'neutral' },
      },
      {
        accent: 'orange',
        label: 'Est. month cap',
        Icon: TrendingUp,
        value: `$${monthCap.toFixed(2)}`,
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
```
Note: this removes the sparkline entirely (the `pad7`, `forecastMonthly`, `pctChange` helpers and the `spark` field on `TileSpec`). The sparkline's only data source was `ActualCosts.daily` (a 7-day array), reused across all four tiles as a "coarse activity proxy" per the old doc comment; with no daily array anywhere in the app any more, a permanently-flat sparkline would be dead visual weight, not a graceful degradation — dropping it is a necessary consequence of the data source disappearing, not a separate design choice.
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app/packages/web && npx vitest run src/components/kpi-strip.component.test.tsx`
Expected: PASS (5 tests)
- [ ] **Step 5: Commit**
```bash
git add app/packages/web/src/components/kpi-strip.component.tsx app/packages/web/src/components/kpi-strip.component.test.tsx
git commit -m "feat(web): swap dashboard KPI cost tiles for free Fargate-estimate data"
```

### Task 2: DashboardPage — drop the `costsActual` fetch effect

**Files:**
- Modify: `app/packages/web/src/pages/dashboard.page.tsx:1-49`
- Test: `app/packages/web/src/pages/dashboard.page.test.tsx`

**Interfaces:**
- Consumes: `KpiStrip` from Task 1 (no longer accepts `actualCosts`).
- Produces: `DashboardPage(): JSX.Element` with no behavioral change to the rest of the page.

Deletion-style task — no new behavior to test-first, so the "failing test" step updates the existing test to assert the new (absence-of-call) behavior, confirmed to fail against the current code, then the implementation is removed.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```tsx
// app/packages/web/src/pages/dashboard.page.test.tsx
// In the `beforeEach` block, remove the costsActual stub (keep the mock fn declared
// in the hoisted `apiMock` object — api.service.ts still exports costsActual until PR 2):
  beforeEach(() => {
    apiMock.status.mockResolvedValue(STATUSES);
    apiMock.costsEstimate.mockResolvedValue(ESTIMATES);
    apiMock.drift.mockResolvedValue({ entries: [] });
  });

// Add a new test after the existing 'should render the polling indicator …' test:
  it('should not call api.costsActual on mount', async () => {
    renderPage(<DashboardPage />);

    await screen.findByRole('heading', { name: 'minecraft' });

    expect(apiMock.costsActual).not.toHaveBeenCalled();
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app/packages/web && npx vitest run src/pages/dashboard.page.test.tsx`
Expected: FAIL — `apiMock.costsActual` was called once (the current `dashboard.page.tsx` still runs `void api.costsActual().then(setActualCosts).catch(() => undefined)` on mount), so `expect(apiMock.costsActual).not.toHaveBeenCalled()` fails with "expected costsActual not to be called, but it was called 1 time".
- [ ] **Step 3: Write minimal implementation**
```tsx
// app/packages/web/src/pages/dashboard.page.tsx
// Replace the import block (lines 1-13):
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Server, ExternalLink } from 'lucide-react';
import { useGameStatus } from '../polling/game-status-provider.component.js';
import { useFileManager } from '../hooks/use-file-manager.hook.js';
import { GameCard } from '../components/game-card.component.js';
import { KpiStrip } from '../components/kpi-strip.component.js';
import { FileManagerModal } from '../components/file-manager-modal.component.js';
import { PendingChangesBanner } from '../components/pending-changes-banner.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { Input } from '@/components/ui/input.component';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.component';

// Replace the component body (lines 21-32) — drop the actualCosts state/effect:
export function DashboardPage() {
  const { statuses, estimates, loading, refreshGame } = useGameStatus();
  const fileMgr = useFileManager();
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => {
      const host = (s.hostname ?? s.publicIp ?? '').toLowerCase();
      return s.game.toLowerCase().includes(q) || host.includes(q);
    });
  }, [statuses, query]);

// Update the KpiStrip render call (was line 49):
        <KpiStrip statuses={statuses} estimates={estimates} />
```
`api`/`ActualCosts` were only referenced by the removed effect — drop both from the import, and drop `useEffect` from the `react` import since nothing else in this file uses it.
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app/packages/web && npx vitest run src/pages/dashboard.page.test.tsx`
Expected: PASS (all tests, including the new one)
- [ ] **Step 5: Commit**
```bash
git add app/packages/web/src/pages/dashboard.page.tsx app/packages/web/src/pages/dashboard.page.test.tsx
git commit -m "refactor(web): drop dashboard's costsActual fetch effect"
```

### Task 3: CostsPage — remove the actuals UI and simplify data fetching

**Files:**
- Modify: `app/packages/web/src/pages/costs.page.tsx` (large rewrite — drops `RANGES`/`RangeKey`/`RangeOption`/`RangeSelector`, `sumDaily`, `splitDailyByGame`, `formatShortDate`, `DeltaPill`, `Legend`, `StackedBarChart`, the `useCostsData(days)` hook and its actuals-fetch branch)
- Test: `app/packages/web/src/pages/costs.page.test.tsx`

**Interfaces:**
- Produces: `CostsPage(): JSX.Element` — no props. Internally fetches `CostEstimates` once via `api.costsEstimate()`; no `days`/range state anywhere on the page.
- Note on scope beyond `design.md`'s literal list: `design.md`/`tasks.md` name three actuals-driven pieces to remove (total-spend card, delta pill, stacked chart) but don't explicitly call out the 7d/30d `RangeSelector`. That selector's *only* purpose was choosing the `costsActual(days*2)` fetch window — with the actuals-fetch branch gone, it drives nothing (the per-game estimates table doesn't vary with `days`). Keeping a range toggle that no longer changes anything on the page would be dead, confusing UI, so it is removed as a necessary consequence of removing its only data dependency, not a separate design decision.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```tsx
// app/packages/web/src/pages/costs.page.test.tsx (full file — replaces the current one)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { CostsPage } from './costs.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const ESTIMATES = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
    valheim:   { vcpu: 1, memoryGb: 2, costPerHour: 0.04, costPerDay24h: 0.96, costPerMonth4hpd: 4.8 },
  },
  totalPerHourIfAllOn: 0.12,
};

describe('CostsPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue(ESTIMATES);
  });

  it('should render the Cost Analysis heading and the polling indicator wired to the status poll', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    expect(screen.getByRole('heading', { name: 'Cost Analysis' })).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render every configured game in the estimates table once the data resolves', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    expect(await screen.findByRole('cell', { name: 'minecraft' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'valheim' })).toBeInTheDocument();
  });

  it('should render no actual-spend total, delta pill, or stacked chart', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    await screen.findByRole('cell', { name: 'minecraft' });

    expect(screen.queryByText(/Total spend/)).not.toBeInTheDocument();
    expect(screen.queryByText(/vs prior|no prior period/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Daily spend, stacked by game/)).not.toBeInTheDocument();
  });
});
```
This deletes the `ACTUAL` fixture, the `costsActual` mock, and the `'should fetch the doubled actuals window for the active range'` test, and adds an assertion that the removed UI pieces are gone.
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app/packages/web && npx vitest run src/pages/costs.page.test.tsx`
Expected: FAIL with an uncaught error — the current `costs.page.tsx` still calls `api.costsActual(days * 2)` inside `useCostsData`'s effect, but the mocked `../api.service.js` module from this test no longer defines `costsActual` (it was removed from `apiMock`), so `api.costsActual` is `undefined` and calling it throws `TypeError: api.costsActual is not a function` during the effect, failing every test in the file.
- [ ] **Step 3: Write minimal implementation**
```tsx
// app/packages/web/src/pages/costs.page.tsx — replace lines 1-233 (imports through the
// end of the CostsPage component, i.e. everything before `RangeSelector`) with:
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Cost Analysis</h2>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Per-game Fargate cost estimates. For real billed spend, see AWS Cost Explorer.
          </p>
        </div>
        <PollingIndicator />
      </header>

      <EstimatesTable estimates={estimates} colorByGame={colorByGame} />
    </div>
  );
}
```
(`EstimatesTable`, `SortableHeader` are unchanged — leave them exactly as they are today, immediately following this block. The `CostExplorerCallout` component and its render call are added in Task 4, not here.) Also delete the `RANGES`/`RangeKey`/`RangeOption`/`RangeSelector`/`sumDaily`/`splitDailyByGame`/`formatShortDate`/`DeltaPill`/`Legend`/`StackedBarChart`/`useCostsData` definitions that previously sat between the imports and `EstimatesTable` — none of them are referenced by the new code above or by `EstimatesTable`/`SortableHeader` below.
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app/packages/web && npx vitest run src/pages/costs.page.test.tsx`
Expected: PASS (3 tests)
- [ ] **Step 5: Commit**
```bash
git add app/packages/web/src/pages/costs.page.tsx app/packages/web/src/pages/costs.page.test.tsx
git commit -m "refactor(web): remove costs page actuals UI (total spend, delta pill, stacked chart)"
```

### Task 4: CostsPage — add the AWS Cost Explorer link-out callout

**Files:**
- Modify: `app/packages/web/src/pages/costs.page.tsx`
- Test: `app/packages/web/src/pages/costs.page.test.tsx`

**Interfaces:**
- Consumes: `CostsPage` from Task 3.
- Produces: a static exported constant `AWS_COST_EXPLORER_URL` (module-private, no external consumers) and a `CostExplorerCallout()` component rendered inside `CostsPage`.

Pure-addition task — plain new-feature TDD.

- [ ] **Step 1: Write the failing test**
```tsx
// app/packages/web/src/pages/costs.page.test.tsx — append to the describe block:
  it('should show a link to AWS Cost Explorer and no in-app chart or total claiming to be actual billed spend', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    const link = await screen.findByRole('link', { name: /Open AWS Cost Explorer/i });
    expect(link).toHaveAttribute(
      'href',
      'https://console.aws.amazon.com/cost-management/home#/cost-explorer',
    );
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app/packages/web && npx vitest run src/pages/costs.page.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "link" and name /Open AWS Cost Explorer/i` (no callout renders yet).
- [ ] **Step 3: Write minimal implementation**
```tsx
// app/packages/web/src/pages/costs.page.tsx
// Add near the top, after the GAME_COLOR_VARS constant:

/** Static AWS Cost Explorer console home URL — no query-string filters (design.md D4: undocumented deep-link params could break silently on an AWS console update). */
const AWS_COST_EXPLORER_URL = 'https://console.aws.amazon.com/cost-management/home#/cost-explorer';

// Add after the CostsPage component (before EstimatesTable):

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

// Update CostsPage's return to render it between the header and the table:
      <header>...</header>

      <CostExplorerCallout />

      <EstimatesTable estimates={estimates} colorByGame={colorByGame} />
```
(`ExternalLink` is already imported per Task 3's import block.)
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app/packages/web && npx vitest run src/pages/costs.page.test.tsx`
Expected: PASS (4 tests)
- [ ] **Step 5: Commit**
```bash
git add app/packages/web/src/pages/costs.page.tsx app/packages/web/src/pages/costs.page.test.tsx
git commit -m "feat(web): add AWS Cost Explorer link-out callout to the costs page"
```

### Task 5: PR 1 gate and open

- [ ] **Step 1: Run the full frontend gate**
Run, from repo root:
```bash
npm run app:lint
npm run app:typecheck
npm run app:test
npm run app:test:e2e
```
Expected: all four clean/green. (`app:test:e2e` is required because the renderer changed — see Global Constraints. The existing `costs.spec.ts`/`dashboard.spec.ts` e2e specs still assert the OLD KPI labels and stacked-chart UI at this point in the stack; they are expected to fail here and are fixed in PR 3. Confirm the failures are exactly the pre-existing-spec-vs-new-UI mismatches this plan already knows about — `costs.spec.ts`'s delta-pill/stacked-chart/total-spend tests and `dashboard.spec.ts`'s `'Spend today'`/`'Forecast MTD'` label assertions — and not some other regression, before proceeding.)
- [ ] **Step 2: Open the PR**
```bash
git push -u origin costexplorer-1-frontend
gh pr create --title "feat(web): remove Cost Explorer calls from dashboard and costs page" --base main --body "$(cat <<'EOF'
## Summary
- Swap Dashboard KPI cost tiles ("Spend today"/"Forecast MTD") for free Fargate-estimate tiles ("Current run rate"/"Est. month cap") — zero new fetches.
- Remove the Costs page's actuals UI (total-spend card, delta-vs-prior pill, stacked daily-by-game chart) and its 7d/30d range selector — no free substitute exists for historical billed spend.
- Add an AWS Cost Explorer link-out callout to the Costs page for real billed figures.
- Backend `costs.actual` IPC channel is untouched here (PR 2) but now has zero callers.

Part of the `remove-cost-explorer-calls` PR stack (1/4). See `openspec/changes/remove-cost-explorer-calls/design.md`.

## Test plan
- [x] `npm run app:lint`
- [x] `npm run app:typecheck`
- [x] `npm run app:test`
- [x] `npm run app:test:e2e` (pre-existing failures in `costs.spec.ts`/`dashboard.spec.ts` expected — fixed in PR 3 of this stack)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened against `main`, titled per Conventional Commits.

---

## PR 2: costexplorer-2-backend (base: costexplorer-1-frontend)

Deletes the Cost Explorer call chain end-to-end: `CloudProvider.getActualCosts` (`@hyveon/shared`), `AwsCloudProvider.getActualCosts` + the `@aws-sdk/client-cost-explorer` dependency (`@hyveon/cloud-aws`), `CostService.getActualCosts` (`@hyveon/desktop-main`), the `costs.actual` `@MessagePattern` handler, the preload bridge method, and `api.service.ts`'s `costsActual()`.

**Important correction to `proposal.md`'s stated impact list:** `proposal.md` says "the `ActualCosts`/`CostBreakdown` types" are both removed. That's wrong for `CostBreakdown` — it's defined in `@hyveon/shared/src/cloud.ts` and is the return type of **both** `getCostEstimate()` (kept — it's the free, non-billed estimate path, unrelated to Cost Explorer) and `getActualCosts()` (removed). Deleting `CostBreakdown` would break `getCostEstimate()`'s signature, which nothing in this change touches. Only `DateRange` (used exclusively by `getActualCosts`'s parameter) and the desktop-main/preload/web-layer `ActualCosts` type (a completely different, unrelated type also named `ActualCosts`, defined separately in three places) are removed. Every task below reflects this correction.

### Task 6: `@hyveon/shared/src/cloud.ts` — remove `DateRange` and `CloudProvider.getActualCosts`

**Files:**
- Modify: `app/packages/shared/src/cloud.ts:30-60`
- Test: `app/packages/shared/src/cloud.test.ts`

**Interfaces:**
- Produces: `CloudProvider` with five methods (`startWorkload`, `stopWorkload`, `getWorkloadStatus`, `streamWorkloadLogs`, `getCostEstimate`) — `getActualCosts` and the `DateRange` type are gone. `CostBreakdown` is retained unchanged (still `getCostEstimate`'s return type).
- Consumes: nothing new.

This is a pure type-level change — Vitest's esbuild transform doesn't type-check, so the verification gate is `npm run app:typecheck`, not `npm run app:test`.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```ts
// app/packages/shared/src/cloud.test.ts
// Remove `DateRange` from the type-only import (line 9):
import type {
  CloudProvider,
  CostBreakdown,
  DiscordEventReceiver,
  LogChunk,
  RemoteFileStore,
  RunRecordStore,
  SecretsStore,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
} from './cloud.js';

// Replace the CloudProvider describe block:
describe('CloudProvider', () => {
  it('should be implementable with a plain object satisfying all five methods', () => {
    /**
     * Compile-time check: this object must satisfy CloudProvider or tsc/vitest
     * will fail. The runtime assertion just confirms the object is truthy.
     */
    const provider = {
      async startWorkload(_game: string, _opts: StartOpts): Promise<WorkloadHandle> {
        return { workloadId: 'test-id' };
      },
      async stopWorkload(_game: string): Promise<void> {},
      async getWorkloadStatus(_game: string): Promise<WorkloadStatus> {
        return { state: 'stopped' };
      },
      async *streamWorkloadLogs(_game: string, _signal: AbortSignal): AsyncIterable<LogChunk> {},
      async getCostEstimate(): Promise<CostBreakdown> {
        return { total: 0, currency: 'USD', breakdown: {} };
      },
    } satisfies CloudProvider;

    expect(provider).toBeDefined();
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `npm run app:typecheck`
Expected: FAIL — `cloud.ts`'s (current) `CloudProvider` interface still requires `getActualCosts`, so TypeScript reports `Property 'getActualCosts' is missing in type '{ startWorkload...; getCostEstimate...; }' but required in type 'CloudProvider'.` at the `satisfies CloudProvider` assertion in `cloud.test.ts`.
- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/shared/src/cloud.ts
// Replace the CostBreakdown doc comment (was "Shared return type for both
// forward-looking estimates (getCostEstimate) and billed actuals
// (getActualCosts)"):
/**
 * Cloud-agnostic cost snapshot returned by `getCostEstimate` — a
 * forward-looking Fargate cost projection derived from task-definition
 * CPU/memory, not a billed-actuals lookup. The app makes no AWS Cost Explorer
 * API calls; see `openspec/changes/remove-cost-explorer-calls`.
 */
export interface CostBreakdown {
  /** Total cost across all items in the breakdown. */
  total: number;
  currency: string;
  /** Per-game or per-service cost keyed by name. */
  breakdown: Record<string, number>;
}

// Delete the DateRange interface entirely:
// (was: `export interface DateRange { start: Date; end: Date; }` with its
// "Closed date interval used by getActualCosts…" doc comment)

// Replace the CloudProvider interface:
export interface CloudProvider {
  startWorkload(game: string, opts: StartOpts): Promise<WorkloadHandle>;
  stopWorkload(game: string): Promise<void>;
  getWorkloadStatus(game: string): Promise<WorkloadStatus>;
  streamWorkloadLogs(game: string, signal: AbortSignal): AsyncIterable<LogChunk>;
  getCostEstimate(): Promise<CostBreakdown>;
}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `npm run app:typecheck`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add app/packages/shared/src/cloud.ts app/packages/shared/src/cloud.test.ts
git commit -m "refactor(shared): remove CloudProvider.getActualCosts and DateRange"
```

### Task 7: `@hyveon/cloud-aws/src/AwsCloudProvider.ts` — remove `getActualCosts` and the Cost Explorer client

**Files:**
- Modify: `app/packages/cloud-aws/src/AwsCloudProvider.ts` (removes the `CostExplorerClient`/`GetCostAndUsageCommand` import, the `DateRange` import, the `costExplorerClient` field, the `getCostExplorerClient()` method, and the `getActualCosts` method — ~65 lines total)
- Test: `app/packages/cloud-aws/src/AwsCloudProvider.test.ts`

**Interfaces:**
- Consumes: `CloudProvider` from Task 6 (five methods).
- Produces: `AwsCloudProvider` implementing exactly those five methods — no `getActualCosts`.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```ts
// app/packages/cloud-aws/src/AwsCloudProvider.test.ts
// Remove the Cost Explorer imports (lines 13, mockClient setup):
// - delete: import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
// - delete: import type { DateRange } from '@hyveon/shared';
// - delete: const costExplorerMock = mockClient(CostExplorerClient);
// - delete the `costExplorerMock.reset();` line inside `beforeEach`

// Delete the entire `describe('getActualCosts', ...)` block (the whole
// block starting at `describe('getActualCosts', () => {` through its
// closing `});`, including the `range` const and every `it(...)` inside it).

// Add a new test inside `describe('AwsCloudProvider', ...)`, after the
// `describe('getCostEstimate', ...)` block:
  it('should not expose a getActualCosts method', () => {
    const provider = makeProvider();
    expect('getActualCosts' in provider).toBe(false);
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app && npx vitest run packages/cloud-aws/src/AwsCloudProvider.test.ts`
Expected: FAIL — the current `AwsCloudProvider` class still defines `getActualCosts` on its prototype, so `'getActualCosts' in provider` is `true` and the assertion `.toBe(false)` fails.
- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/cloud-aws/src/AwsCloudProvider.ts

// Delete the Cost Explorer SDK import (was line 12):
// import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

// Remove `DateRange,` from the `@hyveon/shared` type-only import block
// (was lines 13-21):
import type {
  CloudProvider,
  CostBreakdown,
  LogChunk,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
} from '@hyveon/shared';

// Delete the `costExplorerClient` field from the class body:
// private costExplorerClient: CostExplorerClient | null = null;

// Delete the `getCostExplorerClient()` private method entirely (its doc
// comment + body, ~11 lines, immediately after `getLogsClient`).

// Update the class-level doc comment's last paragraph — was:
//   "`streamWorkloadLogs` reproduces `LogsService.streamLogs`'s CloudWatch
//   Logs polling behaviour (see the method for details). `getCostEstimate`
//   and `getActualCosts` reproduce the previous `CostService`'s
//   Fargate-pricing estimate and Cost Explorer billed-actuals lookup
//   respectively."
// becomes:
  /**
   * ... (all preceding paragraphs unchanged) ...
   *
   * `streamWorkloadLogs` reproduces `LogsService.streamLogs`'s CloudWatch
   * Logs polling behaviour (see the method for details). `getCostEstimate`
   * reproduces the previous `CostService`'s Fargate-pricing estimate. The
   * app makes no AWS Cost Explorer API calls, ever — see
   * `openspec/changes/remove-cost-explorer-calls`.
   */

// Delete the `getActualCosts` method entirely (its doc comment + body, ~48
// lines, the last method in the class before the closing `}`).
```
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app && npx vitest run packages/cloud-aws/src/AwsCloudProvider.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add app/packages/cloud-aws/src/AwsCloudProvider.ts app/packages/cloud-aws/src/AwsCloudProvider.test.ts
git commit -m "refactor(cloud-aws): remove AwsCloudProvider.getActualCosts and the Cost Explorer client"
```

### Task 8: `@hyveon/cloud-aws` — drop the `@aws-sdk/client-cost-explorer` dependency and update the barrel smoke test

**Files:**
- Modify: `app/packages/cloud-aws/package.json:16-17`
- Modify: `app/packages/cloud-aws/src/index.test.ts:18-24` (doc-comment only — no behavior change, since `getActualCosts` was never exercised by this file's assertions)

**Interfaces:**
- Consumes: Task 7's `AwsCloudProvider` (no `getActualCosts`).

No runtime behavior changes here (the barrel test's assertions were never about `getActualCosts` — only its doc comment mentioned the method, to explain why it was absent from this smoke test's coverage). This is a dependency-manifest edit plus a stale-comment fix, so there's no meaningful "fails then passes" cycle; the check is that the package still installs and typechecks clean with the dependency gone.

- [ ] **Step 1: Confirm no other file imports `@aws-sdk/client-cost-explorer`**
Run: `grep -rn "client-cost-explorer" app/packages`
Expected: zero matches (Task 7 already removed the only import; `package.json` still lists the dependency until this task's Step 3).
- [ ] **Step 2: Run the pre-edit gate to establish a baseline**
Run: `npm run app:typecheck`
Expected: PASS (this task doesn't change any type surface — it only removes an unused dependency and a doc comment — so there is no "fails against old code" state to reproduce; recorded here per the plan's TDD-deletion convention as "nothing to break," not skipped).
- [ ] **Step 3: Write minimal implementation**
```json
// app/packages/cloud-aws/package.json — remove the client-cost-explorer line
// from "dependencies" (was between client-cloudwatch-logs and client-dynamodb):
  "dependencies": {
    "@aws-sdk/client-cloudwatch-logs": "^3.1095.0",
    "@aws-sdk/client-dynamodb": "^3.1095.0",
    "@aws-sdk/client-ec2": "^3.1095.0",
    "@aws-sdk/client-ecs": "^3.1095.0",
    "@aws-sdk/client-s3": "^3.1095.0",
    "@aws-sdk/client-secrets-manager": "^3.1095.0",
    "@aws-sdk/lib-dynamodb": "^3.1095.0",
    "@aws-sdk/s3-request-presigner": "^3.1095.0",
    "@hyveon/shared": "*"
  }
```
```ts
// app/packages/cloud-aws/src/index.test.ts — update the module doc comment's
// third paragraph, was:
//   "`AwsCloudProvider`'s workload and cost-estimate methods
//   (`startWorkload`/`stopWorkload`/`getWorkloadStatus`/
//   `streamWorkloadLogs`/`getCostEstimate`) are real `async`/async-generator
//   implementations, so their "no config supplied" branch is asserted via
//   `.rejects`/`.resolves` instead. `getActualCosts` performs a real Cost
//   Explorer call with no config-driven guard, so it isn't exercised by this
//   barrel-export smoke test — see `AwsCloudProvider.test.ts` for its
//   coverage."
// becomes:
 * Most stub methods are declared with `Promise<...>` / `AsyncIterable<...>`
 * return types, but throw synchronously (they aren't `async` functions), so
 * those assertions use `expect(() => ...).toThrow(...)` rather than
 * `.rejects.toThrow(...)`. `AwsCloudProvider`'s workload and cost-estimate
 * methods (`startWorkload`/`stopWorkload`/`getWorkloadStatus`/
 * `streamWorkloadLogs`/`getCostEstimate`) are real `async`/async-generator
 * implementations, so their "no config supplied" branch is asserted via
 * `.rejects`/`.resolves` instead.
```
- [ ] **Step 4: Reinstall and run the gate**
Run: `npm install && npm run app:typecheck && (cd app && npx vitest run packages/cloud-aws)`
Expected: PASS — `package-lock.json` updates to drop the now-unused dependency's resolved entries; typecheck and tests stay clean.
- [ ] **Step 5: Commit**
```bash
git add app/packages/cloud-aws/package.json package-lock.json app/packages/cloud-aws/src/index.test.ts
git commit -m "chore(cloud-aws): drop unused @aws-sdk/client-cost-explorer dependency"
```

### Task 9: `desktop-main/src/services/CostService.ts` — remove `getActualCosts`, the `ActualCosts` type, and the now-dead `CLOUD_PROVIDER` injection

**Files:**
- Modify: `app/packages/desktop-main/src/services/CostService.ts:1-83` (full rewrite)
- Test: `app/packages/desktop-main/src/services/CostService.test.ts` (full rewrite)

**Interfaces:**
- Produces: `CostService` with a single public method, `estimateForSpec(cpuUnits: number, memoryMib: number): GameEstimate`, constructed with no arguments (`new CostService()`) — no `CloudProvider` dependency at all.
- Consumes: nothing new. `GameEstimate`/`CostEstimates` (defined in this file) are unchanged and still consumed by `costs.controller.ts` (Task 10).

`getActualCosts` was the only place this service used its injected `CLOUD_PROVIDER`/`CloudProvider` and its `logger` import — removing it makes both entirely dead, so this task removes the constructor injection too, not just the method.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```ts
// app/packages/desktop-main/src/services/CostService.test.ts (full file)
import { describe, it, expect, beforeEach } from 'vitest';
import { CostService } from './CostService.js';

describe('CostService', () => {
  let service: CostService;

  beforeEach(() => {
    service = new CostService();
  });

  describe('estimateForSpec', () => {
    it('should compute Fargate hourly, daily, and monthly costs for 1 vCPU + 2 GiB', () => {
      const est = service.estimateForSpec(1024, 2048);
      expect(est.vcpu).toBe(1);
      expect(est.memoryGb).toBe(2);
      // 1 * 0.04048 + 2 * 0.004445 = 0.04937
      expect(est.costPerHour).toBeCloseTo(0.0494, 4);
      // 0.04937 * 24 = 1.18488 -> 1.18
      expect(est.costPerDay24h).toBeCloseTo(1.18, 2);
      // 0.04937 * 4 * 30 = 5.9244 -> 5.92
      expect(est.costPerMonth4hpd).toBeCloseTo(5.92, 2);
    });

    it('should scale cost linearly with CPU and memory', () => {
      const half = service.estimateForSpec(512, 1024);
      const full = service.estimateForSpec(1024, 2048);
      expect(half.costPerHour).toBeCloseTo(full.costPerHour / 2, 6);
    });

    it('should round hourly cost to at most 4 decimals', () => {
      const est = service.estimateForSpec(256, 512);
      expect(Number.isFinite(est.costPerHour)).toBe(true);
      const decimals = est.costPerHour.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(4);
    });
  });

  it('should not expose a getActualCosts method', () => {
    expect('getActualCosts' in service).toBe(false);
  });
});
```
This removes `getActualCostsMock`, `makeCloudProvider()`, the `vi.mock('../logger.js', ...)` block, the `CloudProvider`/`CostBreakdown`/`DateRange` imports, and the entire `describe('getActualCosts', ...)` block; `new CostService(makeCloudProvider())` becomes `new CostService()`.
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app && npx vitest run packages/desktop-main/src/services/CostService.test.ts`
Expected: FAIL — the current `CostService` class still defines `getActualCosts` on its prototype (constructing it with no arguments still succeeds at runtime, since Nest's `@Inject` decorator doesn't enforce anything outside the DI container — `this.provider` is simply `undefined`), so `'getActualCosts' in service` is `true` and `.toBe(false)` fails.
- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/desktop-main/src/services/CostService.ts (full file)
import { Injectable } from '@nestjs/common';
import { FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR } from '@hyveon/cloud-aws';

/** Per-game Fargate cost projection derived from its CPU/memory spec. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate of per-game estimates plus the cost if every game were running simultaneously. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/**
 * Produces the numbers that back the Costs page: static Fargate estimates
 * derived from each game's task-definition CPU/memory. The app makes no AWS
 * Cost Explorer API calls — see `openspec/changes/remove-cost-explorer-calls`.
 */
@Injectable()
export class CostService {
  /**
   * Translate a Fargate task's raw `cpu` (1024 = 1 vCPU) and `memory` (MiB)
   * into projected dollar costs. Pure arithmetic — no AWS calls — so it's
   * safe to run in a tight loop over every game.
   */
  estimateForSpec(cpuUnits: number, memoryMib: number): GameEstimate {
    const vcpu = cpuUnits / 1024;
    const memGb = memoryMib / 1024;
    const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memGb * FARGATE_GB_PER_HOUR;
    return {
      vcpu,
      memoryGb: memGb,
      costPerHour: Math.round(hourly * 10000) / 10000,
      costPerDay24h: Math.round(hourly * 24 * 100) / 100,
      costPerMonth4hpd: Math.round(hourly * 4 * 30 * 100) / 100,
    };
  }
}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app && npx vitest run packages/desktop-main/src/services/CostService.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-main/src/services/CostService.ts app/packages/desktop-main/src/services/CostService.test.ts
git commit -m "refactor(desktop-main): remove CostService.getActualCosts and its CloudProvider dependency"
```

### Task 10: `desktop-main/src/controllers/costs.controller.ts` — remove the `costs.actual` handler

**Files:**
- Modify: `app/packages/desktop-main/src/controllers/costs.controller.ts:1-69`
- Test: `app/packages/desktop-main/src/controllers/costs.controller.test.ts`

**Interfaces:**
- Consumes: `CostService` from Task 9 (only `estimateForSpec`).
- Produces: `CostsController` with a single `@MessagePattern('costs.estimate')` handler — no `actual` method, no `costs.actual` channel.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```ts
// app/packages/desktop-main/src/controllers/costs.controller.test.ts
// Update the makeCosts() stub — drop getActualCosts, and use a single `as
// CostService` cast (not `as unknown as`) now that CostService has no other
// instance members to conflict with:
function makeCosts(): CostService {
  return {
    estimateForSpec: vi.fn().mockReturnValue(MOCK_ESTIMATE),
  } as CostService;
}

// Delete the `it('should register actual on the "costs.actual" IPC
// channel', ...)` test from the `describe('@MessagePattern channel names',
// ...)` block, and delete the entire `describe('actual', ...)` block (four
// tests) at the end of the file.

// Add a new test inside `describe('@MessagePattern channel names', ...)`:
    it('should not register an actual handler', () => {
      const controller = new CostsController(makeConfig(), makeCosts(), makeEcs());
      expect('actual' in controller).toBe(false);
    });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app && npx vitest run packages/desktop-main/src/controllers/costs.controller.test.ts`
Expected: FAIL — the current `CostsController` still defines `actual`, so `'actual' in controller` is `true` and `.toBe(false)` fails. (`makeCosts()`'s stub also drops `getActualCosts`, which the current controller doesn't call from `estimate()`, so that part alone wouldn't fail — the new assertion is what drives the failure.)
- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/desktop-main/src/controllers/costs.controller.ts (full file)
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { CostService } from '../services/CostService.js';
import { EcsService } from '../services/EcsService.js';

/**
 * Cost endpoints for the Electron main-process host. Every handler is bound to
 * an IPC channel via `@MessagePattern` — no HTTP routes are registered here.
 * It delegates to the {@link ConfigService}, {@link CostService}, and
 * {@link EcsService} providers. The app makes no AWS Cost Explorer API
 * calls — see `openspec/changes/remove-cost-explorer-calls`.
 */
@Controller()
export class CostsController {
  constructor(
    private readonly config: ConfigService,
    private readonly costs: CostService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Estimates the hourly Fargate cost of each game from its task definition's
   * CPU/memory, plus the sum-if-everything-were-running. Reads the game list
   * from tfstate; falls back to `2048 cpu / 8192 MiB` if the task definition
   * can't be resolved. Returns zeros when tfstate is missing.
   */
  @MessagePattern('costs.estimate')
  async estimate() {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) {
      return { games: {}, totalPerHourIfAllOn: 0 };
    }

    const estimates: Record<string, ReturnType<CostService['estimateForSpec']>> = {};
    for (const game of outputs.gameNames) {
      const td = await this.ecs.getTaskDefinition(game);
      estimates[game] = this.costs.estimateForSpec(td?.cpu ?? 2048, td?.memory ?? 8192);
    }

    const totalPerHourIfAllOn = Object.values(estimates).reduce((sum, e) => sum + e.costPerHour, 0);

    return {
      games: estimates,
      totalPerHourIfAllOn: Math.round(totalPerHourIfAllOn * 10000) / 10000,
    };
  }
}
```
(`Payload` is dropped from the `@nestjs/microservices` import — it was only used by the deleted `actual` handler's `@Payload() daysRaw` parameter.)
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app && npx vitest run packages/desktop-main/src/controllers/costs.controller.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-main/src/controllers/costs.controller.ts app/packages/desktop-main/src/controllers/costs.controller.test.ts
git commit -m "refactor(desktop-main): remove the costs.actual IPC handler"
```

### Task 11: `desktop-main/src/modules/cloud-provider.module.test.ts` — drop `getActualCosts` from the hand-rolled fake

**Files:**
- Modify: `app/packages/desktop-main/src/modules/cloud-provider.module.test.ts:66-85`

**Interfaces:**
- Consumes: `CloudProvider` from Task 6 (five methods) — `FakeCloudProvider` must keep implementing exactly that interface, no more, no less.

`FakeCloudProvider implements CloudProvider` is a hand-rolled class proving `resolveCloudBindings` routes to whatever's registered, independent of `@hyveon/cloud-aws`. Once `CloudProvider` no longer declares `getActualCosts` (Task 6), this class carrying an extra method it no longer implements-per-interface is stale, not merely superfluous — it's the last place in the repo still shaped like the old five-plus-one-method contract.

- [ ] **Step 1: Update the existing test to assert the new shape first**
```ts
// app/packages/desktop-main/src/modules/cloud-provider.module.test.ts
// Remove `DateRange,` from the @hyveon/shared type-only import (CostBreakdown
// stays — still needed by getCostEstimate below):
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  RunRecordStore,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
  LogChunk,
  CostBreakdown,
  AuditEntry,
  AuditPageResult,
  RunRecord,
} from '@hyveon/shared';

// Update FakeCloudProvider — remove the getActualCosts method:
class FakeCloudProvider implements CloudProvider {
  startWorkload(_game: string, _opts: StartOpts): Promise<WorkloadHandle> {
    throw new Error('not implemented in fake');
  }
  stopWorkload(_game: string): Promise<void> {
    throw new Error('not implemented in fake');
  }
  getWorkloadStatus(_game: string): Promise<WorkloadStatus> {
    throw new Error('not implemented in fake');
  }
  streamWorkloadLogs(_game: string, _signal: AbortSignal): AsyncIterable<LogChunk> {
    throw new Error('not implemented in fake');
  }
  getCostEstimate(): Promise<CostBreakdown> {
    throw new Error('not implemented in fake');
  }
}
```
- [ ] **Step 2: Run test to verify it fails**
Run: `npm run app:typecheck`
Expected: FAIL — with `DateRange` removed from `@hyveon/shared`'s exports (Task 6) but `cloud-provider.module.test.ts` still importing it (before this step's edit lands), TypeScript reports `Module '"@hyveon/shared"' has no exported member 'DateRange'.` — confirming the file is still coupled to the removed type until this task's edit is applied. (Reached via the sequencing of this plan: Task 6 already removed `DateRange` from `@hyveon/shared`, so this file has been failing typecheck since that commit landed within this same PR; this step's edit is what fixes it.)
- [ ] **Step 3: Confirm the edit above is applied**
(Step 1's code block *is* the implementation — this file has no separate "test vs implementation" split since it's a single hand-rolled fake used directly by the test assertions in the same file.)
- [ ] **Step 4: Run test to verify it passes**
Run: `npm run app:typecheck && (cd app && npx vitest run packages/desktop-main/src/modules/cloud-provider.module.test.ts)`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-main/src/modules/cloud-provider.module.test.ts
git commit -m "refactor(desktop-main): drop getActualCosts from the cloud-provider-module test fake"
```

### Task 12: preload bridge — remove `costs.actual` from `hyveon-api.ts` and `preload.ts`

**Files:**
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts` (removes the `ActualCosts`/`DailyCost` interfaces and `HyveonCostsApi.actual`)
- Modify: `app/packages/desktop-preload/src/preload.ts:681-684` (removes the `actual` bridge method)

**Interfaces:**
- Produces: `HyveonCostsApi` with a single method, `estimate: () => Promise<CostEstimates>`.
- Consumes: nothing new. `HyveonTestApi`'s mapped-type mock surface (`[K in Exclude<keyof HyveonApi, '__test'>]?: Partial<HyveonApi[K]>`) automatically drops `costs.actual` from its shape once `HyveonCostsApi` no longer declares it — no separate edit needed there.

Pure type/plumbing removal — verified via `npm run app:typecheck`.

- [ ] **Step 1: Run the pre-edit gate to establish the baseline**
Run: `npm run app:typecheck`
Expected: PASS (nothing has changed yet in this task).
- [ ] **Step 2: Write minimal implementation**
```ts
// app/packages/desktop-preload/src/hyveon-api.ts
// Delete the DailyCost interface entirely (was: "Historical daily cost entry
// from Cost Explorer." / `export interface DailyCost { date: string; cost:
// number; }`).

// Delete the ActualCosts interface entirely (was: "Actual billed costs pulled
// from AWS Cost Explorer." / `export interface ActualCosts { daily:
// DailyCost[]; total: number; currency: string; days: number; error?:
// string; }`).

// Update HyveonCostsApi:
/** Cost endpoints: forward-looking Fargate estimates. The app makes no AWS Cost Explorer API calls — see `openspec/changes/remove-cost-explorer-calls`. */
export interface HyveonCostsApi {
  /** Estimates per-game and total hourly Fargate cost. */
  estimate: () => Promise<CostEstimates>;
}
```
```ts
// app/packages/desktop-preload/src/preload.ts
// Replace the `costs` block in the `api` object:
  costs: {
    estimate: () => invoke('costs.estimate'),
  },
```
- [ ] **Step 3: Run test to verify it passes**
Run: `npm run app:typecheck && (cd app && npx vitest run packages/desktop-preload)`
Expected: PASS. (`preload.test.ts`'s `expect(bridge['costs']).toBeDefined()` assertions — lines 363/371 — still pass unchanged, since `costs` namespace still exists with `estimate`; no edit needed there.)
- [ ] **Step 4: Confirm no other file still imports the removed types**
Run: `grep -rn "ActualCosts\|DailyCost" app/packages/desktop-preload`
Expected: zero matches.
- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-preload/src/hyveon-api.ts app/packages/desktop-preload/src/preload.ts
git commit -m "refactor(desktop-preload): remove the costs.actual bridge method"
```

### Task 13: `web/src/api.service.ts` — remove `ActualCosts` and `costsActual()`

**Files:**
- Modify: `app/packages/web/src/api.service.ts:38-45,452-453`
- Test: `app/packages/web/src/api.service.test.ts`

**Interfaces:**
- Produces: `api.costsEstimate(): Promise<CostEstimates>` only — no `costsActual`, no exported `ActualCosts` type.
- Consumes: `hyveon().costs.estimate()` from Task 12's preload bridge.

- [ ] **Step 1: Update the existing test to assert the new behavior first**
```ts
// app/packages/web/src/api.service.test.ts
// In makeHyveonMock()'s `costs` namespace, drop the `actual` stub:
    costs: {
      estimate: vi.fn().mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 }),
    },

// Delete these two tests from the 'IPC bridge delegation' describe block:
//   it('should delegate api.costsActual() to window.hyveon.costs.actual() with the days window', ...)
//   it('should default api.costsActual() to a 7-day window', ...)

// Add a new test in their place:
  it('should not expose a costsActual method on the api object', () => {
    expect('costsActual' in api).toBe(false);
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `cd app && npx vitest run packages/web/src/api.service.test.ts`
Expected: FAIL — the current `api` object still has a `costsActual` method, so `'costsActual' in api` is `true` and `.toBe(false)` fails.
- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/web/src/api.service.ts

// Delete the ActualCosts interface entirely (was: "Actual daily AWS Cost
// Explorer spend returned by `GET /api/costs/actual`." / `export interface
// ActualCosts { daily: { date: string; cost: number }[]; total: number;
// currency: string; days: number; error?: string; }`).

// Remove the costsActual line from the `api` object (was directly after
// `costsEstimate`):
  costsEstimate: async (): Promise<CostEstimates> => hyveon().costs.estimate(),
  filesMgrStatus: async (game: string): Promise<FileMgrStatus> => hyveon().files.list(game),
  // (costsActual line deleted — nothing between costsEstimate and filesMgrStatus)
```
- [ ] **Step 4: Run test to verify it passes**
Run: `cd app && npx vitest run packages/web/src/api.service.test.ts`
Expected: PASS
- [ ] **Step 5: Confirm no remaining importers of the removed type**
Run: `grep -rln "ActualCosts" app/packages/web/src`
Expected: zero matches (Tasks 1-4 already removed every UI-layer usage in PR 1).
- [ ] **Step 6: Commit**
```bash
git add app/packages/web/src/api.service.ts app/packages/web/src/api.service.test.ts
git commit -m "refactor(web): remove api.service.ts's costsActual() and ActualCosts type"
```

### Task 14: PR 2 gate and open

- [ ] **Step 1: Run the full backend gate**
Run, from repo root:
```bash
npm run app:lint
npm run app:typecheck
npm run app:test
npm run app:test:integration
```
Expected: all four clean/green. (`app:test:integration` is required — the controller/IPC surface changed. `app:test:e2e` is NOT re-required here per `CLAUDE.md`'s trigger rule since the renderer/preload *contract* the web layer depends on is unchanged from PR 1's perspective — `costs.estimate` still resolves the same shape; but PR 3 still must fix the e2e specs that reference the now-deleted `costs.actual` channel, tracked there.)
- [ ] **Step 2: Open the PR**
```bash
git push -u origin costexplorer-2-backend
gh pr create --title "refactor(shared,cloud-aws,desktop-main,desktop-preload,web): delete the Cost Explorer call chain" --base costexplorer-1-frontend --body "$(cat <<'EOF'
## Summary
- Remove `CloudProvider.getActualCosts` + `DateRange` (`@hyveon/shared`) — `CostBreakdown` is retained, still used by `getCostEstimate`.
- Remove `AwsCloudProvider.getActualCosts` + the `CostExplorerClient` and drop the `@aws-sdk/client-cost-explorer` dependency (`@hyveon/cloud-aws`).
- Remove `CostService.getActualCosts` and its now-dead `CLOUD_PROVIDER` injection (`@hyveon/desktop-main`).
- Remove the `costs.actual` `@MessagePattern` IPC handler and preload bridge method.
- Remove `api.service.ts`'s `costsActual()` and the (desktop-main/preload/web-layer) `ActualCosts` type.

The app now makes zero AWS Cost Explorer API calls from any code path. Part of the `remove-cost-explorer-calls` PR stack (2/4), based on PR 1's UI swap.

## Test plan
- [x] `npm run app:lint`
- [x] `npm run app:typecheck`
- [x] `npm run app:test`
- [x] `npm run app:test:integration`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened against `costexplorer-1-frontend`, titled per Conventional Commits.

---

## PR 3: costexplorer-3-e2e (base: costexplorer-2-backend)

By this point in the stack, the app itself (frontend + backend, PRs 1-2) is already fully migrated — there is no `costs.actual` IPC channel and no actuals UI left anywhere. This PR only touches test-support files (fixtures, page objects, specs). Because the app code doesn't change here, the natural "confirm it fails" step for each spec-file task is: run the **existing, not-yet-updated** spec against this branch's (already-migrated) app and watch it fail, since the old spec still targets removed UI/channels — then rewrite the spec.

Two additional touchpoints were found by grepping beyond the six files `tasks.md`/`brainstorm.md` name (`electron-launch.ts`, `game-data.ts`, `index.ts`, `costs.spec.ts`, `discord.spec.ts`, `demo-data.ts`): `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (the chromium-tier IPC-to-HTTP shim hardcodes a `costs.actual` → `/api/costs/actual` mapping) and `app/packages/web/e2e/specs/dashboard.spec.ts` (asserts the literal `'Spend today'`/`'Forecast MTD'` KPI tile labels PR 1 already renamed).

### Task 15: `fixtures/game-data.ts` — remove the `ActualCosts` fixtures

**Files:**
- Modify: `app/packages/web/e2e/fixtures/game-data.ts:1-7,87-117`

**Interfaces:**
- Consumes: nothing new.
- Produces: no `ACTUAL_COSTS` const, no `makeActualCosts()` function, no `ActualCosts` import.

Support-code-only edit — no independent runtime assertion exists for a fixture file in isolation, so this task is gated on `npm run app:typecheck` (confirms nothing still imports the removed symbols) rather than a fail/pass test cycle.

- [ ] **Step 1: Confirm nothing outside this file references what's about to be removed yet**
Run: `grep -rln "ACTUAL_COSTS\|makeActualCosts" app/packages/web/e2e --include="*.ts" | grep -v game-data.ts`
Expected: matches in `fixtures/index.ts`, `fixtures/electron-launch.ts`, `specs/costs.spec.ts` — all fixed in Tasks 16-17 and 19 of this PR; noted here so this task's edit doesn't need to wait for them (TypeScript will report the breakage until they land, same multi-commit-transient-breakage pattern used across this plan).
- [ ] **Step 2: Write minimal implementation**
```ts
// app/packages/web/e2e/fixtures/game-data.ts
// Remove `ActualCosts,` from the type-only import (line 5):
import type {
  GameStatus,
  CostEstimates,
  EnvInfo,
  DiscordConfigRedacted,
} from '@/api.service.js';

// Delete the ACTUAL_COSTS const and its doc comment (was: "Stub response for
// `GET /api/costs/actual` — 7 days of synthetic spend used by the KPI
// sparklines." / `export const ACTUAL_COSTS: ActualCosts = { ... };`).

// Delete the makeActualCosts() function and its doc comment (was: "Build a
// deterministic `ActualCosts` payload with `days` daily entries. ..." /
// `export function makeActualCosts(days: number): ActualCosts { ... }`).
```
- [ ] **Step 3: Commit is deferred**
This file's removal is only safe to commit together with (or after) Tasks 16-17 and 19, which stop importing `ACTUAL_COSTS`/`makeActualCosts`. Proceed directly to Task 16 before running the gate or committing — see Task 19's Step 2 for the combined verification.

### Task 16: `fixtures/index.ts` and `fixtures/hyveon-http-bridge.ts` — drop the `actualCosts` stub option, route, and HTTP-bridge mapping

**Files:**
- Modify: `app/packages/web/e2e/fixtures/index.ts:1-118,182-186`
- Modify: `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts:51-54`

**Interfaces:**
- Consumes: Task 15's `game-data.ts` (no longer exports `ACTUAL_COSTS`/`makeActualCosts`).
- Produces: `StubOptions` without `actualCosts`; `stubApis()` registers no `**/api/costs/actual*` route; `installHyveonHttpBridge()`'s `costs` namespace has only `estimate`.

- [ ] **Step 1: Write minimal implementation**
```ts
// app/packages/web/e2e/fixtures/index.ts
// Remove `ActualCosts,` from the @/api.service.js type-only import (line 7)
// and from the `export type { ... };` re-export block (line 28).
// Remove `makeActualCosts,` from the game-data.js import (line 18) and from
// the `export { ... } from './game-data.js';` re-export block (line 43).

// Remove the `actualCosts` field (and its doc comment) from StubOptions
// entirely (was directly after `costs?: CostEstimates;`):
export interface StubOptions {
  statuses?: GameStatus[];
  costs?: CostEstimates;
  env?: EnvInfo;
  startResult?: ActionResult;
  discord?: DiscordConfigRedacted;
  games?: (string | GameListEntry)[];
  drift?: DriftReport;
  logLines?: Record<string, string[]>;
  audit?: AuditPageResult | ((opts: { limit?: number; before?: string }) => AuditPageResult);
}

// In stubApis(), remove the `actualCostsFn` computed variable entirely, and
// remove the `**/api/costs/actual*` route registration entirely (was
// directly after the `**/api/costs/estimate` route):
  await page.route('**/api/costs/estimate', (route) => route.fulfill({ json: costs }));

  await page.route('**/api/drift', (route) => route.fulfill({ json: drift }));
```
```ts
// app/packages/web/e2e/fixtures/hyveon-http-bridge.ts
// Replace the `costs` block:
    costs: {
      estimate: () => call('/api/costs/estimate'),
    },
```
- [ ] **Step 2: Confirm nothing outside these two files still expects the removed pieces**
Run: `grep -rn "actualCosts\b" app/packages/web/e2e/fixtures/electron-launch.ts app/packages/web/e2e/specs/costs.spec.ts app/packages/web/e2e/screenshots/demo-data.ts`
Expected: still matches (fixed in Tasks 17 and 19-20); confirms this task alone is insufficient and the combined verification happens once Tasks 15-20 all land — see Task 20's Step 4.

### Task 17: `fixtures/electron-launch.ts` — drop the `costs.actual` mock

**Files:**
- Modify: `app/packages/web/e2e/fixtures/electron-launch.ts` (removes the `makeActualCosts` import, the `ActualCosts` type import, the `actualCostsFn` computed value, the `costs.actual` mock registration, and the `actualCostsMap` argument)

**Interfaces:**
- Consumes: Task 16's `StubOptions` (no `actualCosts` field).
- Produces: `applyHyveonMocks(win, opts)` mocking `env.get`, `games.status`, `games.list`, `costs.estimate`, `games.start`, `games.stop`, `discord.getConfig` — no `costs.actual`.

- [ ] **Step 1: Write minimal implementation**
```ts
// app/packages/web/e2e/fixtures/electron-launch.ts (full file)
/**
 * Reusable helpers for the Playwright `electron` project.
 *
 * Provides two exports:
 *
 * - `launchElectron()` — launches the packaged Electron app via
 *   `_electron.launch()` using the `electronMain` / `electronEnv` values
 *   from the playwright config, and returns `{ app, win }` where `win` is the
 *   first-opened `Page`.
 *
 * - `applyHyveonMocks(win, opts)` — seeds `window.hyveon.__test.mock()` for every
 *   IPC channel the dashboard and its shared provider stack consume, using the
 *   same `StubOptions` shape and `game-data` fixture constants that the
 *   Chromium tier uses for `page.route()` stubs. Designed to be called inside
 *   a `beforeEach` or at the top of a test body, before navigating to a page.
 */

import type { Page } from '@playwright/test';
import { _electron } from '@playwright/test';
import { electronMain, electronEnv } from '../../playwright.config.js';
import type { StubOptions } from './index.js';
import {
  ENV_DATA,
  STOPPED_GAME,
  COST_DATA,
  CONFIGURED_DISCORD_CONFIG,
} from './game-data.js';
import type {
  GameStatus,
  ActionResult,
  CostEstimates,
  EnvInfo,
  DiscordConfigRedacted,
} from './index.js';
import type { ElectronApplication } from 'playwright-core';

// ---------------------------------------------------------------------------
// launchElectron
// ---------------------------------------------------------------------------

/** Return value of {@link launchElectron}. */
export interface ElectronHandle {
  /** The `ElectronApplication` instance — close it in the test's `finally` block. */
  app: ElectronApplication;
  /** The first opened `Page` (the renderer window). */
  win: Page;
}

/**
 * Launches the packaged Electron app and waits for the first `BrowserWindow`.
 *
 * Uses the `electronMain` entry-point and `electronEnv` (which includes
 * `HYVEON_TEST_MODE=1`) exported from the playwright config, so all Electron
 * e2e specs go through the same launch configuration without duplicating it.
 */
export async function launchElectron(): Promise<ElectronHandle> {
  const app = await _electron.launch({ args: [electronMain], env: electronEnv });
  const win = await app.firstWindow();
  return { app, win };
}

// ---------------------------------------------------------------------------
// applyHyveonMocks
// ---------------------------------------------------------------------------

/**
 * Seeds `window.hyveon.__test.mock()` for every IPC channel the dashboard and
 * its shared provider stack call at startup.
 *
 * Mirrors the defaults and per-spec overrides of `stubApis` so the same
 * `StubOptions` vocabulary works for both the Chromium and Electron tiers.
 * Must be called **before** the renderer navigates to the page under test
 * (i.e. before `win.goto()`), because the preload consults the mock registry
 * on each `invoke()` call.
 *
 * The following channels are mocked:
 * - `env.get`         → `EnvInfo`
 * - `games.status`    → `GameStatus[]`
 * - `games.list`      → `{ games: string[] }`
 * - `costs.estimate`  → `CostEstimates`
 * - `games.start`     → `ActionResult`
 * - `games.stop`      → `ActionResult`
 * - `discord.getConfig` → `DiscordConfigRedacted`
 *
 * @param win  - The Playwright `Page` for the Electron renderer window.
 * @param opts - Per-spec overrides; uses the same defaults as `stubApis`.
 */
export async function applyHyveonMocks(win: Page, opts: StubOptions = {}): Promise<void> {
  const statuses: GameStatus[] = opts.statuses ?? [STOPPED_GAME];
  const costs: CostEstimates = opts.costs ?? COST_DATA;
  const env: EnvInfo = opts.env ?? ENV_DATA;
  const startResult: ActionResult = opts.startResult ?? { success: true, message: 'Started' };
  const discord: DiscordConfigRedacted = opts.discord ?? CONFIGURED_DISCORD_CONFIG;
  const games: string[] = (opts.games ?? statuses.map((s) => s.game)).map((g) =>
    typeof g === 'string' ? g : g.name,
  );

  await win.evaluate(
    ({
      envData,
      statusList,
      gameList,
      costEstimates,
      startRes,
      discordConfig,
    }: {
      envData: EnvInfo;
      statusList: GameStatus[];
      gameList: string[];
      costEstimates: CostEstimates;
      startRes: ActionResult;
      discordConfig: DiscordConfigRedacted;
    }) => {
      const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      hyveon.__test.mock('env.get', () => Promise.resolve(envData));
      hyveon.__test.mock('games.status', () => Promise.resolve(statusList));
      hyveon.__test.mock('games.list', () => Promise.resolve({ games: gameList }));
      hyveon.__test.mock('costs.estimate', () => Promise.resolve(costEstimates));
      hyveon.__test.mock('games.start', () => Promise.resolve(startRes));
      hyveon.__test.mock('games.stop', () => Promise.resolve({ success: true, message: 'Stopped' }));
      hyveon.__test.mock('discord.getConfig', () => Promise.resolve(discordConfig));
    },
    {
      envData: env,
      statusList: statuses,
      gameList: games,
      costEstimates: costs,
      startRes: startResult,
      discordConfig: discord,
    },
  );
}
```
- [ ] **Step 2: Run the typecheck gate across Tasks 15-17**
Run: `npm run app:typecheck`
Expected: PASS — Tasks 15-17 together remove every remaining import of `ACTUAL_COSTS`/`makeActualCosts`/`ActualCosts` from `game-data.ts`'s consumers except `costs.spec.ts` and `demo-data.ts` (fixed in Tasks 19-20). If `npm run app:typecheck` still fails here, it fails specifically pointing at `costs.spec.ts`/`demo-data.ts` — that's expected at this point in the task sequence and resolved by Task 19-20's edits; if it fails pointing anywhere else, stop and investigate before proceeding.
- [ ] **Step 3: Commit Tasks 15-17 together**
```bash
git add app/packages/web/e2e/fixtures/game-data.ts app/packages/web/e2e/fixtures/index.ts app/packages/web/e2e/fixtures/hyveon-http-bridge.ts app/packages/web/e2e/fixtures/electron-launch.ts
git commit -m "test(web): remove actual-cost mock plumbing from e2e fixtures"
```

### Task 18: `pages/CostsPage.ts` — drop range/chart/delta-pill locators, add the Cost Explorer link locator

**Files:**
- Modify: `app/packages/web/e2e/pages/CostsPage.ts` (full rewrite)
- Modify: `app/packages/web/e2e/pages/index.ts:3` (drops the `CostsRangeLabel` re-export)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CostsPage` page object with `goto`, `gotoElectron`, `heading`, `costExplorerLink`, `tableRows`, `tableCell`, `sortHeader`, `clickSort`, `filterInput`, `filter` — no `rangeButton`/`selectRange`/`totalLabel`/`deltaPill`/`chartTitle`/`chartSegment`, no `CostsRangeLabel` export.

- [ ] **Step 1: Write minimal implementation**
```ts
// app/packages/web/e2e/pages/CostsPage.ts (full file)
import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the `/costs` route. Wraps the per-game estimates table and
 * the AWS Cost Explorer link-out callout so spec files read as test logic
 * rather than locator soup.
 */
export class CostsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/costs` directly (the route isn't yet linked from the sidebar). */
  async goto(): Promise<void> {
    await this.page.goto('/costs');
  }

  /**
   * Navigate to `/costs` inside the Electron shell where `page.goto()` cannot
   * change the React Router route. Pushes the path via `history.pushState` and
   * dispatches a synthetic `popstate` event so React Router picks up the change.
   *
   * TODO(#190): replace with a sidebar navigation click once the Costs link is
   * wired into the sidebar in the Electron project.
   */
  async gotoElectron(): Promise<void> {
    await this.page.evaluate(() => {
      window.history.pushState({}, '', '/costs');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await this.heading().waitFor();
  }

  // ── Headline ─────────────────────────────────────────────────────────

  /** "Cost Analysis" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Cost Analysis' });
  }

  /** "Open AWS Cost Explorer" link-out to the real AWS console. */
  costExplorerLink(): Locator {
    return this.page.getByRole('link', { name: /Open AWS Cost Explorer/i });
  }

  // ── Estimates table ──────────────────────────────────────────────────

  /** All `<tr>` rows including the header — index 0 is the header, 1.. are games. */
  tableRows(): Locator {
    return this.page.getByRole('row');
  }

  /**
   * A `<td>` or `<th>` cell whose accessible name matches `name` (string or
   * regex). Pass a `RegExp` for partial matches, e.g. `/valheim/`.
   */
  tableCell(name: string | RegExp): Locator {
    return this.page.getByRole('cell', { name });
  }

  /** Sortable column header button by its visible label (`Game`, `vCPU`, `$/hour`, etc.). */
  sortHeader(label: string): Locator {
    const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return this.page.getByRole('button', { name: new RegExp(`^${escaped}`) });
  }

  /** Click a sort header to toggle the active column / direction. */
  async clickSort(label: string): Promise<void> {
    await this.sortHeader(label).click();
  }

  /** Search input above the table that filters rows by game name. */
  filterInput(): Locator {
    return this.page.getByPlaceholder('Filter games…');
  }

  /** Type into the search input and let React rerender the filtered table. */
  async filter(query: string): Promise<void> {
    await this.filterInput().fill(query);
  }
}
```
```ts
// app/packages/web/e2e/pages/index.ts — line 3, drop the CostsRangeLabel re-export:
export { CostsPage } from './CostsPage.js';
```
- [ ] **Step 2: Run test to verify it fails (against the still-old costs.spec.ts)**
Run: `cd app/packages/web && npx playwright test costs.spec.ts --project=electron`
(Requires `npm run desktop:build` from repo root at least once beforehand.)
Expected: FAIL with compile errors — `costs.spec.ts` still imports `makeActualCosts` (Tasks 15-17 removed it from the fixtures barrel) and calls `costs.totalLabel(...)`/`costs.deltaPill()`/`costs.chartTitle()`/`costs.chartSegment(...)` (this task removed them from the page object). This is expected — Task 19 rewrites the spec.
- [ ] **Step 3: Commit**
```bash
git add app/packages/web/e2e/pages/CostsPage.ts app/packages/web/e2e/pages/index.ts
git commit -m "test(web): drop the costs range/chart/delta-pill page-object locators"
```

### Task 19: `specs/costs.spec.ts` — full rewrite

**Files:**
- Modify: `app/packages/web/e2e/specs/costs.spec.ts` (full rewrite — drops the 7-day-actuals-related import block, and the total-spend/delta-pill/stacked-chart/30d-range-switch tests)

**Interfaces:**
- Consumes: `CostsPage` from Task 18, `COST_DATA`/`MULTI_GAME_COST_DATA`/`STOPPED_GAME` from `game-data.ts` (unchanged).

- [ ] **Step 1: Run test to verify it fails**
Run: `cd app/packages/web && npx playwright test costs.spec.ts --project=electron`
Expected: FAIL — compile error, per Task 18 Step 2 above (`makeActualCosts` no longer exported; `totalLabel`/`deltaPill`/`chartTitle`/`chartSegment` no longer exist on `CostsPage`).
- [ ] **Step 2: Write minimal implementation**
```ts
// app/packages/web/e2e/specs/costs.spec.ts (full file)
import { test, expect, _electron, COST_DATA, MULTI_GAME_COST_DATA, STOPPED_GAME } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
import { CostsPage } from '../pages/index.js';
import type { CostEstimates, GameStatus } from '../fixtures/index.js';

/**
 * Specs for the `/costs` route. Each test launches its own Electron shell,
 * mocks the two IPC channels consumed by the Costs page (`costs.estimate`,
 * `games.status`) via `window.hyveon.__test.mock`, then navigates to `/costs`
 * via history injection (`CostsPage.gotoElectron`).
 *
 * The app makes no AWS Cost Explorer API calls — there is no `costs.actual`
 * channel any more (see `openspec/changes/remove-cost-explorer-calls`).
 *
 * Filter / sort exercises pass `MULTI_GAME_COST_DATA` so the table has more
 * than one row to interact with; the default `COST_DATA` only contains
 * `minecraft`.
 */
test.describe('costs page', () => {
  test('should render the cost analysis heading', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      await expect(costs.heading()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should link out to the AWS Cost Explorer console', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      await expect(costs.costExplorerLink()).toBeVisible();
      await expect(costs.costExplorerLink()).toHaveAttribute(
        'href',
        'https://console.aws.amazon.com/cost-management/home#/cost-explorer',
      );
    } finally {
      await app.close();
    }
  });

  test('should sort estimates by $/hour descending by default', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      const rows = costs.tableRows();
      // Row 0 is the header; rows 1..3 are the games sorted $/hr desc:
      // palworld ($0.32) > valheim ($0.16) > minecraft ($0.08).
      await expect(rows.nth(1)).toContainText('palworld');
      await expect(rows.nth(2)).toContainText('valheim');
      await expect(rows.nth(3)).toContainText('minecraft');
    } finally {
      await app.close();
    }
  });

  test('should re-sort estimates by game name when the Game header is clicked', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();
      await costs.clickSort('Game');

      const rows = costs.tableRows();
      // After clicking Game, default direction is ascending alphabetical.
      await expect(rows.nth(1)).toContainText('minecraft');
      await expect(rows.nth(2)).toContainText('palworld');
      await expect(rows.nth(3)).toContainText('valheim');
    } finally {
      await app.close();
    }
  });

  test('should filter estimates via the search input', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          hyveon.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          hyveon.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();
      await costs.filter('val');

      await expect(costs.tableCell(/valheim/)).toBeVisible();
      await expect(costs.tableCell(/minecraft/)).toHaveCount(0);
      await expect(costs.tableCell(/palworld/)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
```
- [ ] **Step 3: Run test to verify it passes**
Run: `cd app/packages/web && npx playwright test costs.spec.ts --project=electron`
Expected: PASS (5 tests)
- [ ] **Step 4: Commit**
```bash
git add app/packages/web/e2e/specs/costs.spec.ts
git commit -m "test(web): rewrite costs.spec.ts for the estimate-only Costs page"
```

### Task 20: `specs/discord.spec.ts` — drop the `costs.actual` mock from `seedBaseMocks`

**Files:**
- Modify: `app/packages/web/e2e/specs/discord.spec.ts:82-87`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Run test to verify it fails**
Run: `cd app/packages/web && npx playwright test discord.spec.ts --project=electron`
Expected: PASS, not FAIL — `hyveon.__test.mock('costs.actual', ...)` registers a mock for a channel that's simply never invoked by any code path any more (the Discord page never called it either), so leaving it in place is inert, not broken. This task is a cleanup, not a regression fix; there is no failing-state to reproduce, matching the plan's "nothing to break" pattern from Task 8.
- [ ] **Step 2: Write minimal implementation**
```ts
// app/packages/web/e2e/specs/discord.spec.ts
// In seedBaseMocks(), remove the costs.actual mock (keep costs.estimate):
    hyveon.__test.mock('costs.estimate', () =>
      Promise.resolve({ games: {}, totalPerHourIfAllOn: 0 }),
    );
```
- [ ] **Step 3: Run test to verify it still passes**
Run: `cd app/packages/web && npx playwright test discord.spec.ts --project=electron`
Expected: PASS (unchanged test count and outcomes)
- [ ] **Step 4: Commit**
```bash
git add app/packages/web/e2e/specs/discord.spec.ts
git commit -m "test(web): drop the unused costs.actual mock from discord.spec.ts"
```

### Task 21: `specs/dashboard.spec.ts` and `pages/DashboardPage.ts` — update KPI tile-label assertions

**Files:**
- Modify: `app/packages/web/e2e/specs/dashboard.spec.ts:165-175`
- Modify: `app/packages/web/e2e/pages/DashboardPage.ts:157-160` (doc-comment only)

**Interfaces:**
- Consumes: `KpiStrip`'s new tile labels from PR 1 Task 1 (`'Current run rate'`, `'Est. month cap'`).

This spec was not in `tasks.md`'s named e2e-touchpoint list, but it directly asserts the old tile labels and would fail against the already-shipped PR 1 UI — found via a repo-wide grep during this plan's authoring (see the PR 3 intro).

- [ ] **Step 1: Run test to verify it fails**
Run: `cd app/packages/web && npx playwright test dashboard.spec.ts --project=electron`
Expected: FAIL on `'should render the KPI strip with the four ops tiles'` — `dashboard.kpiTileLabel('Spend today')` finds nothing, since PR 1's `KpiStrip` renders `'Current run rate'` instead.
- [ ] **Step 2: Write minimal implementation**
```ts
// app/packages/web/e2e/specs/dashboard.spec.ts
  test('should render the KPI strip with the four ops tiles', async () => {
    await applyHyveonMocks(win, { statuses: MULTI_GAME_STATUSES });
    await dashboard.gotoElectron();

    await expect(dashboard.kpiTileLabel('Servers running')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Current run rate')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Est. month cap')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Active alerts')).toBeVisible();
    // 1 of 2 games are running in MULTI_GAME_STATUSES (valheim).
    await expect(dashboard.serversRunningValue('1/2')).toBeVisible();
  });
```
```ts
// app/packages/web/e2e/pages/DashboardPage.ts — line 157, update the example labels:
  /** A KPI tile by its label ('Servers running', 'Current run rate', etc.). */
  kpiTileLabel(label: string): Locator {
    return this.page.getByText(label);
  }
```
- [ ] **Step 3: Run test to verify it passes**
Run: `cd app/packages/web && npx playwright test dashboard.spec.ts --project=electron`
Expected: PASS
- [ ] **Step 4: Commit**
```bash
git add app/packages/web/e2e/specs/dashboard.spec.ts app/packages/web/e2e/pages/DashboardPage.ts
git commit -m "test(web): update dashboard.spec.ts KPI tile-label assertions"
```

### Task 22: `screenshots/demo-data.ts` — remove `demoActualCosts` and its wiring

**Files:**
- Modify: `app/packages/web/e2e/screenshots/demo-data.ts:26-56,227-247,555-560,610-614`

**Interfaces:**
- Consumes: Task 15's `game-data.ts` context (parallel cleanup — this file has its own separate `ActualCosts` import from `../../src/api.service.js`, not from `game-data.ts`).
- Produces: `seedDemo()` mocking `costs.estimate` only — no `costs.actual` mock, no `demoActualCosts()`/`ActualCosts` in this file.

This feeds `capture.spec.ts`'s `costs.png` screenshot, which only navigates to `/costs` and takes a screenshot — no assertions on the removed chart/total, so there's no independent pass/fail signal beyond the screenshot capture not throwing. Verified by typecheck plus a run of the screenshot spec.

- [ ] **Step 1: Write minimal implementation**
```ts
// app/packages/web/e2e/screenshots/demo-data.ts
// Remove `ActualCosts,` from the src/api.service.js type-only import (line 51):
import type {
  CostEstimates,
  DiscordConfigRedacted,
  EnvInfo,
  GameEstimate,
} from '../../src/api.service.js';

// Delete the demoActualCosts() function and its doc comment entirely (was:
// "Builds a deterministic `ActualCosts` window ending at {@link DEMO_NOW}, ..."
// / `export function demoActualCosts(days: number): ActualCosts { ... }`,
// directly after DEMO_COST_ESTIMATES).

// In seedDemo()'s `data` object, remove the actualCostsByDays field entirely:
  const data = {
    env: overrides.env ?? DEMO_ENV,
    statuses: overrides.statuses ?? DEMO_STATUSES,
    games: overrides.games ?? DEMO_GAMES,
    costEstimates: overrides.costEstimates ?? DEMO_COST_ESTIMATES,
    discord: overrides.discord ?? DEMO_DISCORD_CONFIG,
    drift: overrides.drift ?? DEMO_DRIFT_REPORT,
    audit: overrides.audit ?? DEMO_AUDIT,
    logLines: overrides.logLines ?? DEMO_LOG_LINES,
    logStreamLines: overrides.logStreamLines ?? DEMO_LOG_STREAM_LINES,
    iacHistory: overrides.iacHistory ?? DEMO_IAC_HISTORY,
    iacPlanChunks: overrides.iacPlanChunks ?? DEMO_IAC_PLAN_CHUNKS,
    iacApplyChunks: overrides.iacApplyChunks ?? DEMO_IAC_APPLY_CHUNKS,
    stackInitEvents: DEMO_STACK_INIT_EVENTS,
    diagnosticsLines: DEMO_DIAGNOSTICS_TAIL,
    diagnosticsPath: '/home/hyveon/.config/Hyveon/logs/desktop-main.log',
  };

// Inside the addInitScript callback, remove the costs.actual mock line, keeping only:
    mock('costs.estimate', () => Promise.resolve(d.costEstimates));
```
- [ ] **Step 2: Run typecheck and the screenshot spec**
Run: `npm run app:typecheck && cd app/packages/web && npx playwright test capture.spec.ts --project=electron -g costs.png`
Expected: PASS — the `costs.png` test navigates to `/costs` and captures a screenshot with no assertions on the removed UI, so it passes as long as the page renders without throwing.
- [ ] **Step 3: Commit**
```bash
git add app/packages/web/e2e/screenshots/demo-data.ts
git commit -m "test(web): remove demoActualCosts from the screenshot harness fixtures"
```

### Task 23: PR 3 gate and open

- [ ] **Step 1: Run the full e2e gate**
Run, from repo root:
```bash
npm run app:lint
npm run app:typecheck
npm run app:test
npm run app:test:e2e
```
Expected: all four clean/green — this is the first point in the stack where `app:test:e2e` is expected to be fully green end-to-end (PR 1's gate had known pre-existing failures fixed here).
- [ ] **Step 2: Open the PR**
```bash
git push -u origin costexplorer-3-e2e
gh pr create --title "test(web): update e2e fixtures and specs for Cost Explorer removal" --base costexplorer-2-backend --body "$(cat <<'EOF'
## Summary
- Remove `ActualCosts`/`makeActualCosts`/`demoActualCosts` fixtures and every `costs.actual` mock/route across e2e fixtures, page objects, and specs.
- Rewrite `costs.spec.ts` for the estimate-only Costs page (drops total-spend/delta-pill/stacked-chart/range-switch tests, adds a Cost Explorer link-out assertion).
- Update `dashboard.spec.ts`'s KPI tile-label assertions to match PR 1's renamed tiles (found via repo-wide grep beyond `tasks.md`'s named touchpoints).
- Drop the `costs.actual` → `/api/costs/actual` mapping from the chromium-tier `hyveon-http-bridge.ts` shim (also found via grep, not named in `tasks.md`).

Part of the `remove-cost-explorer-calls` PR stack (3/4), based on PR 2's backend deletion.

## Test plan
- [x] `npm run app:lint`
- [x] `npm run app:typecheck`
- [x] `npm run app:test`
- [x] `npm run app:test:e2e` — fully green (first point in the stack with no known pre-existing failures)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened against `costexplorer-2-backend`, titled per Conventional Commits.

---

## PR 4: costexplorer-4-docs-iam (base: costexplorer-3-e2e)

Rewrites the docs pages describing the removed behavior and drops `ce:*` from the `HyveonDeployAll` IAM policy. Docs tasks don't fit the unit-test TDD shape (there's no test runner for prose) — each task instead pairs a content rewrite with the repo's actual documentation quality gate: the `write-docs` skill's three evaluator subagents (`docs-accuracy-auditor`, `docs-coverage-auditor`, `docs-style-reviewer`).

### Task 24: `docs/docs/app/costs.md` — rewrite for estimate-only + link-out

**Files:**
- Modify: `docs/docs/app/costs.md` (full rewrite, 188 lines)

- [ ] **Step 1: Rewrite the page**
```markdown
---
title: Costs
sidebar_position: 8
---

# Costs

The Costs screen (route `/costs`) shows what each declared game costs to run,
estimated from its declared Fargate CPU and memory against published
on-demand rates. **The app makes no AWS Cost Explorer API calls, ever** — no
automatic fetch, no manual "fetch actuals" button. For real billed spend, use
the AWS Cost Explorer console directly, one click away via the callout on
this page.

> Per-game Fargate cost estimates. For real billed spend, see AWS Cost Explorer.

![The Costs page showing an AWS Cost Explorer callout card and a per-game estimates table](/img/app/costs.png)

## Why no actuals live in the app

AWS Cost Explorer bills $0.01 per `GetCostAndUsage` request. Earlier versions
of this page called it automatically on every page load and range-selector
toggle, silently charging the operator's AWS bill. That call chain has been
removed end-to-end — see `openspec/changes/remove-cost-explorer-calls` for the
full rationale. The estimates below are computed from each game's ECS task
definition (`DescribeTaskDefinition`, not a billed API) and are always free.

## See real billed spend

A callout card links out to the AWS Cost Explorer console home
(`https://console.aws.amazon.com/cost-management/home#/cost-explorer`) — a
static link, not a deep link with pre-filled date ranges or service filters
(AWS's query-param format for that is undocumented and could change silently).
Pick your own date range and filters once there.

## Per-game estimates

A table of what each game costs to run, computed from its declared Fargate
CPU and memory.

| Column | Contents |
|---|---|
| **Game** | Name, with its color swatch |
| **vCPU** | e.g. `1` for 1024 CPU units |
| **Memory** | e.g. `4 GB` |
| **$/hour** | Shown to four decimal places when under a dollar |
| **$/day** | |
| **$/month** | |

Sort by clicking any column header; the default is `$/hour` descending.
Clicking a new column sorts descending for numeric columns and ascending for
Game; clicking the active column flips the direction.

The filter box in the card header (`Filter games…`) does a case-insensitive
substring match on the game name.

On a narrow window the table becomes a stack of cards with the same six
values. The card stack has no sort controls.

### What the day and month figures assume

The footnote under the table states it plainly:

> `$/day` assumes 24 hr/day. `$/month` assumes 4 hr/day × 30 days.

So:

| Column | Formula |
|---|---|
| `$/hour` | `vCPU × $0.04048 + GB × $0.004445` |
| `$/day` | `$/hour × 24` |
| `$/month` | `$/hour × 4 × 30` — that is **120 hours**, not a full month |

The two columns therefore answer different questions. `$/day` is the worst
case if you leave a server up around the clock. `$/month` is a realistic
monthly bill for a server used a few hours an evening — which is what the
start/stop-on-demand design is built for. Neither is `$/day × 30`.

Two further caveats:

- **These are Fargate compute rates only.** They exclude EFS storage, data
  transfer, Route 53, Lambda, DynamoDB and CloudWatch. Your real bill will be
  higher.
- The rates are hardcoded **us-east-1 on-demand** prices. If you deploy to
  another region, the estimates will be off by that region's premium.

If a game's task definition cannot be read, the estimate falls back to 2 vCPU
/ 8 GB — with no indication in the table that it is a fallback. A row showing
exactly `2` vCPU and `8 GB` when you declared something else is the tell.

Estimates are fetched once when the page loads.

When there is nothing to show: `No estimates available.`

## The dashboard's cost tiles

The [dashboard](/app/dashboard) shows two related but distinct figures —
**Current run rate** and **Est. month cap** — computed from the same free
per-game estimates as this page, not from this page's table directly. See the
dashboard doc for details.
```
- [ ] **Step 2: Run the docs evaluators**
Dispatch `docs-accuracy-auditor` and `docs-coverage-auditor` and `docs-style-reviewer` (via the `write-docs` skill, or directly as subagents) against this file, in parallel.
Expected: no accuracy findings (every claim above is verified against `costs.page.tsx` from PR 1 and `CostService.ts`/`AwsCloudProvider.ts` from PR 2); no style findings (frontmatter/sidebar position unchanged, links resolve); coverage confirms this page reflects the change.
- [ ] **Step 3: Fix any findings**
Apply fixes if either evaluator flags something; re-run until clean.
- [ ] **Step 4: Commit**
```bash
git add docs/docs/app/costs.md
git commit -m "docs: rewrite costs.md for estimate-only display and the Cost Explorer link-out"
```

### Task 25: `docs/docs/app/dashboard.md` — rewrite the KPI tile section

**Files:**
- Modify: `docs/docs/app/dashboard.md:14-40`

- [ ] **Step 1: Rewrite the KPI strip section**
```markdown
## The KPI strip

Four tiles across the top. Each has a label, a large value, and a small
delta line underneath.

| Tile | Value | Delta line |
|---|---|---|
| **Servers running** | `2/5` — running over total declared | `all idle`, or `2 active` |
| **Current run rate** | Sum of `$/hour` estimates across currently-running games, e.g. `$0.12` | `per hour` |
| **Est. month cap** | `totalPerHourIfAllOn × 24 × days in the current month` — what a full month would cost with every server running 24/7, e.g. `$89.28` | `if every game ran all month` |
| **Active alerts** | Count of games in the `error` state | `all healthy`, or `3 need attention` |

Both cost tiles are computed entirely from the free per-game Fargate estimate
(`GET costs.estimate`, already fetched for the game cards' `$ per hour` stat)
and the current run state — **the app makes no AWS Cost Explorer API calls,
ever**. There is no "no data" em-dash state for these tiles the way the old
actuals-driven tiles had, because there is no external call that can fail:
the underlying estimate is either available (from `costs.estimate`) or
defaults to `$0.00`.

**Servers running** shows an em-dash when no games are declared at all.
**Active alerts** always shows a real number, including `0`.

For real dollars actually billed to your AWS account, see the
[Costs page](/app/costs)'s link-out to the AWS Cost Explorer console.
```
- [ ] **Step 2: Run the docs evaluators**
Dispatch `docs-accuracy-auditor`, `docs-coverage-auditor`, `docs-style-reviewer` against this file.
Expected: no findings — every value/formula above matches `kpi-strip.component.tsx` from PR 1 Task 1.
- [ ] **Step 3: Fix any findings**
Apply fixes if flagged; re-run until clean.
- [ ] **Step 4: Commit**
```bash
git add docs/docs/app/dashboard.md
git commit -m "docs: rewrite dashboard.md's KPI tile section for the free-estimate tiles"
```

### Task 26: `docs/docs/components/management-app.md` — update the `CostsController` row

**Files:**
- Modify: `docs/docs/components/management-app.md:167,204-214`

- [ ] **Step 1: Update the controllers table row**
```markdown
| `CostsController` | `costs.estimate` | Per-game Fargate estimates, derived from each game's `{game}-server` task-definition CPU/memory. The app makes no AWS Cost Explorer API calls — see [Costs](/app/costs). |
```
- [ ] **Step 2: Update the "Key services" bullet mentioning `CostService`'s Cost Explorer usage**
```markdown
- **`EcsService` / `Ec2Service` / `LogsService` / `CostService` /
  `FileManagerService`** — cloud-facing services. `EcsService` routes
  ECS run/stop/status calls through the injected `CLOUD_PROVIDER` token
  (a `CloudProvider` implementation from `@hyveon/cloud-aws`) rather than
  instantiating an `@aws-sdk/client-ecs` client directly; `Ec2Service` /
  `LogsService` / `FileManagerService` still call the AWS SDK v3 clients
  (CloudWatch Logs, EC2) directly, since those aren't yet behind a
  cloud-agnostic contract. `CostService` is pure arithmetic — no AWS SDK
  client at all — since the Cost Explorer call chain was removed (see
  `openspec/changes/remove-cost-explorer-calls`). New cloud-facing code
  should prefer adding to (or consuming) the `CLOUD_PROVIDER` /
  `SECRETS_STORE` / `REMOTE_FILE_STORE` / `DISCORD_RECEIVER` /
  `AUDIT_LOG_STORE` / `RUN_RECORD_STORE` tokens over reaching for a new AWS
```
(the rest of that bullet, after "new AWS", is unchanged — only the sentence about which services still call the SDK directly is edited to remove `Cost Explorer` from the parenthetical and to note `CostService`'s new pure-arithmetic shape.)
- [ ] **Step 2: Run the docs evaluators**
Dispatch `docs-accuracy-auditor`, `docs-coverage-auditor`, `docs-style-reviewer` against this file.
Expected: no findings — matches `costs.controller.ts`/`CostService.ts` from PR 2.
- [ ] **Step 3: Fix any findings**
Apply fixes if flagged; re-run until clean.
- [ ] **Step 4: Commit**
```bash
git add docs/docs/components/management-app.md
git commit -m "docs: update management-app.md's CostsController row for the removed costs.actual channel"
```

### Task 27: `docs/docs/setup.md` — drop `ce:*` from the `HyveonDeployAll` policy

**Files:**
- Modify: `docs/docs/setup.md:70-95`

- [ ] **Step 1: Remove the `ce:*` statement**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HyveonDeploy",
      "Effect": "Allow",
      "Action": [
        "ecs:*",
        "elasticfilesystem:*",
        "ec2:*",
        "lambda:*",
        "logs:*",
        "cloudwatch:*",
        "events:*",
        "scheduler:*",
        "route53:*",
        "dynamodb:*",
        "secretsmanager:*",
        "s3:*",
        "cloudfront:*",
        "acm:*"
      ],
      "Resource": "*"
    },
```
(the `"ce:*",` line — previously between `"route53:*",` and `"dynamodb:*",` — is deleted; nothing else in the statement or the surrounding document changes. Per `design.md` D5, the guided-IAM-wizard's runtime policy, `app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`, was already checked and grants no `ce:` actions — this manual-setup deploy policy in `setup.md` is the only place `ce:*` appears.)
- [ ] **Step 2: Confirm no other `ce:` references remain**
Run: `grep -n "\"ce:" docs/docs/setup.md app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`
Expected: zero matches in both files.
- [ ] **Step 3: Run the docs evaluators**
Dispatch `docs-accuracy-auditor`, `docs-coverage-auditor`, `docs-style-reviewer` against this file (this change is small and localized — a lightweight pass, not a full rewrite review).
Expected: no findings — the policy JSON is still valid, and `HyveonDeployAll`'s IAM row in `CLAUDE.md` still points to `docs/docs/setup.md` as the single source of truth, unaffected by an in-place statement edit.
- [ ] **Step 4: Commit**
```bash
git add docs/docs/setup.md
git commit -m "docs: drop unused ce:* from the HyveonDeployAll IAM policy"
```

### Task 28: PR 4 gate and open

- [ ] **Step 1: Run the full docs-PR gate**
Run, from repo root:
```bash
npm run app:lint
npm run app:typecheck
npm run app:test
```
Expected: all three clean/green. (`app:test:e2e`/`app:test:integration` are not required — no renderer, preload, controller, or service code changes in this PR, per `CLAUDE.md`'s trigger rules.)
- [ ] **Step 2: Open the PR**
```bash
git push -u origin costexplorer-4-docs-iam
gh pr create --title "docs: document Cost Explorer removal and drop ce:* from the deploy policy" --base costexplorer-3-e2e --body "$(cat <<'EOF'
## Summary
- Rewrite `costs.md` and `dashboard.md` for the estimate-only display + AWS Cost Explorer link-out.
- Update `management-app.md`'s `CostsController` row and `CostService` description.
- Drop `ce:*` from `setup.md`'s `HyveonDeployAll` IAM policy — least privilege, since no code path calls Cost Explorer any more.

Closes out the `remove-cost-explorer-calls` PR stack (4/4), based on PR 3's e2e updates.

## Test plan
- [x] `npm run app:lint`
- [x] `npm run app:typecheck`
- [x] `npm run app:test`
- [x] Docs evaluator agents (`docs-accuracy-auditor`, `docs-coverage-auditor`, `docs-style-reviewer`) run clean on every changed page

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened against `costexplorer-3-e2e`, titled per Conventional Commits.

---

## Close out (post-merge, not a PR in this stack)

Once all four PRs above are merged to `main` in order, run `/opsx:sync` (or `/opsx:archive` if no further follow-up work on this change is expected) so `openspec/specs/` gains the new `cost-visibility` capability described in `specs/cost-visibility/spec.md`. This matches `tasks.md`'s group 5 ("Close out") — it is not itself a PR-stack entry and has no code changes, so it is not expanded into a numbered Task above.
