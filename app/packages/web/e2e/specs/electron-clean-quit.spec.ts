import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '../fixtures/index.js';
import { launchElectron } from '../fixtures/electron-launch.js';
import { repoRoot } from '../../playwright.config.js';

/**
 * Clean-quit regression guard for the Electron main process.
 *
 * `@cdktf/hcl2json`'s Go `wasm_exec` glue and `@pulumi/pulumi`'s
 * `@grpc/grpc-js` transport both run module-scope side effects that can keep
 * the Electron event loop alive after `app.quit()`. Both packages are marked
 * `external` in `electron.vite.config.ts` and shipped unpacked to avoid that;
 * this spec is the permanent check that `app.close()` still resolves
 * promptly.
 *
 * **What this spec can and cannot cover.** It deliberately never runs a real
 * `preview`/`up`: that needs a ~100 MB engine download plus provider plugins,
 * which CI has no business fetching. A packaged `--dir` build running one
 * `preview` and one `up` against a `file://` backend quits cleanly with zero
 * surviving `pulumi` processes, but that case isn't exercised here. What runs
 * on every CI push is the half that regresses silently: quitting while idle,
 * and quitting after the whole `@pulumi/pulumi` module graph (including
 * `@grpc/grpc-js`) has been loaded into the main process.
 */

/** Upper bound on how long `app.close()` may take before we call it a hang. */
const QUIT_BUDGET_MS = 15_000;

/** How long to keep polling for a process to disappear after the app closes. */
const REAP_TIMEOUT_MS = 5_000;

/**
 * Absolute path to the Pulumi Automation API entry point, plus a referrer for
 * `createRequire`.
 *
 * The explicit `/index.js` matters: `@pulumi/pulumi` is CommonJS with no
 * `exports` map, so the bare directory specifier fails ESM resolution with
 * `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged main bundle.
 */
const PULUMI_AUTOMATION = {
  path: join(repoRoot, 'node_modules', '@pulumi', 'pulumi', 'automation', 'index.js'),
  referrer: pathToFileURL(join(repoRoot, 'package.json')).href,
};

/** Returns `true` while the given pid still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists the direct child pids of `pid` (GPU process, zygotes, utility
 * processes, and any engine child the app spawned).
 *
 * Returns `[]` on platforms without `pgrep`, so the spec degrades to the
 * parent-process assertions rather than failing for the wrong reason.
 */
function childPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isInteger(n));
  } catch {
    // pgrep exits 1 when there are no matches, which is not an error here.
    return [];
  }
}

/**
 * Lists any `pulumi` engine process currently running, by matching the engine
 * install root the app uses (`<userData>/pulumi`) as well as a bare `pulumi`
 * process name.
 *
 * A plain `pgrep -f pulumi` is deliberately avoided: a checkout path that
 * happens to contain the string "pulumi" would match every unrelated process.
 */
function pulumiProcesses(): string[] {
  if (process.platform === 'win32') return [];
  const matches = new Set<string>();
  for (const args of [
    ['-a', '-f', '/pulumi/bin/pulumi'],
    ['-a', '-x', 'pulumi'],
  ]) {
    try {
      for (const line of execFileSync('pgrep', args, { encoding: 'utf8' }).split('\n')) {
        if (line.trim() !== '') matches.add(line.trim());
      }
    } catch {
      // No matches — pgrep exits 1.
    }
  }
  return [...matches];
}

/** Polls until `predicate` holds or the timeout elapses; returns the result. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

test.describe('electron clean quit', () => {
  test.describe.configure({ mode: 'serial' });

  test('should exit within the quit budget when closed while idle', async () => {
    const { app } = await launchElectron();
    const pid = app.process().pid;
    expect(pid, 'the Electron main process should have a pid').toBeDefined();

    const children = childPids(pid as number);

    const start = Date.now();
    await app.close();
    const closeMs = Date.now() - start;

    expect(
      closeMs,
      `app.close() took ${String(closeMs)}ms — a hang here means something in the main process is keeping the event loop alive`,
    ).toBeLessThan(QUIT_BUDGET_MS);

    expect(await waitFor(() => !isAlive(pid as number), REAP_TIMEOUT_MS)).toBe(true);
    expect(
      await waitFor(() => children.every((child) => !isAlive(child)), REAP_TIMEOUT_MS),
      `child processes survived the quit: ${children.filter(isAlive).join(', ')}`,
    ).toBe(true);
    expect(pulumiProcesses()).toEqual([]);
  });

  test('should exit cleanly after the Pulumi Automation API is loaded in the main process', async () => {
    const { app } = await launchElectron();
    const pid = app.process().pid;
    expect(pid, 'the Electron main process should have a pid').toBeDefined();

    // Loads the real `@pulumi/pulumi/automation` module graph — `@grpc/grpc-js`
    // included — into the packaged main process, without running any engine
    // operation. Module-scope side effects that would pin the event loop open
    // (the `@cdktf/hcl2json` failure mode) surface as a hung `app.close()`
    // below.
    // `app.evaluate` runs the callback through `eval` in the main process, where
    // dynamic `import()` throws "A dynamic import callback was not specified"
    // and no `require` is in scope. `process.getBuiltinModule('module')` (Node
    // 22+) is the supported way to reach a real `require` from there.
    const exports = await app.evaluate(
      (_electron, target: { path: string; referrer: string }) => {
        const { createRequire } = process.getBuiltinModule('module');
        const automation = createRequire(target.referrer)(target.path) as Record<string, unknown>;
        return {
          localWorkspace: typeof automation['LocalWorkspace'],
          pulumiCommand: typeof automation['PulumiCommand'],
        };
      },
      PULUMI_AUTOMATION,
    );

    expect(
      exports,
      'the Automation API must load from node_modules — if this fails, @pulumi/pulumi is no longer resolvable as an external module',
    ).toEqual({ localWorkspace: 'function', pulumiCommand: 'function' });

    const children = childPids(pid as number);

    const start = Date.now();
    await app.close();
    const closeMs = Date.now() - start;

    expect(
      closeMs,
      `app.close() took ${String(closeMs)}ms with @pulumi/pulumi loaded — the module graph is keeping the Electron event loop alive`,
    ).toBeLessThan(QUIT_BUDGET_MS);

    expect(await waitFor(() => !isAlive(pid as number), REAP_TIMEOUT_MS)).toBe(true);
    expect(
      await waitFor(() => children.every((child) => !isAlive(child)), REAP_TIMEOUT_MS),
      `child processes survived the quit: ${children.filter(isAlive).join(', ')}`,
    ).toBe(true);
    expect(pulumiProcesses()).toEqual([]);
  });
});
