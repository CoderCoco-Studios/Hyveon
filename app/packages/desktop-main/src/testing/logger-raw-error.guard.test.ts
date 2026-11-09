/**
 * Static guard for the `.claude/rules/logging.md` rule that logger metadata carries a normalized error message and never a
 * raw error object. Scans every non-test source file under `desktop-main/src` (services, controllers, `updater.ts`,
 * `ipc-handlers.ts`, `electron-entry.ts`, `helper-quit-hook.ts`, ...) for `logger.<level>(...)` calls that pass a
 * caught-error binding as an argument or as an object property value (`{ err }`, `{ cause: err }`, `{ ...err }`,
 * `{ error: caught as Error }`, or a bare `err` second argument).
 *
 * The check is lexical, not type-aware. A name counts as a caught-error binding when it appears anywhere in the same file
 * as a `catch (name)` / `.catch((name) =>` binding or an `err`/`error`/`e`/`reason`-style parameter typed `unknown | Error`, so a string variable that
 * happens to share a name with a binding elsewhere in the file would be flagged (a false positive), and an error reached
 * through an alias or a property access is not seen (a false negative). It is a regression net for the common shapes,
 * not a proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files owned by other arrow segments that still log a raw error object, tolerated so the guard can gate the rest of
 * the tree today. An entry here is a known debt, not an endorsement: remove it when the owning segment normalizes its
 * logger metadata. A listed file that has since been fixed only produces a console warning (the stacks that fix them
 * land independently, so a stale entry must not fail the build); a violation in an unlisted file always fails.
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

/** Parameter names that, when typed `unknown`/`Error`, are taken to hold a caught error (a `game: unknown` is not). */
const ERROR_PARAM_NAME = /^(?:err|error|e|ex|exc|exception|cause|reason|caught|failure)$/;

const LOGGER_OPENER = /\blogger\.(?:debug|info|warn|error|log|verbose|silly)\(/g;

/** Recursively lists non-test `.ts` source files under `dir`, skipping this guard's own `testing` directory. */
function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' || entry.name === 'node_modules' ? [] : listSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Returns the index just past the string literal that starts at `start` (a quote or backtick), honouring escapes and
 * `${...}` expressions inside template literals.
 */
function skipString(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
    } else if (ch === quote) {
      return i + 1;
    } else if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = skipBalanced(source, i + 1);
    } else {
      i++;
    }
  }
  return i;
}

/** Returns the index just past the bracket group opened at `start`, skipping string literals. */
function skipBalanced(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Splits `text` at commas that sit outside any bracket group or string literal. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
    } else if (ch === '(' || ch === '{' || ch === '[') {
      i = skipBalanced(text, i);
    } else {
      if (ch === ',') {
        parts.push(text.slice(last, i));
        last = i + 1;
      }
      i++;
    }
  }
  parts.push(text.slice(last));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Returns the argument text of every `logger.<level>(...)` call in `source`, with the 1-based line it starts on. */
function loggerCalls(source: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = [];
  const opener = new RegExp(LOGGER_OPENER);
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    const open = opener.lastIndex - 1;
    const end = skipBalanced(source, open);
    calls.push({ line: source.slice(0, m.index).split('\n').length, args: source.slice(open + 1, end - 1) });
  }
  return calls;
}

/** Names bound to a caught error anywhere in `source`: `catch (x)`, `.catch((x) =>`, and error-named `x: unknown | Error` parameters. */
function caughtErrorBindings(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, /\.catch\(\s*\(?\s*([A-Za-z_$][\w$]*)/g, /\b([A-Za-z_$][\w$]*)\s*:\s*(?:unknown|Error)\b/g];
  for (const pattern of patterns) {
    for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
      const isTypedParam = pattern === patterns[2];
      if (!isTypedParam || ERROR_PARAM_NAME.test(m[1]!)) names.add(m[1]!);
    }
  }
  return names;
}

/** Whether `expr` is exactly a caught-error binding, optionally cast (`err`, `err as Error`). */
function isBoundIdentifier(expr: string, bindings: Set<string>): boolean {
  const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+[\w.<>[\]| ]+)?$/.exec(expr.trim());
  return match !== null && bindings.has(match[1]!);
}

/** Whether a logger call's argument text passes a caught-error binding bare, in an object literal, or by spread. */
export function passesRawError(args: string, bindings: Set<string>): boolean {
  return splitTopLevel(args).some((arg) => {
    if (isBoundIdentifier(arg, bindings)) return true;
    if (!arg.startsWith('{')) return false;
    return splitTopLevel(arg.slice(1, -1)).some((prop) => {
      if (prop.startsWith('...')) return isBoundIdentifier(prop.slice(3), bindings);
      const colon = prop.search(/:(?!:)/);
      return isBoundIdentifier(colon === -1 ? prop : prop.slice(colon + 1), bindings);
    });
  });
}

// @spec APP-DIAG-SVC-002
describe('logger metadata never carries a raw error object', () => {
  it('should flag no logger call in desktop-main sources that passes a caught-error binding as an argument or property', () => {
    const violations: string[] = [];
    const flaggedAllowlisted = new Set<string>();
    for (const file of listSources(SRC)) {
      const rel = relative(SRC, file);
      const source = readFileSync(file, 'utf8');
      const bindings = caughtErrorBindings(source);
      const hits = loggerCalls(source).filter(({ args }) => passesRawError(args, bindings));
      if (hits.length === 0) continue;
      if (ALLOWLIST.has(rel)) flaggedAllowlisted.add(rel);
      else violations.push(...hits.map(({ line }) => `${rel}:${line}`));
    }
    const fixed = [...ALLOWLIST].filter((rel) => !flaggedAllowlisted.has(rel));
    if (fixed.length > 0) console.warn(`logger-raw-error guard: allowlist entries with no remaining violation: ${fixed.join(', ')}`);
    expect(violations).toEqual([]);
  });

  it('should recognise the raw-error shapes the guard exists to catch', () => {
    const bindings = new Set(['err', 'e', 'caught', 'error', 'reason']);
    const bad = [
      'm, { err }',
      'm, { err: e, game }',
      'm, { game, error }',
      'm, { error: error }',
      'm, err',
      'm, { cause: err }',
      'm, { details: e }',
      'm, { error: caught }',
      'm, { err: e as Error }',
      'm, { ...err }',
      'err',
      "m, { note: 'a (b', err }",
    ];
    for (const args of bad) expect(passesRawError(args, bindings), args).toBe(true);
  });

  it('should not flag normalized errors or non-error values', () => {
    const bindings = new Set(['err', 'e', 'error']);
    const ok = [
      'm, { err: errMessage(e) }',
      'm, { message }',
      'm, { error: err.message }',
      'm, { game }',
      'm, { reason }',
      'm, { cause: String(err) }',
      "m, { note: 'err, (not an arg' }",
      'm',
    ];
    for (const args of ok) expect(passesRawError(args, bindings), args).toBe(false);
  });

  it('should only treat names bound as caught errors in the file as raw errors', () => {
    const source = 'const reason = "x"; try { run(); } catch (err) { logger.warn("m", { reason, err }); }';
    const bindings = caughtErrorBindings(source);

    expect(bindings.has('err')).toBe(true);
    expect(bindings.has('reason')).toBe(false);
    expect(passesRawError('"m", { reason }', bindings)).toBe(false);
    expect(passesRawError('"m", { err }', bindings)).toBe(true);
  });
});
