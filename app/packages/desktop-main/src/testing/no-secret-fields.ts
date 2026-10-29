import { expect } from 'vitest';

/** Keys and string values that would mean a credential, certificate pin, host address or URL reached a result. */
const SECRET_PATTERN = /password|credential|token|fingerprint|cert|https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b/i;

/** Appends every key and string value under `value` that matches {@link SECRET_PATTERN}, with its path. */
function collectOffenders(value: unknown, at: string, offenders: string[]): void {
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) offenders.push(`${at} = ${JSON.stringify(value)}`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_PATTERN.test(key)) offenders.push(`${at}.${key} (key)`);
    collectOffenders(child, `${at}.${key}`, offenders);
  }
}

/**
 * Fails the test when any key or string value in `value` looks like a credential, token, certificate, fingerprint,
 * IP address or URL; used to prove IPC results stay free of helper connection details.
 *
 * @param value - A result, status or payload returned across IPC.
 */
export function expectNoSecretFields(value: unknown): void {
  const offenders: string[] = [];
  collectOffenders(value, 'result', offenders);
  expect(offenders).toEqual([]);
}
