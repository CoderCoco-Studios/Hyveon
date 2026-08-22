/**
 * Parses a JSON-shaped Lambda environment variable, falling back to
 * `fallback` (and logging a warning) when the value is absent or malformed.
 *
 * @remarks
 * A module-scope `JSON.parse(process.env[...])` throwing during Lambda init
 * is reported as `INIT_FAILURE` for every invocation — this keeps a
 * malformed operator-editable env var from taking down the whole function.
 *
 * @param envName - Name of the environment variable, used only in the warning message.
 * @param raw - The raw environment variable value (`process.env[envName]`).
 * @param fallback - Value returned when `raw` is absent or fails to parse.
 */
export function parseJsonEnv<T>(envName: string, raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`Malformed ${envName} env var — falling back to default`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
