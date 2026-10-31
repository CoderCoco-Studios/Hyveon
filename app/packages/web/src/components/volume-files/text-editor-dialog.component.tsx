import { useEffect, useRef, useState } from 'react';
import type { VolumeEntryInfo, VolumeResult, VolumeTextFile } from '@hyveon/shared/volumeFiles';
import { Button } from '@/components/ui/button.component';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.component';
import { Textarea } from '@/components/ui/textarea.component';
import { InlineAlert } from '../inline-alert.component.js';
import { LoadingState } from '../loading-state.component.js';

/** Message shown when a file is too large or not text. */
export const NOT_EDITABLE_MESSAGE = "This file can't be edited here. Download it instead.";

/** Props for {@link TextEditorDialog}. */
export interface TextEditorDialogProps {
  /** Entry being edited, or `null` when closed. */
  entry: VolumeEntryInfo | null;
  /** Full volume path of {@link TextEditorDialogProps.entry}. */
  path: string | null;
  /** Why saving is disabled, or `null`. */
  saveDisabledReason: string | null;
  /** Visible note shown above the footer, e.g. that the session ended and the text can only be copied out. */
  notice?: string;
  readText(path: string): Promise<VolumeResult<VolumeTextFile>>;
  writeText(path: string, content: string, expectedModifiedMs: number): Promise<VolumeResult<{ modifiedMs: number }>>;
  onDownload(entry: VolumeEntryInfo): void;
  /** Called after a successful save so the listing can pick up the new size and time. */
  onSaved(): void;
  onClose(): void;
}

type Loaded = { phase: 'loading' } | { phase: 'ready'; modifiedMs: number } | { phase: 'unavailable' } | { phase: 'error'; message: string };

/** Editor body, mounted per opened file so its content and errors never carry over to the next file. */
function EditorBody({ entry, path, saveDisabledReason, notice, readText, writeText, onDownload, onSaved, onClose }: TextEditorDialogProps & { entry: VolumeEntryInfo; path: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [content, setContent] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const readRef = useRef(readText);
  useEffect(() => {
    readRef.current = readText;
  });

  useEffect(() => {
    let cancelled = false;
    void readRef.current(path).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setContent(result.value.content);
        setLoaded({ phase: 'ready', modifiedMs: result.value.modifiedMs });
      } else if (result.code === 'too-large' || result.code === 'binary') setLoaded({ phase: 'unavailable' });
      else setLoaded({ phase: 'error', message: result.message });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function save(modifiedMs: number) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const result = await writeText(path, content, modifiedMs);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    // modifiedMs 0 means main could not stat the file; re-read so the next save has a real conflict token.
    let nextModifiedMs = result.value.modifiedMs;
    if (nextModifiedMs === 0) {
      const reread = await readText(path);
      if (reread.ok) nextModifiedMs = reread.value.modifiedMs;
    }
    setLoaded({ phase: 'ready', modifiedMs: nextModifiedMs });
    setSaved(true);
    onSaved();
  }

  return (
    <>
      {loaded.phase === 'loading' && <LoadingState label="Loading file…" />}
      {loaded.phase === 'error' && <InlineAlert message={loaded.message} />}
      {loaded.phase === 'unavailable' && <p role="status" className="text-sm">{NOT_EDITABLE_MESSAGE}</p>}
      {loaded.phase === 'ready' && (
        <>
          <Textarea aria-label="File contents" rows={16} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          {notice && <p role="status" className="text-sm text-[var(--color-amber)]">{notice}</p>}
          <InlineAlert message={saveError} />
          {saved && <p role="status" className="text-sm text-[var(--color-green)]">Saved.</p>}
        </>
      )}
      <DialogFooter>
        {loaded.phase === 'unavailable' && (
          <Button type="button" onClick={() => onDownload(entry)}>
            Download
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        {loaded.phase === 'ready' && (
          <Button type="button" disabled={saving || saveDisabledReason !== null} title={saveDisabledReason ?? undefined} onClick={() => void save(loaded.modifiedMs)}>
            Save
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * Edits a small text file in a dialog.
 *
 * @remarks
 * Loads the file on open. A file that is too large or binary shows {@link NOT_EDITABLE_MESSAGE} with a Download
 * button. A failed save, including a `conflict`, keeps the textarea content and shows the message in the dialog.
 *
 * @param props - See {@link TextEditorDialogProps}.
 */
export function TextEditorDialog(props: TextEditorDialogProps) {
  const { entry, path, onClose } = props;
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{entry?.name ?? 'File'}</DialogTitle>
          <DialogDescription>{path}</DialogDescription>
        </DialogHeader>
        {entry && path && <EditorBody key={path} {...props} entry={entry} path={path} />}
      </DialogContent>
    </Dialog>
  );
}
