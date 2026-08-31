import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { cn } from '@/lib/utils.utils';

/** Props for {@link SectionCard}. */
export interface SectionCardProps {
  /** Small-caps section heading, rendered as the card's `CardTitle`. */
  title: ReactNode;
  /** Optional control rendered on the opposite side of the header from `title` (e.g. a filter input or search box). */
  action?: ReactNode;
  /** Section body, rendered inside `CardContent`. */
  children: ReactNode;
  /** Extra classes forwarded to the outer `Card`. */
  className?: string;
}

/**
 * `Card` + small-caps `CardTitle` shell used by every list/table page
 * section (audit log, declared games, run history, cost estimates). Pairs
 * with {@link AsyncContent} for the loading/error/empty/content body, but is
 * kept separate so a section can render without a loading chain (e.g. a
 * static callout card) and so `AsyncContent` can render outside a card
 * (e.g. the dashboard's game grid).
 */
export function SectionCard({ title, action, children, className }: SectionCardProps) {
  return (
    <Card className={className}>
      <CardHeader className={cn('pb-3', action && 'flex flex-row items-center justify-between gap-4')}>
        <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
