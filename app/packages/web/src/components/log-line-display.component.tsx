import { Fragment } from 'react';
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

/** Splits `text` into non-matching/matching runs against a case-insensitive `query`. Returns a single non-matching run when `query` is empty. */
function splitByQuery(text: string, query: string): QueryPart[] {
  if (!query) return [{ text, match: false }];
  const q = query.toLowerCase();
  const parts: QueryPart[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return parts;
}

/** Render a single line, applying ANSI color/bold styling and splitting on case-insensitive search matches. Shared by `/logs` and the Diagnostics panel. */
export function HighlightedLine({ text, query }: { text: string; query: string }) {
  return (
    <>
      {parseAnsiLine(text).map((seg, i) => {
        const parts = splitByQuery(seg.text, query).map((p, j) =>
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
