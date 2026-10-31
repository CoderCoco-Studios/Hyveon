import { findSecretFields } from '@hyveon/shared/testing/secretFields';
import type { ElectronApplication, Page } from '../fixtures/index.js';
import { test, expect, launchElectron, applyHyveonMocks, STOPPED_GAME } from '../fixtures/index.js';
import { VolumeFilesPage } from '../pages/index.js';

/**
 * Smoke spec for the in-app file browser inside the real Electron shell.
 *
 * The `volumeFiles.*` channels are mocked through `window.hyveon.__test.mock()`, so the page never reaches AWS or a
 * helper task. Each mock handler appends the channel it served to `window.__e2eVolumeCalls` and its return value to
 * `window.__e2eVolumeResponses`, which the spec reads back from the renderer.
 */
test.describe('volume files page (electron)', () => {
  let app: ElectronApplication | undefined;
  let win: Page;
  let volumeFiles: VolumeFilesPage;

  test.beforeAll(async () => {
    ({ app, win } = await launchElectron());
    volumeFiles = new VolumeFilesPage(win);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test.afterEach(async () => {
    await win.evaluate(() => window.hyveon?.__test?.clearMocks());
  });

  test('should render the files route and call volumeFiles.session.start on Start', async () => {
    await applyHyveonMocks(win, { statuses: [STOPPED_GAME] });
    await win.evaluate(() => {
      const hyveon = window.hyveon;
      if (!hyveon?.__test) throw new Error('window.hyveon.__test unavailable — is HYVEON_TEST_MODE set?');
      const calls: string[] = [];
      const responses: unknown[] = [];
      window.__e2eVolumeCalls = calls;
      window.__e2eVolumeResponses = responses;
      let running = false;
      const status = (game: string) => ({
        game,
        state: running ? 'running' : 'stopped',
        browseHeld: running,
        uploadHolders: 0,
        supportsArchive: false,
        volumes: [{ name: 'data', containerPath: '/data', mounted: true }],
        ...(running ? { startedAt: new Date().toISOString(), autoStopAt: new Date(Date.now() + 30 * 60_000).toISOString() } : {}),
      });
      const serve = (channel: string, produce: (game: string) => unknown) => {
        hyveon.__test!.mock(channel, (...args: unknown[]) => {
          calls.push(channel);
          const value = produce(typeof args[0] === 'string' ? args[0] : '');
          responses.push(value);
          return Promise.resolve(value);
        });
      };
      serve('volumeFiles.session.status', status);
      serve('volumeFiles.session.attach', status);
      serve('volumeFiles.session.detach', status);
      serve('volumeFiles.session.start', (game) => {
        running = true;
        return status(game);
      });
      serve('volumeFiles.list', () => ({
        ok: true,
        value: { path: '/', entries: [{ name: 'world', isDir: true, size: 0, modifiedMs: 1_700_000_000_000 }] },
      }));
    });

    await volumeFiles.gotoElectron('minecraft');
    await expect(volumeFiles.sessionState('Stopped')).toBeVisible();

    await volumeFiles.startButton().click();

    await expect(volumeFiles.sessionState('Running')).toBeVisible();
    await expect(volumeFiles.row('world')).toBeVisible();
    const calls = await win.evaluate(() => window.__e2eVolumeCalls ?? []);
    expect(calls).toContain('volumeFiles.session.attach');
    expect(calls).toContain('volumeFiles.session.start');

    const responses = await win.evaluate(() => window.__e2eVolumeResponses ?? []);
    expect(responses.length).toBeGreaterThan(0);
    expect(findSecretFields(responses)).toEqual([]);

    // What the app itself rendered from those responses, not just what the mocks returned.
    expect(findSecretFields(await volumeFiles.renderedStrings())).toEqual([]);
    await expect(volumeFiles.externalTargets()).toHaveCount(0);
  });
});
