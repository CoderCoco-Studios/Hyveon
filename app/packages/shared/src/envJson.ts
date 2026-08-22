/**
 * Parses a JSON-shaped Lambda environment variable, falling back to
 * `fallback` (and logging a warning) when the value is absent or malformed.
 *
 * @remarks
 * A module-scope `JSON.parse(process.env[...])` throwing during Lambda init
 * is reported as `INIT_FAILURE` for every invocation — this keeps a
 * malformed operator-editable env var from taking down the whole function.
 * When `fallback` is a non-null object, a syntactically-valid but
 * wrong-shaped value (`"null"`, `"42"`, `"\"x\""`) also falls back, instead
 * of returning a non-object that would throw on property access downstream.
 *
 * @param envName - Name of the environment variable, used only in the warning message.
 * @param raw - The raw environment variable value (`process.env[envName]`).
 * @param fallback - Value returned when `raw` is absent, fails to parse, or fails the object-shape check.
 */
export function parseJsonEnv<T>(envName: string, raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    const expectObject = typeof fallback === 'object' && fallback !== null;
    if (expectObject && (parsed === null || typeof parsed !== 'object')) {
      throw new Error(`expected an object, got ${parsed === null ? 'null' : typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`Malformed ${envName} env var — falling back to default`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
