import { useState } from 'react';
import type { OverwriteSummary } from '@hyveon/shared/folderUpload';
import { Button } from '@/components/ui/button.component';
import { api } from '../../api.service.js';
import { formatBytes } from '../../lib/format.utils.js';

/** Props for {@link OverwriteConfirmation}. */
export interface OverwriteConfirmationProps {
  /** Game whose paused run is waiting for an answer. */
  game: string;
  /** What the pre-upload check found on the volume. */
  summary: OverwriteSummary;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Warning shown while an upload is paused before writing anything because some planned files already exist on the
 * volume with a different size. Overwrite continues the run; Cancel ends it (helper stopped) with nothing written.
 *
 * @param props - See {@link OverwriteConfirmationProps}.
 */
export function OverwriteConfirmation({ game, summary }: OverwriteConfirmationProps) {
  const [answering, setAnswering] = useState(false);
  const [failed, setFailed] = useState(false);
  const hidden = summary.conflictCount - summary.samples.length;

  async function answer(proceed: boolean) {
    setAnswering(true);
    setFailed(false);
    try {
      const { resolved } = await api.folderConfirmOverwrite(game, proceed);
      if (!resolved) setAnswering(false);
    } catch {
      setAnswering(false);
      setFailed(true);
    }
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="overwrite-confirmation-title"
      className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm"
      data-testid="folder-upload-overwrite"
    >
      <p id="overwrite-confirmation-title" className="font-medium">
        {plural(summary.conflictCount, 'file')} on the volume would be overwritten ({summary.identicalCount} identical{' '}
        {summary.identicalCount === 1 ? 'file' : 'files'} will be skipped, {summary.newCount} new).
      </p>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Nothing has been written yet.
        {summary.otherExistingCount > 0 && ` ${plural(summary.otherExistingCount, 'other existing file')} in the same folders will be left alone.`}
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto font-[var(--font-mono)] text-xs">
        {summary.samples.map((c) => (
          <li key={c.relPath} className="break-all">
            {c.relPath}: {formatBytes(c.existingSize)} on volume, {formatBytes(c.newSize)} new
          </li>
        ))}
        {hidden > 0 && <li>and {hidden} more</li>}
      </ul>
      {failed && (
        <p role="alert" className="text-xs text-[var(--color-red)]">
          Could not send your answer; try again.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={answering} onClick={() => void answer(true)}>
          Overwrite and upload
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={answering} onClick={() => void answer(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
