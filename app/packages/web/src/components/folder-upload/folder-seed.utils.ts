import { planUpload, type FolderScanNode } from '@hyveon/shared/folderUpload';

/** Selection state of a tree node: every, some, or none of its descendant files are included. */
export type TriState = 'checked' | 'unchecked' | 'mixed';

/** Collects every descendant file of `node` (or `node` itself when it is a file). */
export function filesUnder(node: FolderScanNode): FolderScanNode[] {
  if (node.kind === 'file') return [node];
  return (node.children ?? []).flatMap(filesUnder);
}

/** Returns the set of file `relPath`s that `include` selects (a selected directory includes its descendants). */
export function selectedFileSet(tree: FolderScanNode, include: string[]): Set<string> {
  return new Set(planUpload(tree, include).map((file) => file.relPath));
}

/** Computes the tri-state of `node` against the effective selected file set. A directory with no files is `unchecked`. */
export function nodeState(node: FolderScanNode, selected: Set<string>): TriState {
  const files = filesUnder(node);
  if (files.length === 0) return 'unchecked';
  const on = files.filter((file) => selected.has(file.relPath)).length;
  if (on === 0) return 'unchecked';
  return on === files.length ? 'checked' : 'mixed';
}

/**
 * Re-expresses a selected file set as the shortest `include` list: a directory whose files are all selected is listed
 * once instead of file by file. The scan root is never listed itself, so a full selection is its top-level children.
 */
export function compressInclude(tree: FolderScanNode, selected: Set<string>): string[] {
  const out: string[] = [];
  const walk = (node: FolderScanNode, isRoot: boolean): void => {
    if (node.kind === 'file') {
      if (selected.has(node.relPath)) out.push(node.relPath);
      return;
    }
    if (!isRoot && nodeState(node, selected) === 'checked') {
      out.push(node.relPath);
      return;
    }
    for (const child of node.children ?? []) walk(child, false);
  };
  walk(tree, true);
  return out;
}

// @spec HELPER-SELECT-002
/** The `include` list selecting everything in the scan (the default after picking a folder). */
export function selectAll(tree: FolderScanNode): string[] {
  return compressInclude(tree, new Set(filesUnder(tree).map((file) => file.relPath)));
}

// @spec HELPER-SELECT-003
/**
 * Toggles `node` (and so all of its descendants): a `checked` node is cleared; `unchecked` and `mixed` nodes become
 * fully selected.
 */
export function toggleNode(tree: FolderScanNode, include: string[], node: FolderScanNode): string[] {
  const selected = selectedFileSet(tree, include);
  const turnOn = nodeState(node, selected) !== 'checked';
  for (const file of filesUnder(node)) {
    if (turnOn) selected.add(file.relPath);
    else selected.delete(file.relPath);
  }
  return compressInclude(tree, selected);
}

/** File count and byte total of the effective selection. */
export function summarizeSelection(tree: FolderScanNode, include: string[]): { files: number; bytes: number } {
  const plan = planUpload(tree, include);
  return { files: plan.length, bytes: plan.reduce((sum, file) => sum + file.size, 0) };
}
