import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 *
 * @remarks
 * Reports `true` when `window.matchMedia` is unavailable (jsdom, non-browser contexts), so callers fall back to the
 * widest layout.
 *
 * @param query - A media query string, e.g. `(min-width: 768px)`.
 * @returns `true` while the query matches.
 */
export function useMediaQuery(query: string): boolean {
  // A new `subscribe` identity makes React unsubscribe and resubscribe, so keep it stable per query.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true),
  );
}
