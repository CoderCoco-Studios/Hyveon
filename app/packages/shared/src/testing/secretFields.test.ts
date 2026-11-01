import { describe, expect, it } from 'vitest';
import { findSecretFields } from './secretFields.js';

// @spec APP-IPC-SEC-003
describe('findSecretFields', () => {
  it('should return nothing for a payload of plain names and numbers', () => {
    expect(findSecretFields({ game: 'mc', state: 'running', uploadHolders: 0, volumes: [{ name: 'data', mounted: true }] })).toEqual([]);
  });

  it('should report a key that names a credential, with its path', () => {
    expect(findSecretFields({ status: { helperPassword: 'x' } })).toEqual(['result.status.helperPassword (key)']);
  });

  it('should report string values that are URLs or IPv4 addresses', () => {
    const offenders = findSecretFields([{ endpoint: 'https://10.0.0.1:8080' }, { host: '203.0.113.7' }]);
    expect(offenders).toEqual(['result.0.endpoint = "https://10.0.0.1:8080"', 'result.1.host = "203.0.113.7"']);
  });

  it('should report a certificate fingerprint value nested in an array', () => {
    expect(findSecretFields({ pins: ['sha256 fingerprint'] })).toEqual(['result.pins.0 = "sha256 fingerprint"']);
  });
});
