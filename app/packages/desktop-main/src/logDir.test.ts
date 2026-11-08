import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveLogDir } from './logDir.js';

describe('resolveLogDir', () => {
  // @spec APP-DIAG-LOG-008
  it('places logs in a logs subdirectory of the userData path', () => {
    expect(resolveLogDir('/fake/userData')).toBe(path.join('/fake/userData', 'logs'));
  });

  // @spec APP-DIAG-LOG-008
  it.each(['main.ts', 'app.module.ts'])('should be called by %s so the write and read paths share one helper', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf-8');

    expect(source).toMatch(/\bresolveLogDir\(/);
  });
});
