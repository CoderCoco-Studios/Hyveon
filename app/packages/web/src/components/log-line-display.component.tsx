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

/** Render a single line, splitting on case-insensitive search matches. Shared by `/logs` and the Diagnostics panel. */
export function HighlightedLine({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
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
  return (
    <>
      {parts.map((p, idx) =>
        p.match ? (
          <mark key={idx} className="rounded-[2px] bg-[var(--color-amber)]/40 px-[1px] text-[var(--color-foreground)]">
            {p.text}
          </mark>
        ) : (
          <span key={idx}>{p.text}</span>
        ),
      )}
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
