import { useEffect, useRef, useState } from 'react';

/**
 * Tracks a transient "copied" flag that automatically resets to `false` after
 * `resetMs`, clearing its pending timer on unmount (and before re-arming on a
 * rapid second copy) so a stray reset never fires against an unmounted
 * component. The caller owns the actual copy side effect (clipboard write,
 * success/failure handling) and calls the returned setter once it succeeds.
 *
 * @param resetMs - how long the flag stays `true` before resetting; defaults to 1500ms.
 * @returns a `[copied, markCopied]` pair — `markCopied()` sets `copied` to `true` and (re)starts the reset timer.
 */
export function useCopiedReset(resetMs = 1500): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  function markCopied() {
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
  }

  return [copied, markCopied];
}
