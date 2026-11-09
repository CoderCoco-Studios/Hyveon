import { describe, it, expect } from 'vitest';
import { REVEAL_TARGETS, isRevealTarget } from './shellReveal.js';

describe('isRevealTarget', () => {
  // @spec APP-SHELL-REVEAL-002
  it.each(REVEAL_TARGETS)('should accept the known target %s', (target) => {
    expect(isRevealTarget(target)).toBe(true);
  });

  // @spec APP-SHELL-REVEAL-002
  it.each(['/etc/passwd', 'Guided-Iam-Template', '', 1, null, undefined, {}, ['diagnostics-bundle']])(
    'should reject %j',
    (value) => {
      expect(isRevealTarget(value)).toBe(false);
    },
  );
});
