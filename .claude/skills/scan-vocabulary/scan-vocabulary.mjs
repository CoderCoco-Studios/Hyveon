#!/usr/bin/env node
/**
 * Deterministic, parallel scanner for arbitrary vocabulary left over in a
 * codebase — e.g. confirming a rename/removal actually reached every file.
 *
 * Scans every non-binary file under a root directory for one or more search
 * terms, using worker_threads to parallelize file I/O + regex scanning
 * across CPU cores. Output is sorted deterministically (file, then line,
 * then column) regardless of filesystem enumeration order or worker
 * scheduling, so re-running against an unchanged tree always produces the
 * same report.
 *
 * Usage:
 *   node scan-vocabulary.mjs <rootDir> --terms=term1,term2,... [--boundary=term1] [--exclude=path1,path2] [--json]
 *
 *   rootDir     Directory to scan (required, positional).
 *   --terms     Comma-separated list of search terms (required).
 *   --boundary  Comma-separated subset of --terms to search with
 *               word-boundary matching instead of plain substring — use
 *               this for short/generic terms (2-4 letters) that would
 *               otherwise produce noise matching inside unrelated words
 *               (e.g. "tf" plain-substring-matches inside "outfit").
 *               Boundary mode also auto-generates a PascalCase word-segment
 *               variant (so "tf" also catches "TfOutputs"/"getTfOutputs").
 *   --exclude   Comma-separated list of paths (relative to rootDir) to skip
 *               for this run only, on top of the built-in defaults — e.g. a
 *               directory that's expected to hold historical references
 *               (`openspec`) or a generated artifact not covered by the
 *               defaults. Matches the path itself and everything under it.
 *   --json      Emit the full match list as JSON instead of a
 *               human-readable report (still deterministically ordered).
 *
 * Examples:
 *   # Simple sweep for a couple of retired terms
 *   node scan-vocabulary.mjs ../.. --terms=terraform,tfvars
 *
 *   # Same, but treat the short/generic term "tf" as boundary-only to
 *   # avoid matching inside unrelated words
 *   node scan-vocabulary.mjs ../.. --terms=terraform,tfvars,tf --boundary=tf
 *
 *   # Skip a directory that's expected to hold historical references
 *   node scan-vocabulary.mjs ../.. --terms=terraform,tfvars --exclude=openspec
 *
 * No external dependencies — Node builtins only.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Directory names to skip anywhere in the tree — build output / vendored code, never source. */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'coverage',
  '.docusaurus',
  '.cache',
  '.turbo',
  '.next',
  'playwright-report',
]);

/** Relative path prefixes (from the scan root) to skip — nested worktree copies of this same repo. */
const EXCLUDED_PATH_PREFIXES = ['.claude/worktrees', '.worktrees'];

/** Exact filenames to skip anywhere in the tree — machine-generated lockfiles whose
 * base64/hex hash content produces meaningless matches, especially for short terms. */
const EXCLUDED_FILE_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

/** File extensions that are never useful to scan as text (binary/generated assets). */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.gz', '.tar', '.pdf', '.mp4', '.mov', '.webm',
  '.wasm', '.node', '.map', '.lock', '.tsbuildinfo',
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the regex patterns to scan for. Every term gets a plain
 * case-insensitive substring pattern by default. Terms named in
 * `boundaryTerms` instead get a word-boundary pattern (excludes matches
 * embedded in unrelated words) plus a PascalCase word-segment pattern
 * (catches camelCase/PascalCase identifiers a boundary check alone would
 * miss, e.g. "getTfOutputs").
 */
function buildPatterns(terms, boundaryTerms) {
  const patterns = [];
  for (const term of terms) {
    const escaped = escapeRegExp(term);
    if (boundaryTerms.has(term.toLowerCase())) {
      patterns.push({
        name: `${term}-token`,
        regex: new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi'),
      });
      const titleCase = term[0].toUpperCase() + term.slice(1).toLowerCase();
      patterns.push({
        name: `${term}-camel`,
        regex: new RegExp(`${escapeRegExp(titleCase)}(?=[A-Z])`, 'g'),
      });
    } else {
      patterns.push({ name: term, regex: new RegExp(escaped, 'gi') });
    }
  }
  return patterns;
}

function isTextFile(filePath) {
  return !BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isExcludedPath(relPath, extraPrefixes) {
  const relNormalized = relPath.split('\\').join('/');
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => relNormalized === prefix || relNormalized.startsWith(prefix + '/'))) {
    return true;
  }
  return extraPrefixes.some((prefix) => relNormalized === prefix || relNormalized.startsWith(prefix + '/'));
}

/** Recursively collects every scannable file path under `dir`, skipping excluded dirs and `--exclude` paths. */
function walk(dir, root, acc, extraPrefixes) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // unreadable dir (permissions, race) — skip rather than crash the whole scan
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || isExcludedPath(rel, extraPrefixes)) continue;
      walk(full, root, acc, extraPrefixes);
    } else if (
      entry.isFile() &&
      !EXCLUDED_FILE_NAMES.has(entry.name) &&
      isTextFile(full) &&
      !isExcludedPath(rel, extraPrefixes)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Scans a single file's contents line-by-line against every pattern. */
function scanFile(filePath, root, patterns) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return []; // unreadable file — skip rather than crash the worker
  }
  if (content.indexOf('\u0000') !== -1) return []; // binary despite extension allowlist

  const matches = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, regex } of patterns) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(line)) !== null) {
        matches.push({
          file: relative(root, filePath).split('\\').join('/'), // normalize on Windows
          line: i + 1,
          column: m.index + 1,
          pattern: name,
          match: m[0],
          text: line.trim().slice(0, 200),
        });
        if (m[0].length === 0) regex.lastIndex += 1; // guard against zero-length-match infinite loops
      }
    }
  }
  return matches;
}

// ---- Worker entry point ----
if (!isMainThread) {
  const { files, root, patternSpecs } = workerData;
  const patterns = patternSpecs.map((p) => ({ name: p.name, regex: new RegExp(p.source, p.flags) }));
  const results = [];
  for (const file of files) {
    results.push(...scanFile(file, root, patterns));
  }
  parentPort.postMessage(results);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ---- Main thread ----
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (!flags.terms) {
    console.error(
      'Usage: node scan-vocabulary.mjs <rootDir> --terms=term1,term2,... [--boundary=term1] [--exclude=path1,path2] [--json]',
    );
    process.exitCode = 1;
    return;
  }

  const root = positional[0] ?? process.cwd();
  const terms = String(flags.terms).split(',').map((t) => t.trim()).filter(Boolean);
  const boundaryTerms = new Set(
    flags.boundary
      ? String(flags.boundary).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : [],
  );
  const excludePrefixes = flags.exclude
    ? String(flags.exclude)
        .split(',')
        .map((p) => p.trim().split('\\').join('/').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    : [];
  const jsonOutput = Boolean(flags.json);

  const patterns = buildPatterns(terms, boundaryTerms);
  const patternSpecs = patterns.map((p) => ({ name: p.name, source: p.regex.source, flags: p.regex.flags }));

  const files = walk(root, root, [], excludePrefixes);
  files.sort(); // deterministic file ordering regardless of readdir order

  const workerCount = Math.max(1, Math.min(cpus().length, files.length || 1));
  const chunks = Array.from({ length: workerCount }, () => []);
  files.forEach((f, i) => chunks[i % workerCount].push(f));

  const thisFile = fileURLToPath(import.meta.url);
  const workerResults = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          if (chunk.length === 0) {
            resolve([]);
            return;
          }
          const worker = new Worker(thisFile, { workerData: { files: chunk, root, patternSpecs } });
          worker.on('message', resolve);
          worker.on('error', reject);
        }),
    ),
  );

  const allMatches = workerResults.flat();
  allMatches.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  if (jsonOutput) {
    console.log(JSON.stringify(allMatches, null, 2));
    return;
  }

  for (const m of allMatches) {
    console.log(`${m.file}:${m.line}:${m.column}  [${m.pattern}]  ${m.text}`);
  }

  const byPattern = {};
  for (const m of allMatches) byPattern[m.pattern] = (byPattern[m.pattern] ?? 0) + 1;

  console.log('');
  console.log(`Terms: ${terms.join(', ')}${boundaryTerms.size ? ` (boundary mode: ${[...boundaryTerms].join(', ')})` : ''}`);
  if (excludePrefixes.length) console.log(`Excluded: ${excludePrefixes.join(', ')}`);
  console.log(`Scanned ${files.length} files using ${workerCount} worker threads.`);
  console.log(`Found ${allMatches.length} matches:`);
  for (const [name, count] of Object.entries(byPattern)) {
    console.log(`  ${name}: ${count}`);
  }
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
