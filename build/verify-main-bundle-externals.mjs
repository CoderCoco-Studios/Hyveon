#!/usr/bin/env node
/**
 * Fails the build when a package that must stay `external` has been bundled
 * into the Electron main output.
 *
 * Runs as the second half of `npm run desktop:build`, so every path that
 * produces a packaged main bundle is covered: `desktop:package` (and therefore
 * .github/workflows/package.yml), `@hyveon/web`'s `test:e2e` script (and
 * therefore .github/workflows/e2e.yml, whose electron project launches
 * `out/main/index.js`), and `docs:screenshots`.
 *
 * ## Why this exists
 *
 * `@cdktf/hcl2json`, `@pulumi/pulumi` and `@pulumi/aws` are marked `external` in
 * `electron.vite.config.ts` because bundling them stops Electron from quitting:
 * hcl2json's Go `wasm_exec` glue runs module-scope side effects, and
 * `@pulumi/pulumi` pulls in `@grpc/grpc-js`, which owns sockets. `semver` is
 * external for a different reason — `PulumiCommand.install()` `instanceof`-checks
 * a `SemVer` against its own copy of the class, so a second bundled copy breaks
 * it.
 *
 * Rollup's `external` array matches import ids *exactly*, and the task 1.3 spike
 * found that `'@pulumi/pulumi'` therefore did nothing for
 * `'@pulumi/pulumi/automation'` — the subpath the Automation API is imported
 * through. The SDK was silently inlined into a 15 MB chunk, and **nothing
 * noticed**: lint, typecheck, the unit suite and the e2e suite were all green,
 * because they resolve the package from `node_modules` regardless of what the
 * bundle contains. Only reading the build output by hand caught it. Hence a
 * build-time assertion.
 *
 * ## How it works
 *
 * Each guarded package supplies marker strings that appear in its own published
 * source. A marker found anywhere under `out/main/` means that package's source
 * was inlined. The markers are also verified to still exist in the installed
 * package — a marker that a dependency upgrade removed would otherwise make this
 * check silently vacuous forever.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the repo root (one directory above `build/`). */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directory holding the Electron main bundle produced by electron-vite. */
const mainOutDir = join(repoRoot, 'out', 'main');

/**
 * Packages that must never appear inlined in `out/main`, each with strings
 * unique to its own source.
 *
 * Markers are chosen to be resistant to minification: runtime env-var names,
 * Pulumi resource type tokens and asset filenames survive bundling, whereas
 * identifiers and comments may not.
 */
const GUARDED = [
  {
    package: '@pulumi/pulumi',
    markers: ['PULUMI_NODEJS_MONITOR', 'pulumi:pulumi:Stack'],
  },
  {
    package: '@pulumi/aws',
    markers: ['pulumi:providers:aws'],
  },
  {
    package: '@cdktf/hcl2json',
    markers: ['main.wasm.gz'],
  },
];

/** Recursively collects every JavaScript file under `dir`. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Returns true when any file under a package directory contains `marker`. */
function markerPresentInPackage(packageName, marker) {
  const packageDir = join(repoRoot, 'node_modules', packageName);
  if (!existsSync(packageDir)) return false;
  for (const file of jsFiles(packageDir)) {
    if (readFileSync(file, 'utf8').includes(marker)) return true;
  }
  return false;
}

const problems = [];

if (!existsSync(mainOutDir) || !statSync(mainOutDir).isDirectory()) {
  problems.push(`out/main does not exist — run \`electron-vite build\` first (looked in ${mainOutDir})`);
} else {
  const bundleFiles = jsFiles(mainOutDir);
  if (bundleFiles.length === 0) problems.push('out/main contains no JavaScript files');

  const contents = bundleFiles.map((file) => ({
    path: relative(repoRoot, file),
    text: readFileSync(file, 'utf8'),
  }));

  for (const { package: packageName, markers } of GUARDED) {
    for (const marker of markers) {
      // Self-check: a marker that no longer exists upstream would make this
      // guard pass for the wrong reason.
      if (!markerPresentInPackage(packageName, marker)) {
        problems.push(
          `marker ${JSON.stringify(marker)} no longer appears in ${packageName}'s own source — ` +
            `this guard has gone stale and must be given a new marker`,
        );
        continue;
      }
      for (const { path, text } of contents) {
        if (text.includes(marker)) {
          problems.push(
            `${path} contains ${JSON.stringify(marker)} — ${packageName} has been BUNDLED into the ` +
              `Electron main output. It must stay \`external\` in electron.vite.config.ts, or ` +
              `Electron may never quit (see the @cdktf/hcl2json incident).`,
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nout/main external-package check FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(
  `out/main external-package check passed (${GUARDED.map((g) => g.package).join(', ')} not bundled)`,
);
