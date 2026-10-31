import { findSecretFields } from '@hyveon/shared/testing/secretFields';
import {
  test,
  expect,
  stubApis,
  seedVolumeFiles,
  readVolumeFilesResponses,
  STOPPED_GAME,
  RUNNING_GAME,
} from '../fixtures/index.js';
import type { VolumeFilesSeed } from '../fixtures/index.js';

/**
 * In-app file browser (`/games/:name/files`) against the chromium project's in-page `volumeFiles` fake. The fake has
 * no HTTP route, so each spec seeds the session and listings through `seedVolumeFiles`.
 */
const DATA_VOLUME = { name: 'data', containerPath: '/data', mounted: true };

const LISTINGS: NonNullable<VolumeFilesSeed['listings']> = {
  '/': [
    { name: 'world', isDir: true, size: 0, modifiedMs: 1_700_000_000_000 },
    { name: 'server.properties', isDir: false, size: 512, modifiedMs: 1_700_000_100_000 },
  ],
  '/world': [{ name: 'level.dat', isDir: false, size: 2048, modifiedMs: 1_700_000_200_000 }],
};

test.describe('volume files page', () => {
  test('should browse into a folder from the dashboard Files action', async ({ dashboard, volumeFiles }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await seedVolumeFiles(dashboard.page, { volumes: [DATA_VOLUME], listings: LISTINGS });
    await dashboard.goto();

    await dashboard.filesButton('minecraft').click();

    await expect(volumeFiles.sessionState('Running')).toBeVisible();
    await expect(volumeFiles.row('server.properties')).toBeVisible();
    await volumeFiles.openFolder('world');

    await expect(volumeFiles.breadcrumb()).toContainText('world');
    await expect(volumeFiles.row('level.dat')).toBeVisible();
    await expect(volumeFiles.row('server.properties')).toBeHidden();
    await expect(volumeFiles.readOnlyBanner()).toBeHidden();
    await expect(volumeFiles.newFolderButton()).toBeEnabled();
  });

  test('should show the read-only banner while the server runs', async ({ volumeFiles }) => {
    await stubApis(volumeFiles.page, { statuses: [RUNNING_GAME] });
    await seedVolumeFiles(volumeFiles.page, { state: 'running', volumes: [DATA_VOLUME], listings: LISTINGS });

    await volumeFiles.goto('minecraft');

    await expect(volumeFiles.readOnlyBanner()).toBeVisible();
    await expect(volumeFiles.row('server.properties')).toBeVisible();
    await expect(volumeFiles.newFolderButton()).toBeDisabled();
    await expect(volumeFiles.uploadFilesButton()).toBeDisabled();
  });

  test('should keep the bridge fixture responses free of secret fields', async ({ dashboard, volumeFiles }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await seedVolumeFiles(dashboard.page, { volumes: [DATA_VOLUME], listings: LISTINGS });
    await dashboard.goto();
    await dashboard.filesButton('minecraft').click();
    await volumeFiles.openFolder('world');
    await expect(volumeFiles.row('level.dat')).toBeVisible();

    const responses = await readVolumeFilesResponses(dashboard.page);

    // attach + start + two listings at minimum, so the assertion below cannot pass vacuously. This guards the
    // fixture's own shapes; the page-output test below is what proves the app adds nothing.
    expect(responses.length).toBeGreaterThanOrEqual(4);
    expect(findSecretFields(responses)).toEqual([]);
  });

  test('should render no credential, IP or URL and no link out to the helper', async ({ volumeFiles }) => {
    await stubApis(volumeFiles.page, { statuses: [STOPPED_GAME] });
    await seedVolumeFiles(volumeFiles.page, { state: 'running', volumes: [DATA_VOLUME], listings: LISTINGS });
    await volumeFiles.goto('minecraft');
    await expect(volumeFiles.row('server.properties')).toBeVisible();

    expect(findSecretFields(await volumeFiles.renderedStrings())).toEqual([]);
    await expect(volumeFiles.externalTargets()).toHaveCount(0);
  });
});
