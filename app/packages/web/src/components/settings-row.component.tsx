import type { ReactNode } from 'react';

/**
 * Bordered "label + description + trailing action" row shared by the
 * Pulumi Engine, Automatic Updates, and Check Now rows on `settings.page.tsx`.
 *
 * @param label - the row's bold title text.
 * @param description - the row's muted detail line, rendered below `label`.
 * @param children - the trailing action (button, toggle, etc.).
 * @returns the row's markup.
 */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
