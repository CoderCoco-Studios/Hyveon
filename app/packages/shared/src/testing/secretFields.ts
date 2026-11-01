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

// @spec APP-IPC-SEC-003
/**
 * Lists every key and string value in `value` that looks like a credential, token, certificate, fingerprint, IP
 * address or URL.
 *
 * @remarks
 * Test-support code with no test-runner dependency, shared by the vitest helper in `desktop-main` and the Playwright
 * fixtures so both prove the same boundary with the same pattern. Deep-import it as
 * `@hyveon/shared/testing/secretFields`; it is deliberately absent from the package barrel.
 *
 * @param value - A result, status or payload returned across IPC.
 * @returns One description per offending key or value; empty when the payload is clean.
 */
export function findSecretFields(value: unknown): string[] {
  const offenders: string[] = [];
  collectOffenders(value, 'result', offenders);
  return offenders;
}
