/**
 * Side-effect import that pulls the `@testing-library/jest-dom` matcher
 * declarations (`toBeInTheDocument`, `toHaveTextContent`, `toBeDisabled`, …)
 * into this package's compilation unit.
 *
 * At runtime the matchers are registered by `app/vitest.setup.ts`, which is
 * outside this package's `include` and therefore invisible to `tsc`. Without
 * this file every `expect(...).toBeInTheDocument()` in a co-located `*.test.tsx`
 * fails typechecking with "Property 'toBeInTheDocument' does not exist on type
 * 'Assertion<HTMLElement>'", even though the assertion works when the suite runs.
 *
 * Kept as a `.d.ts` so it contributes types only and is never emitted or
 * bundled into the renderer.
 */
import '@testing-library/jest-dom/vitest';

export {};
