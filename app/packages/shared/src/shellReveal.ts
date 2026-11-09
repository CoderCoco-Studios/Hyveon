/**
 * App-owned files the renderer may ask the main process to reveal in the OS file manager.
 * The renderer names one of these; it never supplies a path.
 */
export const REVEAL_TARGETS = ['guided-iam-template', 'diagnostics-bundle'] as const;

/** One of {@link REVEAL_TARGETS}. */
export type RevealTarget = (typeof REVEAL_TARGETS)[number];

/**
 * Narrows untrusted input (an IPC payload field) to a {@link RevealTarget}.
 *
 * @param value - Any value received across the IPC boundary.
 * @returns `true` only when `value` is exactly one of {@link REVEAL_TARGETS}.
 */
export function isRevealTarget(value: unknown): value is RevealTarget {
  return typeof value === 'string' && (REVEAL_TARGETS as readonly string[]).includes(value);
}
