/**
 * Vitest CLI spec for init-parent.ts's `bootstrap` flow (issue #89). The
 * `migrate --to-s3`/`--to-local` subcommand and the `--s3-tfvars` flag were
 * removed: the S3 bucket they synced is the SAME bucket the app's own
 * first-run wizard provisions, but under a different, now-unread object key
 * (`terraform.tfvars`, vs. the app's own JSON `deployment-config.json` key)
 * — nothing reads that key anymore now that the Terraform tree is gone.
 *
 * `node:readline/promises` is mocked so no real interactive prompts happen.
 * `renderMakefile`/`renderTfvars`/etc.'s own render-shape checks live in
 * `init-parent.test.ts` — this spec only asserts the CLI dispatch + IO
 * behaviour layered on top of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Interface } from 'node:readline/promises';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));
// Preserves every other `node:process` export (cwd, stdin, stdout, argv, ...)
// but replaces `exit` with a no-op mock, so the "not a directory" abort
// branch in init-parent.ts (which calls `exit(1)`) can be exercised without
// actually killing the Vitest worker process.
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return { ...actual, exit: vi.fn() };
});

import { createInterface } from 'node:readline/promises';
import { CliUsageError, parseCliArgs, runBootstrap } from './init-parent.ts';

/**
 * Wires the mocked `node:readline/promises` `createInterface` to hand back
 * `answers` in order, one per `question()` call — mirroring the sequence of
 * prompts `runBootstrap` asks. Throws if more questions are asked than
 * answers were queued, so a spec fails loudly (instead of silently reading
 * `undefined`) if a code change adds an unexpected prompt.
 */
function queueReadlineAnswers(answers: string[]): void {
  const queue = [...answers];
  const stub: Partial<Interface> = {
    question: vi.fn(async () => {
      if (queue.length === 0) throw new Error('queueReadlineAnswers: ran out of queued answers');
      return queue.shift() as string;
    }),
    close: vi.fn(),
  };
  vi.mocked(createInterface).mockReturnValue(stub as Interface);
}

describe('parseCliArgs', () => {
  it('should default to force/yes false when no flags are given', () => {
    expect(parseCliArgs([])).toEqual({ force: false, yes: false });
  });

  it('should set force true for "--force"', () => {
    expect(parseCliArgs(['--force'])).toEqual({ force: true, yes: false });
  });

  it('should set yes true for "--yes"', () => {
    expect(parseCliArgs(['--yes'])).toEqual({ force: false, yes: true });
  });

  it('should accept an explicit "bootstrap" subcommand token identically to omitting it', () => {
    expect(parseCliArgs(['bootstrap', '--force'])).toEqual({ force: true, yes: false });
  });

  it('should throw CliUsageError for an unrecognized subcommand', () => {
    expect(() => parseCliArgs(['migrate'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['migrate'])).toThrow('Unknown subcommand "migrate".');
  });

  it('should throw CliUsageError for an unrecognized flag', () => {
    expect(() => parseCliArgs(['--to-s3'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--to-s3'])).toThrow('Unknown flag "--to-s3".');
  });

  it('should throw CliUsageError for the retired --s3-tfvars flag', () => {
    expect(() => parseCliArgs(['--s3-tfvars'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--s3-tfvars'])).toThrow('Unknown flag "--s3-tfvars".');
  });
});

describe('runBootstrap', () => {
  let parentDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should write Makefile/terraform.tfvars/.gitignore and never write a tfvars-bucket marker', async () => {
    queueReadlineAnswers([
      parentDir, // Parent repo path
      'Hyveon', // Submodule path
      'test-parent', // Project name
      'us-east-1', // AWS region
      'example.com', // Route 53 hosted zone
      'n', // Seed Discord credentials?
    ]);

    await runBootstrap({ yes: false });

    expect(existsSync(join(parentDir, 'Makefile'))).toBe(true);
    expect(existsSync(join(parentDir, 'terraform.tfvars'))).toBe(true);
    expect(existsSync(join(parentDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(parentDir, '.env'))).toBe(false);
    // No S3 tfvars backend concept remains — bootstrap must never write this.
    expect(existsSync(join(parentDir, '.hyveon', 'tfvars-bucket'))).toBe(false);
  });

  it('should render a Makefile with only the help/setup/update/dev targets', async () => {
    queueReadlineAnswers([parentDir, 'Hyveon', 'test-parent', 'us-east-1', 'example.com', 'n']);

    await runBootstrap({ yes: false });

    const makefile = readFileSync(join(parentDir, 'Makefile'), 'utf8');
    expect(makefile).toContain('.PHONY: help setup update dev');
    expect(makefile).not.toContain('plan:');
    expect(makefile).not.toContain('apply:');
    expect(makefile).not.toContain('tfvars-pull:');
    expect(makefile).not.toContain('TFVARS_BACKEND');
  });

  it('should skip existing files unless --force is passed', async () => {
    writeFileSync(join(parentDir, 'Makefile'), 'stale\n');
    queueReadlineAnswers([parentDir, 'Hyveon', 'test-parent', 'us-east-1', 'example.com', 'n']);

    await runBootstrap({ yes: false });

    expect(readFileSync(join(parentDir, 'Makefile'), 'utf8')).toBe('stale\n');
  });
});
