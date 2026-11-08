/**
 * Update-download IPC side-channel names. Dependency-free and deep-imported via `@hyveon/shared/updateChannels` so
 * the sandboxed preload and desktop-main share one declaration; not in the barrel.
 */

// @spec APP-UPDATE-IPC-009
/** Side-channel the update download pushes progress samples on. */
export const UPDATE_DOWNLOAD_CHUNK_CHANNEL = 'iac.settings.autoUpdate.download.chunk';

// @spec APP-UPDATE-IPC-009
/** Side-channel the update download sends its terminal message on. */
export const UPDATE_DOWNLOAD_END_CHANNEL = 'iac.settings.autoUpdate.download.end';
