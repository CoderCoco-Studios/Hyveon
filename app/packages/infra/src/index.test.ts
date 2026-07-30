import { describe, expect, it } from 'vitest';
import * as infra from './index.js';

describe('@hyveon/infra public entry point', () => {
  it('should export createInfraProgram as a function', () => {
    expect(typeof infra.createInfraProgram).toBe('function');
  });

  it('should export the network and security-group module APIs', () => {
    expect(typeof infra.defineNetwork).toBe('function');
    expect(typeof infra.cidrSubnet).toBe('function');
    expect(typeof infra.defineSecurityGroups).toBe('function');
    expect(typeof infra.dedupedDirectGamePorts).toBe('function');
    expect(typeof infra.hasHttpsGame).toBe('function');
  });

  it('should export defineDiscordDomain as a function', () => {
    expect(typeof infra.defineDiscordDomain).toBe('function');
  });
});
