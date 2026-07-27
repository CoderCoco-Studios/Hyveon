/**
 * Side-effect import that pulls the `Window.hyveon` global augmentation declared
 * in `@hyveon/desktop-preload` into the web compilation unit.
 *
 * After this import TypeScript knows `window.hyveon` is of type `HyveonApi` (optional,
 * because the IPC bridge is absent in plain browser contexts).  Do not hand-declare
 * `interface Window { hyveon: ... }` here — the single source of truth lives in
 * the preload package's `src/index.ts`.
 */
import '@hyveon/desktop-preload';

export {};
