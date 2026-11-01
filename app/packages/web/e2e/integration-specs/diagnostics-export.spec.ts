import { mkdtempSync, existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { DiagnosticsController } from '@hyveon/desktop-main/dist/controllers/diagnostics.controller.js';
import { NativeDialogService } from '@hyveon/desktop-main/dist/services/NativeDialogService.js';
import { test, expect } from './index.js';

/** Reads every entry name out of the `.zip` at `path`, draining each entry's content without buffering it. */
async function listZipEntryNames(path: string): Promise<string[]> {
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('error', reject)
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
 * `NativeDialogService.pickSavePath` needs a real Electron process, which this in-process harness does not have.
 * Every spec below resolves the container-built `NativeDialogService` and replaces `pickSavePath` on the instance,
 * exactly as a native save dialog's chosen/cancelled result would arrive, so `exportBundle`'s own logic (past the
 * dialog) runs unmodified through the real DI-wired `DiagnosticsBundleService`.
 */
function stubSaveDialog(dialogs: NativeDialogService, result: string | null): void {
  dialogs.pickSavePath = () => Promise.resolve(result);
}

// @spec APP-DIAG-BNDL-004
test('should write a real .zip to disk with the expected entries when the operator picks a save location', async ({ ipc }) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const dialogs = ipc.get(NativeDialogService);
  stubSaveDialog(dialogs, destinationPath);

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

// @spec APP-DIAG-BNDL-005
test('should still write a bundle with the other sections when the config-summary section fails (no configuration bucket configured)', async ({
  ipc,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const dialogs = ipc.get(NativeDialogService);
  stubSaveDialog(dialogs, destinationPath);

  const result = await ipc.dispatch(DiagnosticsController, 'exportBundle');

  expect(result).toEqual({ status: 'written', path: destinationPath });
  const entryNames = await listZipEntryNames(destinationPath);
  expect(entryNames).toEqual(expect.arrayContaining(['logs.txt', 'metadata.json', 'aws-snapshot.json', 'errors.json']));
  expect(entryNames).not.toContain('config-summary.json');
});

// @spec APP-DIAG-BNDL-002
test('should return a cancelled result and write no file when the operator cancels the save dialog', async ({ ipc }) => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-export-'));
  const destinationPath = join(dir, 'bundle.zip');
  const dialogs = ipc.get(NativeDialogService);
  stubSaveDialog(dialogs, null);

  const result = await ipc.dispatch(DiagnosticsController, 'exportBundle');

  expect(result).toEqual({ status: 'cancelled' });
  expect(existsSync(destinationPath)).toBe(false);
});
