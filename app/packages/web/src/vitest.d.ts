/**
 * Ambient augmentation for `@testing-library/jest-dom`'s Vitest matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, etc.).
 *
 * `../../vitest.setup.ts` (loaded via `test.setupFiles`) registers these
 * matchers at runtime with the same side-effect import, but that file lives
 * outside this package and isn't part of its TypeScript program. Without
 * this file, `tsc` has no visibility into the `vitest` module augmentation
 * that `@testing-library/jest-dom/vitest` declares, and every `expect(...)`
 * call in a `*.test.tsx` file that uses a jest-dom matcher fails to
 * type-check (TS2339) even though the matcher works fine at runtime.
 */
import '@testing-library/jest-dom/vitest';
