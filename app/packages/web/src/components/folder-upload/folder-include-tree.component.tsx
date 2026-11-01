import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FolderScanNode } from '@hyveon/shared/folderUpload';
import { formatBytes } from '../../lib/format.utils.js';
import { nodeState, selectedFileSet, toggleNode, type TriState } from './folder-seed.utils.js';

/** Props for {@link FolderIncludeTree}. */
export interface FolderIncludeTreeProps {
  /** Scan root; its children are the top-level rows. */
  tree: FolderScanNode;
  /** Currently included `relPath`s (a directory includes its descendants). */
  include: string[];
  /** Called with the new `include` list whenever a checkbox is toggled. */
  onChange: (include: string[]) => void;
  /** Disables every checkbox, e.g. while an upload is running. */
  disabled?: boolean;
}

/** Props for {@link TriStateCheckbox}. */
interface TriStateCheckboxProps {
  state: TriState;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}

/** Native checkbox that shows the `mixed` state through `indeterminate` and `aria-checked`. */
function TriStateCheckbox({ state, label, disabled, onToggle }: TriStateCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      checked={state === 'checked'}
      disabled={disabled}
      onChange={onToggle}
      className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
    />
  );
}

/** Props for {@link TreeRow}. */
interface TreeRowProps {
  node: FolderScanNode;
  depth: number;
  tree: FolderScanNode;
  include: string[];
  selected: Set<string>;
  disabled?: boolean;
  onChange: (include: string[]) => void;
}

/** One file or directory row; directories expand lazily so a large scan renders only what is open. */
function TreeRow({ node, depth, tree, include, selected, disabled, onChange }: TreeRowProps) {
  const [open, setOpen] = useState(false);
  const isDir = node.kind === 'dir';
  const state = nodeState(node, selected);
  const selectable = !isDir || (node.children ?? []).length > 0;

  return (
    <li>
      <div className="flex items-center gap-2 py-0.5 text-sm" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        {isDir ? (
          <button
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            className="text-[var(--color-muted-foreground)]"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="inline-block w-4" />
        )}
        <TriStateCheckbox
          state={state}
          label={`Include ${node.relPath}`}
          disabled={disabled || !selectable}
          onToggle={() => onChange(toggleNode(tree, include, node))}
        />
        <span className="font-[var(--font-mono)] text-xs">{node.name}{isDir ? '/' : ''}</span>
        <span className="ml-auto text-xs text-[var(--color-muted-foreground)]">{formatBytes(node.size)}</span>
      </div>
      {isDir && open && (
        <ul>
          {(node.children ?? []).map((child) => (
            <TreeRow
              key={child.relPath}
              node={child}
              depth={depth + 1}
              tree={tree}
              include={include}
              selected={selected}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// @spec HELPER-SELECT-002
/**
 * Tri-state checkbox tree for choosing which entries of a scanned folder to upload.
 *
 * @remarks
 * A parent toggles all of its descendants; a parent with only some children included shows the mixed state. Sizes are
 * the scan's file sizes (directories show the sum of their descendants).
 *
 * @param props - See {@link FolderIncludeTreeProps}.
 */
export function FolderIncludeTree({ tree, include, onChange, disabled }: FolderIncludeTreeProps) {
  const selected = selectedFileSet(tree, include);
  return (
    <ul
      aria-label="Folder contents"
      className="max-h-72 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] p-2"
    >
      {(tree.children ?? []).map((child) => (
        <TreeRow
          key={child.relPath}
          node={child}
          depth={0}
          tree={tree}
          include={include}
          selected={selected}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </ul>
  );
}
