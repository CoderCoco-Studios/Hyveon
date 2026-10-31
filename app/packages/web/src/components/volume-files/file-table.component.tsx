import { ArrowDown, ArrowUp, File, Folder } from 'lucide-react';
import type { VolumeEntryInfo } from '@hyveon/shared/volumeFiles';
import { isValidEntryName } from '@hyveon/shared/volumeFiles';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';
import { formatBytes } from '../../lib/format.utils.js';
import { RowActions, UNHANDLED_NAME_MESSAGE, type RowActionsProps } from './file-actions.component.js';
import { formatModified, type VolumeSort, type VolumeSortKey } from './volume-files.utils.js';

/** Props for {@link FileTable}. */
export interface FileTableProps extends Omit<RowActionsProps, 'entry'> {
  entries: VolumeEntryInfo[];
  sort: VolumeSort;
  /** Called with the sort the operator picked; clicking the active column flips its direction. */
  onSort(sort: VolumeSort): void;
  /** Opens a folder of the current directory. */
  onOpenFolder(name: string): void;
}

/** Sort header button; shows the direction arrow on the active column. */
function SortHeader({ label, column, sort, onSort }: { label: string; column: VolumeSortKey; sort: VolumeSort; onSort(sort: VolumeSort): void }) {
  const active = sort.key === column;
  const next: VolumeSort = { key: column, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' };
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 font-medium" onClick={() => onSort(next)}>
        {label}
        {active && <Arrow className="size-3" aria-hidden="true" />}
      </button>
    </TableHead>
  );
}

/** One directory entry: folders open on click, files are plain text. */
function FileRow({ entry, onOpenFolder, ...actions }: Omit<FileTableProps, 'entries' | 'sort' | 'onSort'> & { entry: VolumeEntryInfo }) {
  return (
    <TableRow>
      <TableCell>
        {entry.isDir ? (
          <button
            type="button"
            className="inline-flex items-center gap-2 text-[var(--color-primary-light)] hover:underline disabled:no-underline disabled:opacity-60"
            disabled={!isValidEntryName(entry.name)}
            title={isValidEntryName(entry.name) ? undefined : UNHANDLED_NAME_MESSAGE}
            onClick={() => onOpenFolder(entry.name)}
          >
            <Folder className="size-4" aria-hidden="true" />
            {entry.name}
          </button>
        ) : (
          <span className="inline-flex items-center gap-2">
            <File className="size-4 text-[var(--color-muted-foreground)]" aria-hidden="true" />
            {entry.name}
          </span>
        )}
      </TableCell>
      <TableCell>{entry.isDir ? '—' : formatBytes(entry.size)}</TableCell>
      <TableCell>{formatModified(entry.modifiedMs)}</TableCell>
      <TableCell>
        <RowActions entry={entry} {...actions} />
      </TableCell>
    </TableRow>
  );
}

/** Sortable listing of one directory. */
export function FileTable({ entries, sort, onSort, ...rowProps }: FileTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHeader label="Name" column="name" sort={sort} onSort={onSort} />
          <SortHeader label="Size" column="size" sort={sort} onSort={onSort} />
          <SortHeader label="Modified" column="modifiedMs" sort={sort} onSort={onSort} />
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-center text-[var(--color-muted-foreground)]">
              This folder is empty.
            </TableCell>
          </TableRow>
        ) : (
          entries.map((entry) => <FileRow key={entry.name} entry={entry} {...rowProps} />)
        )}
      </TableBody>
    </Table>
  );
}
