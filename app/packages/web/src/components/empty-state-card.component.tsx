import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.component';
import { cn } from '@/lib/utils.utils';

/** Visual tone for {@link EmptyStateCard} — `'error'` tints the border and icon square red instead of the primary color. */
export type EmptyStateCardTone = 'neutral' | 'error';

const TONE_STYLES: Record<EmptyStateCardTone, { border: string; iconBg: string; iconColor: string }> = {
  neutral: {
    border: 'border-[var(--color-border)]',
    iconBg: 'bg-[var(--color-primary)]/10',
    iconColor: 'text-[var(--color-primary-light)]',
  },
  error: {
    border: 'border-[var(--color-red)]/40',
    iconBg: 'bg-[var(--color-red)]/10',
    iconColor: 'text-[var(--color-red)]',
  },
};

/** Props for {@link EmptyStateCard}. */
export interface EmptyStateCardProps {
  /** Icon shown in the tinted square above the title. */
  icon: LucideIcon;
  /** Visual tone; defaults to `'neutral'`. */
  tone?: EmptyStateCardTone;
  /** Card title. */
  title: ReactNode;
  /** Card description, shown under the title. */
  description: ReactNode;
  /** Optional call-to-action row (links, buttons) rendered below the description. */
  children?: ReactNode;
}

/** Icon-in-tinted-square + title + description + optional CTA row — the empty/error-state card shape reused across routes. */
export function EmptyStateCard({ icon: Icon, tone = 'neutral', title, description, children }: EmptyStateCardProps) {
  const styles = TONE_STYLES[tone];
  return (
    <Card className={cn('max-w-lg w-full', styles.border)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3 mb-1">
          <div className={cn('p-2 rounded-lg', styles.iconBg)}>
            <Icon className={cn('size-5', styles.iconColor)} />
          </div>
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children && <CardContent className="flex flex-wrap gap-4">{children}</CardContent>}
    </Card>
  );
}
