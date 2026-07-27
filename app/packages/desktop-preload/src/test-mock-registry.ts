/**
 * Test-only mock registry for `window.hyveon`.
 *
 * Provides typed `register`, `lookup`, and `clear` helpers that allow unit
 * tests running in jsdom to inject partial or full mock implementations of
 * any `HyveonApi` namespace without importing Electron or touching the real IPC
 * bridge.
 *
 * This module is intentionally **not** imported by the preload script or any
 * production renderer code — it is only consumed by test helpers and
 * `vi.mock` factory functions in the `@hyveon/web` test suite.
 */

import type { HyveonApi } from './hyveon-api.js';

// ---------------------------------------------------------------------------
// Namespace key union — derived from HyveonApi so it stays in sync automatically.
// ---------------------------------------------------------------------------

/**
 * Union of the namespace keys present on {@link HyveonApi} (excluding `__test`).
 * Used to constrain the `register` and `lookup` overloads to valid keys.
 */
export type HyveonNamespace = Exclude<keyof HyveonApi, '__test'>;

// ---------------------------------------------------------------------------
// Overloaded namespace → sub-interface mapping
// ---------------------------------------------------------------------------

/**
 * Maps each {@link HyveonNamespace} key to the sub-interface it holds on
 * {@link HyveonApi}.  Derived directly from `HyveonApi` via a mapped type so that
 * adding a new namespace to `HyveonApi` automatically propagates here — the
 * compiler will enforce value-type correctness in `register` / `lookup`
 * without any manual update to this alias.
 */
export type HyveonNamespaceMap = { [K in HyveonNamespace]: HyveonApi[K] };

/**
 * Like {@link HyveonNamespaceMap} but each namespace value is `Partial<…>` so
 * that test stubs only need to supply the methods the test actually exercises.
 */
export type HyveonPartialNamespaceMap = { [K in HyveonNamespace]: Partial<HyveonApi[K]> };

// ---------------------------------------------------------------------------
// Internal registry store
// ---------------------------------------------------------------------------

/** Mutable store keyed by namespace, each value being a partial stub of that namespace. */
const _registry: Partial<HyveonPartialNamespaceMap> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers a mock implementation for a single `window.hyveon` namespace.
 *
 * The mock replaces whatever was previously registered for that namespace (if
 * anything).  Partial implementations are accepted — only the methods the test
 * needs have to be provided.
 *
 * @example
 * ```ts
 * import { register } from '@hyveon/desktop-preload/test-mock-registry';
 * register('games', { list: vi.fn().mockResolvedValue({ games: ['minecraft'] }) });
 * ```
 */
export function register<K extends HyveonNamespace>(namespace: K, mock: Partial<HyveonNamespaceMap[K]>): void {
  (_registry as HyveonPartialNamespaceMap)[namespace] = mock;
}

/**
 * Looks up the mock registered for a namespace.
 *
 * Returns `undefined` if nothing has been registered for that namespace yet.
 * Tests that rely on a mock being present should call {@link register} first.
 */
export function lookup<K extends HyveonNamespace>(namespace: K): Partial<HyveonNamespaceMap[K]> | undefined {
  return (_registry as HyveonPartialNamespaceMap)[namespace];
}

/**
 * Removes all entries from the registry.
 *
 * Call this in an `afterEach` hook to prevent mock state from leaking between
 * tests.
 */
export function clear(): void {
  for (const key of Object.keys(_registry) as (keyof HyveonPartialNamespaceMap)[]) {
    delete _registry[key];
  }
}

/**
 * Builds a {@link HyveonApi}-shaped object from the current registry contents.
 *
 * Any namespace not yet registered is omitted (the property will be
 * `undefined`), which matches the optional-namespace pattern used by the
 * test harness.  The returned object is suitable for assignment to
 * `window.hyveon` in a `beforeEach` hook.
 *
 * This helper is intentionally **not** exported from the package root — import
 * it directly from the `test-mock-registry` export path.
 */
export function buildMockHyveon(): Partial<HyveonPartialNamespaceMap> {
  return { ..._registry };
}
