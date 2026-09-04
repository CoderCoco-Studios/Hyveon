/** Shown wherever `window.hyveon` is accessed outside Electron, where the IPC bridge does not exist. */
export const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

/** Shorter wording of {@link BRIDGE_UNAVAILABLE} used by `settings.page.tsx`'s IPC-rejection paths; kept distinct rather than reworded to avoid an unreviewed user-facing string change. */
export const SETTINGS_BRIDGE_UNAVAILABLE = 'hyveon IPC bridge unavailable';
