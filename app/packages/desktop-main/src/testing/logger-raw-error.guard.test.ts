/**
 * Static guard for the `.claude/rules/logging.md` rule that logger metadata carries a normalized error message and never a
 * raw error object. Scans every service and controller source file for `logger.<level>(...)` calls whose metadata holds a
 * bare error identifier (`{ err }`, `{ error }`, `{ err: e }`, `{ error: error }`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_DIRS = ['services', 'controllers'];

/**
 * Files owned by other arrow segments (IaC, game runtime, deployment config) that still log a raw error object. They are
 * allowlisted only so the guard protects the diagnostics segment's files today; each entry is removed when that segment
 * normalizes its logger metadata (the guard fails on an entry that no longer has a violation).
 */
const ALLOWLIST = new Set([
  'controllers/iac-runs.controller.ts',
  'controllers/iac-settings.controller.ts',
  'controllers/iac.controller.ts',
  'services/DeploymentConfigService.ts',
  'services/EcsService.ts',
  'services/Ec2Service.ts',
  'services/FileManagerService.ts',
  'services/GamesWriteService.ts',
  'services/PulumiEngineService.ts',
  'services/PulumiService.ts',
  'services/RunRecordService.ts',
  'services/RunService.ts',
  'services/SchedulerService.ts',
  'services/volumeFiles/HelperSessionRegistry.ts',
  'services/volumeFiles/VolumeFilesService.ts',
]);

/** Bare identifiers conventionally bound to a caught error. */
const ERROR_IDENT = String.raw`(?:err|error|e|ex|exception|reason|cause)`;
const RAW_ERROR_META = new RegExp(
  String.raw`[{,]\s*${ERROR_IDENT}\s*(?=[,}])|[{,]\s*(?:err|error)\s*:\s*${ERROR_IDENT}\s*(?=[,}])`,
);

/** Recursively lists `.ts` source files (excluding tests) under `dir`. */
function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Returns the argument text of every `logger.<level>(...)` call in `source`, with the 1-based line it starts on. */
function loggerCalls(source: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = [];
  const opener = /\blogger\.(?:debug|info|warn|error)\(/g;
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    let depth = 1;
    let i = opener.lastIndex;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    calls.push({ line: source.slice(0, m.index).split('\n').length, args: source.slice(opener.lastIndex, i - 1) });
  }
  return calls;
}

// @spec APP-DIAG-SVC-002
describe('logger metadata never carries a raw error object', () => {
  it('should flag no logger call in services or controllers that passes a bare error identifier as metadata', () => {
    const violations: string[] = [];
    const stale = new Set(ALLOWLIST);
    for (const dir of SCANNED_DIRS) {
      for (const file of listSources(join(SRC, dir))) {
        const rel = relative(SRC, file);
        const hits = loggerCalls(readFileSync(file, 'utf8')).filter(({ args }) => RAW_ERROR_META.test(args));
        if (ALLOWLIST.has(rel)) {
          if (hits.length > 0) stale.delete(rel);
        } else {
          violations.push(...hits.map(({ line }) => `${rel}:${line}`));
        }
      }
    }
    expect(violations).toEqual([]);
    expect([...stale]).toEqual([]);
  });

  it('should recognise the raw-error shapes the guard exists to catch', () => {
    for (const bad of ['m, { err }', 'm, { err: e, game }', 'm, { game, error }', 'm, { error: error }']) {
      expect(RAW_ERROR_META.test(bad), bad).toBe(true);
    }
    for (const ok of ['m, { err: errMessage(e) }', 'm, { message }', 'm, { error: err.message }', 'm, { game }']) {
      expect(RAW_ERROR_META.test(ok), ok).toBe(false);
    }
  });
});
