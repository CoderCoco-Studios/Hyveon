import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isIPv4InCidr, isPrivateIPv4 } from './privateIpv4.js';

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

// @spec RT-HEALTH-HTTP-012
describe('isIPv4InCidr', () => {
  it.each<[string, string, boolean]>([
    ['10.0.1.23', '10.0.0.0/16', true],
    ['10.0.0.0', '10.0.0.0/16', true],
    ['10.0.255.255', '10.0.0.0/16', true],
    ['10.1.0.0', '10.0.0.0/16', false],
    ['10.0.1.23', '10.0.0.0/8', true],
    ['11.0.0.1', '10.0.0.0/8', false],
    ['172.16.5.5', '172.16.0.0/12', true],
    ['172.32.0.1', '172.16.0.0/12', false],
    ['192.168.1.1', '192.168.0.0/16', true],
    ['10.0.1.23', '10.0.1.23/32', true],
    ['10.0.1.24', '10.0.1.23/32', false],
    ['8.8.8.8', '0.0.0.0/0', true],
    ['10.0.0.1', '10.0.0.77/24', true],
    ['10.0.1.1', '10.0.0.77/24', false],
  ])('should classify %s within %s as %s', (ip, cidr, expected) => {
    expect(isIPv4InCidr(ip, cidr)).toBe(expected);
  });

  it.each(['', '10.0.0.0', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/08', '10.0.0.0/1.5', '10.0.0/16', 'x/16', '::1/64', '10.0.0.0/16/1', ' 10.0.0.0/16'])(
    'should reject the malformed CIDR %j',
    (cidr) => {
      expect(isIPv4InCidr('10.0.0.1', cidr)).toBe(false);
    },
  );

  it.each(['', '10.0.0', '10.0.0.256', ' 10.0.0.1', '10.0.0.1 ', '::1'])('should reject the malformed address %j', (ip) => {
    expect(isIPv4InCidr(ip, '0.0.0.0/0')).toBe(false);
  });
});
