import { useState, type DragEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils.utils';

/** Props for {@link DropZone}. */
export interface DropZoneProps {
  /** Ignores drops (and shows no drop affordance) while true. */
  disabled: boolean;
  onDropFiles(files: File[]): void;
  children: ReactNode;
}

/** Wraps the listing so files dragged from the desktop upload into the current folder. */
export function DropZone({ disabled, onDropFiles, children }: DropZoneProps) {
  const [over, setOver] = useState(false);

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (!disabled && files.length > 0) onDropFiles(files);
  }

  return (
    <div
      data-testid="volume-drop-zone"
      className={cn('rounded-[var(--radius-sm)] border border-dashed border-transparent', over && !disabled && 'border-[var(--color-primary)] bg-[var(--color-primary)]/5')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}
