import type { CSSProperties } from 'react';

/**
 * Style for Electron's custom-title-bar drag regions — `-webkit-app-region`
 * only means anything inside a `window.hyveon.window` (Electron) context, so
 * this returns `undefined` in the browser/e2e-chromium case where the
 * property would otherwise be inert but still show up in snapshots/DOM
 * assertions.
 *
 * @param mode - `'drag'` marks the element as part of the window's drag
 *   handle; `'no-drag'` excludes an interactive child from an ancestor's
 *   drag region.
 * @returns The style object to spread onto the element, or `undefined` when
 *   `window.hyveon.window` isn't present.
 */
export function useAppRegionStyle(mode: 'drag' | 'no-drag'): CSSProperties | undefined {
  return window.hyveon?.window ? ({ WebkitAppRegion: mode } as CSSProperties) : undefined;
}
