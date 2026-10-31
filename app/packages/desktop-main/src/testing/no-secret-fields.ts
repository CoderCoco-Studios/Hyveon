import { expect } from 'vitest';
import { findSecretFields } from '@hyveon/shared/testing/secretFields';

// @spec APP-IPC-SEC-003
/**
 * Fails the test when any key or string value in `value` looks like a credential, token, certificate, fingerprint,
 * IP address or URL; used to prove IPC results stay free of helper connection details.
 *
 * @param value - A result, status or payload returned across IPC.
 */
export function expectNoSecretFields(value: unknown): void {
  expect(findSecretFields(value)).toEqual([]);
}
