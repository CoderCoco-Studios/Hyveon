import { describe, it, expect } from 'vitest';
import { planUpload, toRemotePath, validateDestination } from './paths.js';
import type { FolderScanNode } from './types.js';

/** Builds a file node. */
const file = (relPath: string, size: number): FolderScanNode => ({
  name: relPath.split('/').pop() as string,
  kind: 'file',
  size,
  relPath,
});

/** Builds a dir node whose size is the sum of its children. */
const dir = (relPath: string, children: FolderScanNode[]): FolderScanNode => ({
  name: relPath.split('/').pop() ?? '',
  kind: 'dir',
  size: children.reduce((n, c) => n + c.size, 0),
  relPath,
  children,
});

const TREE = dir('', [
  dir('Config', [file('Config/a.json', 10)]),
  dir('Data', [file('Data/b.db', 20), dir('Data/sub', [file('Data/sub/c.db', 30)])]),
  file('root.txt', 5),
]);

describe('planUpload', () => {
  it('should include a whole directory when it is listed', () => {
    expect(planUpload(TREE, ['Data'])).toEqual([
      { relPath: 'Data/b.db', size: 20 },
      { relPath: 'Data/sub/c.db', size: 30 },
    ]);
  });

  it('should exclude a directory and its contents when it is not listed', () => {
    const paths = planUpload(TREE, ['Config']).map((f) => f.relPath);
    expect(paths).toEqual(['Config/a.json']);
  });

  it('should include only individually listed files from an otherwise unselected directory', () => {
    expect(planUpload(TREE, ['Data/sub/c.db', 'root.txt'])).toEqual([
      { relPath: 'Data/sub/c.db', size: 30 },
      { relPath: 'root.txt', size: 5 },
    ]);
  });

  it('should return nothing for an empty selection', () => {
    expect(planUpload(TREE, [])).toEqual([]);
  });

  it('should never emit directories', () => {
    expect(planUpload(TREE, [''])).toHaveLength(4);
  });
});

describe('toRemotePath', () => {
  it('should strip the container path prefix from the destination', () => {
    expect(toRemotePath('/data/foundry', '/data', 'Config/a.json')).toBe('/foundry/Config/a.json');
  });

  it('should return a path relative to the owning volume for a second-volume destination', () => {
    expect(toRemotePath('/data/saves/worlds', '/data/saves', 'a.db')).toBe('/worlds/a.db');
  });

  it('should map to the volume root when destination equals the container path', () => {
    expect(toRemotePath('/data', '/data', 'a.json')).toBe('/a.json');
  });

  it('should tolerate trailing slashes', () => {
    expect(toRemotePath('/data/', '/data/', 'a.json')).toBe('/a.json');
  });

  it('should handle a root container path', () => {
    expect(toRemotePath('/x', '/', 'a')).toBe('/x/a');
  });

  it.each(['../evil', 'a/../../evil', '/abs/path', 'a//b', './a', 'a\\b', '', 'a\0b'])(
    'should reject relPath %j',
    (rel) => {
      expect(() => toRemotePath('/data', '/data', rel)).toThrow();
    },
  );

  it('should reject a destination outside the container path', () => {
    expect(() => toRemotePath('/other', '/data', 'a')).toThrow(/outside/);
  });

  it('should reject a sibling whose name merely shares the prefix', () => {
    expect(() => toRemotePath('/database', '/data', 'a')).toThrow(/outside/);
  });

  it('should reject a destination containing traversal', () => {
    expect(() => toRemotePath('/data/../etc', '/data', 'a')).toThrow();
  });

  it('should reject a relative destination', () => {
    expect(() => toRemotePath('data', '/data', 'a')).toThrow();
  });
});

describe('validateDestination', () => {
  const volumes = [
    { name: 'data', container_path: '/data' },
    { name: 'cfg', container_path: '/data/config' },
  ];

  it('should accept a path inside a volume and return the deepest matching volume', () => {
    expect(validateDestination('/data/config/x', volumes)).toEqual({ ok: true, volume: volumes[1] });
  });

  it('should accept the volume root itself', () => {
    expect(validateDestination('/data', volumes)).toEqual({ ok: true, volume: volumes[0] });
  });

  it('should reject a path outside every volume', () => {
    expect(validateDestination('/etc', volumes).ok).toBe(false);
  });

  it('should reject traversal and relative paths', () => {
    expect(validateDestination('/data/../etc', volumes).ok).toBe(false);
    expect(validateDestination('data', volumes).ok).toBe(false);
  });

  it('should reject a doubled slash with an error that names empty segments', () => {
    expect(validateDestination('/data//x', [{ name: 'data', container_path: '/data' }])).toEqual({
      ok: false,
      error: 'Destination must be an absolute path without "..", "." or empty segments.',
    });
  });

  it('should reject when the game has no volumes', () => {
    expect(validateDestination('/data', []).ok).toBe(false);
  });
});
