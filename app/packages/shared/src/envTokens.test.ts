import { describe, it, expect } from 'vitest';
import {
  ALLOWED_HYVEON_ENV_TOKENS,
  HYVEON_ENV_TOKENS,
  findHyveonTokenCandidates,
  substituteHyveonToken,
  valueUsesToken,
} from './envTokens.js';

describe('findHyveonTokenCandidates', () => {
  it('should find a token embedded in a longer value', () => {
    expect(findHyveonTokenCandidates('host=${hyveon.network.public-ipv4}:8211')).toEqual([
      '${hyveon.network.public-ipv4}',
    ]);
  });

  it('should find multiple tokens including repeats', () => {
    expect(
      findHyveonTokenCandidates('${hyveon.network.public-address} ${hyveon.network.public-ipv4} ${hyveon.network.public-address}'),
    ).toHaveLength(3);
  });

  it('should find unknown hyveon-prefixed sequences so the validator can reject them', () => {
    expect(findHyveonTokenCandidates('${hyveon.network.public-adress}')).toEqual(['${hyveon.network.public-adress}']);
  });

  it('should ignore non-hyveon placeholder syntax', () => {
    expect(findHyveonTokenCandidates('${JAVA_OPTS} -Dmotd={"name":"srv"}')).toEqual([]);
  });
});

describe('valueUsesToken', () => {
  it('should report whether a value contains the given token', () => {
    expect(valueUsesToken('ip=${hyveon.network.public-ipv4}', HYVEON_ENV_TOKENS.publicIpv4)).toBe(true);
    expect(valueUsesToken('ip=${hyveon.network.public-ipv4}', HYVEON_ENV_TOKENS.publicAddress)).toBe(false);
  });
});

describe('substituteHyveonToken', () => {
  it('should replace every occurrence and leave surrounding text untouched', () => {
    expect(
      substituteHyveonToken('a=${hyveon.network.public-address},b=${hyveon.network.public-address}', HYVEON_ENV_TOKENS.publicAddress, 'palworld.example.com'),
    ).toBe('a=palworld.example.com,b=palworld.example.com');
  });

  it('should leave non-hyveon placeholders byte-for-byte untouched', () => {
    expect(substituteHyveonToken('${JAVA_OPTS} ${hyveon.network.public-address}', HYVEON_ENV_TOKENS.publicAddress, 'x.example.com')).toBe('${JAVA_OPTS} x.example.com');
  });
});

describe('ALLOWED_HYVEON_ENV_TOKENS', () => {
  it('should contain exactly the two v1 tokens', () => {
    expect([...ALLOWED_HYVEON_ENV_TOKENS].sort()).toEqual([
      '${hyveon.network.public-address}',
      '${hyveon.network.public-ipv4}',
    ]);
  });
});
