import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveLogDir } from './logDir.js';

describe('resolveLogDir', () => {
  // @spec APP-DIAG-LOG-008
  it('places logs in a logs subdirectory of the userData path', () => {
    expect(resolveLogDir('/fake/userData')).toBe(path.join('/fake/userData', 'logs'));
  });
});
