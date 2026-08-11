import type { GameServerHealthCheck } from '@hyveon/shared';

/** Result of evaluating a health check's response: whether the server counts as active, and why. */
export interface HealthCheckVerdict {
  /** Whether the game server counts as active (not idle) based on this check. */
  active: boolean;
  /**
   * Human-readable reason for the verdict. Names the declared JSONPath and
   * operator, never the resolved response value or status body — response
   * bodies may carry player identities or network addresses.
   */
  reason: string;
}

type JsonPathSegment = string | number;

/**
 * Splits a JSONPath restricted to plain field access and numeric array
 * indices (e.g. `"players[0].online"`) into ordered segments. Any other
 * syntax (wildcards, filters, slices, recursive descent) simply fails to
 * tokenize into a usable path and resolves no value — there is no dedicated
 * syntax-error path, since an unresolvable path is already a fail-active
 * outcome.
 */
function tokenizePath(jsonPath: string): JsonPathSegment[] {
  const segments: JsonPathSegment[] = [];
  let i = 0;
  while (i < jsonPath.length) {
    if (jsonPath[i] === '.') {
      i++;
      continue;
    }
    if (jsonPath[i] === '[') {
      const end = jsonPath.indexOf(']', i);
      if (end === -1) {
        break;
      }
      segments.push(Number(jsonPath.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < jsonPath.length && jsonPath[j] !== '.' && jsonPath[j] !== '[') {
      j++;
    }
    segments.push(jsonPath.slice(i, j));
    i = j;
  }
  return segments;
}

type ResolvedValue = { found: false } | { found: true; value: unknown };

/** Resolves `jsonPath` against a parsed JSON response body. */
function resolvePath(body: unknown, jsonPath: string): ResolvedValue {
  let current: unknown = body;
  for (const segment of tokenizePath(jsonPath)) {
    if (current === null || typeof current !== 'object') {
      return { found: false };
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || Number.isNaN(segment)) {
        return { found: false };
      }
      current = current[segment];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

/** A JSON scalar: string, number, boolean, or null. */
type JsonScalar = string | number | boolean | null;

/** Resolving to an object or array is treated as no value at the declared path — only a scalar is a usable resolution. */
function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Coerces a scalar to a finite number, or `undefined` if it can't be compared numerically. */
function toComparableNumber(value: JsonScalar): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

type ComparisonOperator = Exclude<GameServerHealthCheck['activeWhen']['operator'], 'exists'>;

/** Applies every operator except `exists` (handled by the caller, which needs no comparison value) to a resolved scalar and the declared comparison value. */
function evaluateOperator(
  operator: ComparisonOperator,
  resolved: JsonScalar,
  expected: JsonScalar | undefined,
): boolean | 'incomparable' {
  switch (operator) {
    case 'equals':
    case 'notEquals': {
      if (expected === undefined) {
        return 'incomparable';
      }
      if (resolved !== null && expected !== null && typeof resolved !== typeof expected) {
        return 'incomparable';
      }
      const isEqual = resolved === expected;
      return operator === 'equals' ? isEqual : !isEqual;
    }
    case 'greaterThan':
    case 'lessThan': {
      if (expected === undefined) {
        return 'incomparable';
      }
      const resolvedNumber = toComparableNumber(resolved);
      const expectedNumber = toComparableNumber(expected);
      if (resolvedNumber === undefined || expectedNumber === undefined) {
        return 'incomparable';
      }
      return operator === 'greaterThan' ? resolvedNumber > expectedNumber : resolvedNumber < expectedNumber;
    }
    case 'contains': {
      if (typeof resolved !== 'string' || typeof expected !== 'string') {
        return 'incomparable';
      }
      return resolved.includes(expected);
    }
  }
}

/**
 * Pure evaluation of a health-check response against its declared condition
 * — no I/O, no AWS SDK. Every failure path (non-2xx status, unparseable
 * body, a declared path with no value, a value the operator can't compare)
 * returns `active: true`: a check that can't produce a conclusive verdict
 * must never be read as idle, matching the watchdog's own
 * fail-active behavior for a failed CloudWatch metric query.
 *
 * @param config - The game's declared health check.
 * @param status - The HTTP response status code.
 * @param rawBody - The raw HTTP response body, expected to be JSON.
 */
export function evaluateHealthCheck(config: GameServerHealthCheck, status: number, rawBody: string): HealthCheckVerdict {
  if (status < 200 || status >= 300) {
    return { active: true, reason: `health check failed: response status ${status} was not successful` };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { active: true, reason: 'health check failed: response body was not valid JSON' };
  }

  const { jsonPath, operator, value: expected } = config.activeWhen;
  const resolved = resolvePath(body, jsonPath);

  if (operator === 'exists') {
    return resolved.found
      ? { active: true, reason: `condition holds: a value exists at "${jsonPath}"` }
      : { active: false, reason: `condition does not hold: no value at "${jsonPath}"` };
  }

  if (!resolved.found) {
    return { active: true, reason: `health check failed: no value at declared path "${jsonPath}"` };
  }
  if (!isScalar(resolved.value)) {
    return { active: true, reason: `health check failed: value at declared path "${jsonPath}" is not a scalar` };
  }

  const holds = evaluateOperator(operator, resolved.value, expected ?? undefined);
  if (holds === 'incomparable') {
    return {
      active: true,
      reason: `health check failed: value at "${jsonPath}" could not be compared with operator "${operator}"`,
    };
  }

  return holds
    ? { active: true, reason: `condition holds: "${jsonPath}" satisfies operator "${operator}"` }
    : { active: false, reason: `condition does not hold: "${jsonPath}" does not satisfy operator "${operator}"` };
}
