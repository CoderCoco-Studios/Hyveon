/**
 * SPIKE SCAFFOLDING.
 *
 * This module exists to answer the single highest-risk question of the
 * Terraform → Pulumi migration: **does a Pulumi Automation API inline program
 * run from inside a packaged `app.asar` build?** The inline mechanism stands up
 * an in-process gRPC `LanguageRuntimeService`, spawns the `pulumi` CLI with
 * `--client=127.0.0.1:<port> --exec-kind inline`, and relies on the engine
 * calling *back into our process* to execute the program closure. Nothing about
 * that round trip is exercised by a dev-mode run, so it is proven here against
 * a real packaged build.
 *
 * It is gated behind `HYVEON_PULUMI_SPIKE=1` (see `isPulumiSpikeEnabled()` in
 * `../env.ts`), is imported dynamically so a normal app start never loads
 * `@pulumi/pulumi`, and declares **zero resources** so no AWS provider plugin
 * is downloaded and no AWS credentials are needed.
 *
 * Delete this file, `isPulumiSpikeEnabled()`, and the call site in
 * `electron-entry.ts` once `PulumiEngineService` supersedes them.
 *
 * Environment variables (all spike-only, read here rather than in `../env.ts`
 * because they are scaffolding and have no production call site):
 *
 * | Variable                       | Effect                                              |
 * |--------------------------------|-----------------------------------------------------|
 * | `HYVEON_PULUMI_SPIKE=1`        | Runs this spike after the window opens.             |
 * | `HYVEON_PULUMI_SPIKE_OUT`      | JSON result path. Defaults under `userData`.         |
 * | `HYVEON_PULUMI_SPIKE_QUIT=1`   | Calls `app.quit()` once results are written.        |
 */

import { app } from 'electron';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SemVer } from 'semver';
// The explicit `/index.js` is required, not cosmetic. The main bundle is ESM
// and `@pulumi/pulumi` is externalized, so this import survives to runtime as a
// real Node ESM resolution — and `@pulumi/pulumi` is CommonJS with no
// `exports` map, which makes the bare directory specifier
// `@pulumi/pulumi/automation` fail with `ERR_UNSUPPORTED_DIR_IMPORT` in the
// packaged app. Naming the file directly
// resolves, and Node's cjs-module-lexer does pick up the star re-exports in
// `automation/index.js`, so named imports still work.
import { LocalWorkspace, PulumiCommand } from '@pulumi/pulumi/automation/index.js';

/**
 * Engine version to provision — must match the `@pulumi/pulumi` SDK pin in
 * `package.json`.
 */
const ENGINE_VERSION = '3.255.0';

/** Sentinel string the inline closure emits to prove the gRPC callback fired. */
const SENTINEL = 'HYVEON_PULUMI_SPIKE_SENTINEL';

/** Throwaway passphrase for the spike's `passphrase` secrets provider. */
const SPIKE_PASSPHRASE = 'spike-throwaway-passphrase';

/** Bare stack name — the DIY-backend naming rule pinned in `design.md`. */
const STACK_NAME = 'spike';

/** Project name for the throwaway inline program. */
const PROJECT_NAME = 'hyveon-pulumi-spike';

/** `createRequire` bound to this module, used to report resolved module paths. */
const requireFromHere = createRequire(import.meta.url);

/**
 * Resolves a module id to an on-disk path for evidence purposes, returning the
 * thrown error message instead of throwing so a resolution failure is recorded
 * rather than aborting the spike.
 */
function resolveForEvidence(id: string): string {
  try {
    return requireFromHere.resolve(id);
  } catch (err) {
    return `<unresolved: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

/** Serializable shape written to the spike's JSON result file. */
interface SpikeResult {
  spike: string;
  pass: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Environment facts that prove the run happened inside a packaged build. */
  environment: {
    isPackaged: boolean;
    execPath: string;
    resourcesPath: string;
    moduleUrl: string;
    runsFromAsar: boolean;
    electronVersion: string;
    nodeVersion: string;
    userData: string;
    resolvedPulumiSdk: string;
    resolvedGrpc: string;
  };
  /** Engine provisioning facts. */
  engine?: {
    installRoot: string;
    installMs: number;
    command: string;
    version: string;
  };
  /** Inline-program facts — the actual 1.3 question. */
  inline?: {
    backendUrl: string;
    pulumiHome: string;
    sentinelLines: string[];
    previewMs: number;
    previewChangeSummary: Record<string, number | undefined>;
    upMs: number;
    upResultSummary: { kind: string; result: string; message: string };
    upChangeSummary: Record<string, number | undefined>;
    outputs: Record<string, unknown>;
    /** True when the closure ran in this very process (same pid). */
    closureRanInThisProcess: boolean;
  };
  error?: { message: string; stack?: string };
}

/**
 * Runs the spike end to end and writes a JSON result document.
 *
 * Never rejects: every failure path is captured into the result file, because a
 * packaged app has no reliable stdout for the harness to read.
 */
export async function runPulumiSpike(): Promise<void> {
  const userData = app.getPath('userData');
  const outPath =
    process.env.HYVEON_PULUMI_SPIKE_OUT ?? path.join(userData, 'pulumi-spike-result.json');
  const moduleUrl = import.meta.url;

  const result: SpikeResult = {
    spike: '1.3/1.5',
    pass: false,
    startedAt: new Date().toISOString(),
    environment: {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      moduleUrl,
      runsFromAsar: moduleUrl.includes('app.asar'),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      userData,
      resolvedPulumiSdk: resolveForEvidence('@pulumi/pulumi/automation'),
      resolvedGrpc: resolveForEvidence('@grpc/grpc-js'),
    },
  };

  let backendDir: string | undefined;
  let pulumiHome: string | undefined;

  try {
    const installRoot = path.join(userData, 'pulumi');
    const installStart = Date.now();
    const pulumiCommand = await PulumiCommand.install({
      version: new SemVer(ENGINE_VERSION),
      root: installRoot,
      skipVersionCheck: false,
    });
    result.engine = {
      installRoot,
      installMs: Date.now() - installStart,
      command: pulumiCommand.command,
      version: String(pulumiCommand.version),
    };

    backendDir = await mkdtemp(path.join(tmpdir(), 'hyveon-spike-backend-'));
    pulumiHome = await mkdtemp(path.join(tmpdir(), 'hyveon-spike-home-'));
    const backendUrl = `file://${backendDir}`;

    /** Sentinel lines the closure appends — proof it ran in this process. */
    const sentinelLines: string[] = [];
    const hostPid = process.pid;
    let closurePid = -1;

    const stack = await LocalWorkspace.createOrSelectStack(
      {
        stackName: STACK_NAME,
        projectName: PROJECT_NAME,
        // The whole lifecycle of an inline program must be contained in the
        // closure (design.md), so everything the program needs is captured here
        // and nothing is awaited outside it.
        program: async () => {
          closurePid = process.pid;
          const line = `${SENTINEL} pid=${process.pid} execPath=${process.execPath} moduleUrl=${moduleUrl}`;
          sentinelLines.push(line);
          console.log(line);
          return {
            sentinel: SENTINEL,
            closurePid: process.pid,
            closureExecPath: process.execPath,
            closureModuleUrl: moduleUrl,
          };
        },
      },
      {
        pulumiCommand,
        pulumiHome,
        envVars: {
          PULUMI_BACKEND_URL: backendUrl,
          PULUMI_CONFIG_PASSPHRASE: SPIKE_PASSPHRASE,
          PULUMI_SKIP_UPDATE_CHECK: 'true',
        },
      },
    );

    const previewStart = Date.now();
    const preview = await stack.preview();
    const previewMs = Date.now() - previewStart;

    const upStart = Date.now();
    const up = await stack.up();
    const upMs = Date.now() - upStart;

    const outputs = await stack.outputs();

    result.inline = {
      backendUrl,
      pulumiHome,
      sentinelLines,
      previewMs,
      previewChangeSummary: { ...preview.changeSummary },
      upMs,
      upResultSummary: {
        kind: up.summary.kind,
        result: up.summary.result,
        message: up.summary.message,
      },
      upChangeSummary: { ...up.summary.resourceChanges },
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([key, value]) => [key, value.value as unknown]),
      ),
      closureRanInThisProcess: closurePid === hostPid,
    };

    result.pass =
      sentinelLines.length > 0 &&
      closurePid === hostPid &&
      up.summary.result === 'succeeded' &&
      outputs['sentinel']?.value === SENTINEL;
  } catch (err) {
    result.error = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`[pulumi-spike] wrote ${outPath} (pass=${String(result.pass)})`);
    } catch (writeErr) {
      console.error(`[pulumi-spike] failed to write ${outPath}:`, writeErr);
    }

    // Remove the throwaway file backend and PULUMI_HOME. Best-effort: a
    // cleanup failure must not mask the spike's own verdict.
    for (const dir of [backendDir, pulumiHome]) {
      if (dir === undefined) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (process.env.HYVEON_PULUMI_SPIKE_QUIT === '1') {
      console.log('[pulumi-spike] HYVEON_PULUMI_SPIKE_QUIT=1 — calling app.quit()');
      app.quit();
    }
  }
}
