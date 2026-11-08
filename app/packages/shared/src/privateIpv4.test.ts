import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPrivateIPv4 } from './privateIpv4.js';

const CASES: ReadonlyArray<[string, boolean]> = [
  ['127.0.0.1', false],
  ['0.0.0.0', false],
  ['169.254.169.254', false],
  ['224.0.0.1', false],
  ['255.255.255.255', false],
  ['10.0.0.1', true],
  ['10.255.255.255', true],
  ['172.15.255.255', false],
  ['172.16.0.1', true],
  ['172.31.255.255', true],
  ['172.32.0.1', false],
  ['192.168.1.1', true],
  ['192.169.1.1', false],
  ['01.2.3.4', false],
  ['10.0.0.01', false],
  ['010.0.0.1', false],
  ['1.2.3', false],
  ['1.2.3.4.5', false],
  ['256.0.0.1', false],
  ['10.0.0.256', false],
  [' 10.0.0.1', false],
  ['10.0.0.1 ', false],
  ['0x7f.0.0.1', false],
  ['0xa.0.0.1', false],
  ['167772161', false],
  ['10.1', false],
  ['10..0.1', false],
  ['10.0.0.', false],
  ['+10.0.0.1', false],
  ['10.0.0.-1', false],
  ['10.0.0.1\n', false],
  ['', false],
];

describe('isPrivateIPv4', () => {
  it.each(CASES)('should classify %j as private=%s', (value, expected) => {
    expect(isPrivateIPv4(value)).toBe(expected);
  });

  it('should never classify a value net.isIPv4 rejects as private', () => {
    for (const [value] of CASES) {
      if (!isIPv4(value)) {
        expect(isPrivateIPv4(value)).toBe(false);
      }
    }
  });

  it('should have no imports so the renderer bundle can include it', () => {
    const source = readFileSync(fileURLToPath(new URL('./privateIpv4.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/from\s+['"](node:|net['"])/);
  });
});
