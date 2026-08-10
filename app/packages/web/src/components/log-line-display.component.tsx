import { Fragment, useMemo } from 'react';
import { Filter } from 'lucide-react';
import { Badge } from './ui/badge.component.js';
import { Button } from './ui/button.component.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './ui/dropdown-menu.component.js';
import { ALL_LOG_LEVELS, LOG_LEVEL_BADGE, type LogLevel } from '../lib/log-level.utils.js';
import { parseAnsiLine } from '../lib/ansi.utils.js';
import { cn } from '../lib/utils.utils.js';

/** One run of `text` from splitting against a case-insensitive search `query`. */
interface QueryPart {
  text: string;
  match: boolean;
}

/** A case-insensitive match of `query` against the concatenated plain text of a line, as a `[start, end)` offset range. */
interface MatchRange {
  start: number;
  end: number;
}

/** Finds every non-overlapping case-insensitive match of `query` in `text`, as offset ranges into `text`. */
function findMatches(text: string, query: string): MatchRange[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const ranges: MatchRange[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) break;
    ranges.push({ start: idx, end: idx + q.length });
    i = idx + q.length;
  }
  return ranges;
}

/** Splits a segment's `text` (which starts at `segStart` within the full line) into non-matching/matching runs, intersecting `matches` against the segment's own bounds so a match spanning multiple ANSI-styled segments still highlights in each. */
function sliceSegment(text: string, segStart: number, matches: MatchRange[]): QueryPart[] {
  const segEnd = segStart + text.length;
  const parts: QueryPart[] = [];
  let cursor = segStart;
  for (const m of matches) {
    const start = Math.max(m.start, segStart);
    const end = Math.min(m.end, segEnd);
    if (start >= end) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor - segStart, start - segStart), match: false });
    parts.push({ text: text.slice(start - segStart, end - segStart), match: true });
    cursor = end;
  }
  if (cursor < segEnd) parts.push({ text: text.slice(cursor - segStart), match: false });
  if (parts.length === 0) parts.push({ text, match: false });
  return parts;
}

/** Render a single line, applying ANSI color/bold styling and splitting on case-insensitive search matches. Shared by `/logs` and the Diagnostics panel. */
export function HighlightedLine({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => parseAnsiLine(text), [text]);
  const segmentStarts = useMemo(() => {
    const starts: number[] = [];
    let offset = 0;
    for (const seg of segments) {
      starts.push(offset);
      offset += seg.text.length;
    }
    return starts;
  }, [segments]);
  const matches = useMemo(
    () => findMatches(segments.map((seg) => seg.text).join(''), query),
    [segments, query],
  );

  return (
    <>
      {segments.map((seg, i) => {
        const segStart = segmentStarts[i]!;
        const parts = sliceSegment(seg.text, segStart, matches).map((p, j) =>
          p.match ? (
            <mark key={j} className="rounded-[2px] bg-[var(--color-amber)]/40 px-[1px] text-[var(--color-foreground)]">
              {p.text}
            </mark>
          ) : (
            p.text
          ),
        );
        if (!seg.colorClass && !seg.bold) return <Fragment key={i}>{parts}</Fragment>;
        return (
          <span key={i} className={cn(seg.colorClass, seg.bold && 'font-bold')}>
            {parts}
          </span>
        );
      })}
    </>
  );
}

/** Multi-select dropdown for hiding log levels. Default: nothing hidden. Shared by `/logs` and the Diagnostics panel. */
export function LevelFilterMenu({ hidden, onToggle }: { hidden: Set<LogLevel>; onToggle: (lvl: LogLevel) => void }) {
  const visibleCount = ALL_LOG_LEVELS.length - hidden.size;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Levels
          <span className="text-[var(--color-muted-foreground)]">
            ({visibleCount}/{ALL_LOG_LEVELS.length})
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Show levels</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_LOG_LEVELS.map((lvl) => (
          <DropdownMenuCheckboxItem key={lvl} checked={!hidden.has(lvl)} onCheckedChange={() => onToggle(lvl)} onSelect={(e) => e.preventDefault()}>
            <Badge variant={LOG_LEVEL_BADGE[lvl].variant} className="h-4 px-1.5 py-0 text-[10px] leading-4">
              {LOG_LEVEL_BADGE[lvl].label}
            </Badge>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
