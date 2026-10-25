import { describe, it, expect } from 'vitest';
import type { FolderScanNode } from '@hyveon/shared/folderUpload';
import {
  compressInclude,
  nodeState,
  selectAll,
  selectedFileSet,
  summarizeSelection,
  toggleNode,
} from './folder-seed.utils.js';

/** Builds a file node. */
const file = (relPath: string, size: number): FolderScanNode => ({
  name: relPath.split('/').pop() ?? relPath,
  kind: 'file',
  size,
  relPath,
});

/** Builds a directory node whose size is the sum of its children. */
const dir = (relPath: string, children: FolderScanNode[]): FolderScanNode => ({
  name: relPath.split('/').pop() ?? relPath,
  kind: 'dir',
  size: children.reduce((sum, child) => sum + child.size, 0),
  relPath,
  children,
});

const config = dir('Config', [file('Config/a.json', 10), file('Config/b.json', 20)]);
const data = dir('Data', [file('Data/w.db', 100), dir('Data/sub', [file('Data/sub/x', 5)])]);
const empty = dir('Empty', []);
const TREE = dir('', [config, data, empty, file('root.txt', 1)]);

describe('folder-seed.utils', () => {
  it('should select every file by default as the top-level children', () => {
    expect(selectAll(TREE)).toEqual(['Config', 'Data', 'root.txt']);
  });

  it('should report checked, mixed and unchecked tri-states', () => {
    const selected = selectedFileSet(TREE, ['Config/a.json', 'Data']);
    expect(nodeState(config, selected)).toBe('mixed');
    expect(nodeState(data, selected)).toBe('checked');
    expect(nodeState(file('root.txt', 1), selected)).toBe('unchecked');
  });

  it('should treat a directory with no files as unchecked', () => {
    expect(nodeState(empty, selectedFileSet(TREE, selectAll(TREE)))).toBe('unchecked');
  });

  it('should clear all descendants when a checked parent is toggled', () => {
    expect(toggleNode(TREE, selectAll(TREE), data)).toEqual(['Config', 'root.txt']);
  });

  it('should select all descendants when a mixed parent is toggled', () => {
    expect(toggleNode(TREE, ['Config/a.json'], config)).toEqual(['Config']);
  });

  it('should leave siblings selected when one child is unchecked and expand the parent', () => {
    expect(toggleNode(TREE, selectAll(TREE), config.children![0]!)).toEqual(['Config/b.json', 'Data', 'root.txt']);
  });

  it('should recompress to the parent when the last missing child is re-checked', () => {
    const afterUncheck = toggleNode(TREE, selectAll(TREE), config.children![0]!);
    expect(toggleNode(TREE, afterUncheck, config.children![0]!)).toEqual(['Config', 'Data', 'root.txt']);
  });

  it('should summarize the effective selection', () => {
    expect(summarizeSelection(TREE, ['Config'])).toEqual({ files: 2, bytes: 30 });
    expect(summarizeSelection(TREE, [])).toEqual({ files: 0, bytes: 0 });
  });

  it('should compress an explicit file set', () => {
    expect(compressInclude(TREE, new Set(['Config/a.json', 'Config/b.json']))).toEqual(['Config']);
  });
});
