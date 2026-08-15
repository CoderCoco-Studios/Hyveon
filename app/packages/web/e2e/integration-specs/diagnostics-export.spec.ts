import { mkdtempSync, existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { DiagnosticsController } from '@hyveon/desktop-main/dist/controllers/diagnostics.controller.js';
import { test, expect } from './index.js';

/** Reads every entry name out of the `.zip` at `path`, draining each entry's content without buffering it. */
async function listZipEntryNames(path: string): Promise<string[]> {
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .pipe(unzipper.Parse())
      .on('entry', (entry: unzipper.Entry) => {
        names.push(entry.path);
        entry.autodrain();
      })
      .on('close', resolve)
      .on('error', reject);
  });
  return names;
}

/**
 * `DiagnosticsController.showSaveDialog` lazily `require('electron')`s at
 * call-time — unavailable in this in-process harness (no real Electron
 * process). Every spec below resolves the real container-built
 * `DiagnosticsController` instance and monkey-patches this one protected
 * seam directly on the instance, exactly as a native save dialog's
 * resolved/cancelled result would arrive, so `exportBundle`'s own logic
 * (past the dialog) runs unmodified through the real DI-wired
 * `DiagnosticsBundleService`.
 */
function stubSaveDialog(controller: DiagnosticsController, result: string | undefined): void {
  (controller as unknown as { showSaveDialog: () => Promise<string | undefined> }).showSaveDialog = () =>
    Promise.resolve(result);
}

test('should write a real .zip to disk with the expected entries when the operator picks a save location', async ({ ipc }) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const controller = ipc.get(DiagnosticsController);
  stubSaveDialog(controller, destinationPath);

  // `HYVEON_CONFIG_BUCKET` is `ConfigService.getConfigurationBucket`'s
  // documented dev/CI override — without it, this harness has no
  // configured configuration bucket (the same state every other
  // integration spec runs in unless it opts in), so
  // `DeploymentConfigService` would fail and the config-summary section
  // would land in `errors.json` instead of the archive. Setting it here
  // exercises the full-success path; restored in `finally` since specs in
  // this file share a worker process.
  const previousConfigBucket = process.env['HYVEON_CONFIG_BUCKET'];
  process.env['HYVEON_CONFIG_BUCKET'] = 'diagnostics-export-test-bucket';
  try {
    const result = await ipc.dispatch(DiagnosticsController, 'exportBundle');

    expect(result).toEqual({ status: 'written', path: destinationPath });
    expect(existsSync(destinationPath)).toBe(true);

    const entryNames = await listZipEntryNames(destinationPath);
    expect(entryNames).toEqual(
      expect.arrayContaining(['logs.txt', 'config-summary.json', 'metadata.json', 'aws-snapshot.json', 'errors.json']),
    );
  } finally {
    if (previousConfigBucket === undefined) {
      delete process.env['HYVEON_CONFIG_BUCKET'];
    } else {
      process.env['HYVEON_CONFIG_BUCKET'] = previousConfigBucket;
    }
  }
});

test('should still write a bundle with the other sections when the config-summary section fails (no configuration bucket configured)', async ({
  ipc,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const controller = ipc.get(DiagnosticsController);
  stubSaveDialog(controller, destinationPath);

  const result = await ipc.dispatch(DiagnosticsController, 'exportBundle');

  expect(result).toEqual({ status: 'written', path: destinationPath });
  const entryNames = await listZipEntryNames(destinationPath);
  expect(entryNames).toEqual(expect.arrayContaining(['logs.txt', 'metadata.json', 'aws-snapshot.json', 'errors.json']));
  expect(entryNames).not.toContain('config-summary.json');
});

test('should return a cancelled result and write no file when the operator cancels the save dialog', async ({ ipc }) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const controller = ipc.get(DiagnosticsController);
  stubSaveDialog(controller, undefined);

  const result = await ipc.dispatch(DiagnosticsController, 'exportBundle');

  expect(result).toEqual({ status: 'cancelled' });
  expect(existsSync(destinationPath)).toBe(false);
});
