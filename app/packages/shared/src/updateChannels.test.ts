import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UPDATE_DOWNLOAD_CHUNK_CHANNEL, UPDATE_DOWNLOAD_END_CHANNEL } from './updateChannels.js';

const packagesDir = resolve(__dirname, '../..');

describe('update download channels', () => {
  // @spec APP-UPDATE-IPC-009
  it('should keep the wire names the renderer bridge and controller agree on', () => {
    expect(UPDATE_DOWNLOAD_CHUNK_CHANNEL).toBe('iac.settings.autoUpdate.download.chunk');
    expect(UPDATE_DOWNLOAD_END_CHANNEL).toBe('iac.settings.autoUpdate.download.end');
  });

  // @spec APP-UPDATE-IPC-009
  it.each([
    'desktop-main/src/controllers/iac-settings.controller.ts',
    'desktop-preload/src/preload.ts',
  ])('should not redeclare the channel literals in %s', (file) => {
    const source = readFileSync(resolve(packagesDir, file), 'utf8');

    expect(source).not.toMatch(/'iac\.settings\.autoUpdate\.download\.(chunk|end)'/);
  });
});
