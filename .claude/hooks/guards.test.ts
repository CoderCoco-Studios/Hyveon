import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMainCheckout } from './lib/git-context.js';

const hooksDir = import.meta.dir;
let root: string;
let main: string;
let wt: string;
let outside: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'guards-')));
  main = path.join(root, 'main');
  wt = path.join(main, 'worktrees', 'feat');
  outside = path.join(root, 'plain');
  mkdirSync(main);
  mkdirSync(outside);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(path.join(main, 'a.txt'), 'x');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs a hook with `payload` on stdin; returns the permission decision ('allow' when none is emitted). */
function run(hook: string, payload: object): { decision: string; reason: string } {
  const res = spawnSync('bun', ['run', path.join(hooksDir, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
  });
  expect(res.error).toBeUndefined();
  expect(res.status).toBe(0);
  const out = res.stdout ? JSON.parse(res.stdout) : {};
  const h = out.hookSpecificOutput ?? {};
  return { decision: h.permissionDecision ?? 'allow', reason: h.permissionDecisionReason ?? '' };
}

const edit = (cwd: string, file_path: string) => ({ tool_name: 'Edit', cwd, tool_input: { file_path } });
const bash = (cwd: string, command: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } });

describe('isMainCheckout', () => {
  test('main true, worktree false, non-repo false, missing file resolves via parent', () => {
    expect(isMainCheckout(main)).toBe(true);
    expect(isMainCheckout(wt)).toBe(false);
    expect(isMainCheckout(outside)).toBe(false);
    expect(isMainCheckout(path.join(main, 'new', 'deep', 'f.ts'))).toBe(true);
  });
  test('throws on a git failure that is not "not a repository"', () => {
    const broken = path.join(root, 'broken');
    mkdirSync(broken);
    git(broken, 'init', '-q');
    writeFileSync(path.join(broken, '.git', 'config'), '[core\n garbage');
    expect(() => isMainCheckout(broken)).toThrow();
  });
});

describe('guard-main-checkout', () => {
  const hook = 'guard-main-checkout.ts';
  test('denies edit in main checkout', () => {
    const r = run(hook, edit(main, path.join(main, 'a.txt')));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('Pane');
  });
  test('allows edit in linked worktree', () => {
    expect(run(hook, edit(wt, path.join(wt, 'a.txt'))).decision).toBe('allow');
  });
  test('denies edit of main path from a worktree cwd', () => {
    expect(run(hook, edit(wt, path.join(main, 'a.txt'))).decision).toBe('deny');
  });
  test('allows edit outside any repo', () => {
    expect(run(hook, edit(main, path.join(outside, 'f.txt'))).decision).toBe('allow');
  });
  test('denies NotebookEdit in main', () => {
    const r = run(hook, { tool_name: 'NotebookEdit', cwd: main, tool_input: { notebook_path: path.join(main, 'n.ipynb') } });
    expect(r.decision).toBe('deny');
  });
  test('bash git commit: main denied, worktree allowed', () => {
    expect(run(hook, bash(main, 'git commit -m x')).decision).toBe('deny');
    expect(run(hook, bash(wt, 'git commit -m x')).decision).toBe('allow');
  });
  test('bash git -C handling', () => {
    expect(run(hook, bash(wt, `git -C ${main} add .`)).decision).toBe('deny');
    expect(run(hook, bash(main, `git -C ${wt} add .`)).decision).toBe('allow');
  });
  test('bash git with leading whitespace and global options', () => {
    expect(run(hook, bash(main, ' git add .')).decision).toBe('deny');
    expect(run(hook, bash(main, 'git -c core.quotePath=false add .')).decision).toBe('deny');
    expect(run(hook, bash(wt, `git -c a=b -C "${main}" commit -m x`)).decision).toBe('deny');
  });
  test('bash quoted -C path with spaces', () => {
    const spaced = path.join(root, 'with space');
    mkdirSync(spaced);
    git(spaced, 'init', '-q');
    expect(run(hook, bash(wt, `git -C "${spaced}" add .`)).decision).toBe('deny');
    expect(run(hook, bash(main, `git -C '${wt}' add .`)).decision).toBe('allow');
  });
  test('bash cd/pushd target is the effective dir', () => {
    expect(run(hook, bash(wt, `cd ${main} && git commit -m x`)).decision).toBe('deny');
    expect(run(hook, bash(wt, `pushd ${main}; git add .`)).decision).toBe('deny');
    expect(run(hook, bash(main, `cd ${wt} && git commit -m x`)).decision).toBe('allow');
    expect(run(hook, bash(main, 'cd ../main/worktrees/feat && git add .')).decision).toBe('allow');
  });
  test('bash undeterminable dir is denied with Pane guidance', () => {
    const r = run(hook, bash(wt, 'cd $SOMEWHERE && git commit -m x'));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('Pane');
    expect(run(hook, bash(wt, 'cd - && git add .')).decision).toBe('deny');
    expect(run(hook, bash(wt, 'cd $(pwd)/x && git add .')).decision).toBe('deny');
  });
  test('bash non-mutating git and non-git commands allowed in main', () => {
    expect(run(hook, bash(main, 'git status && ls')).decision).toBe('allow');
  });
  test('CI bypass', () => {
    const res = spawnSync('bun', ['run', path.join(hooksDir, hook)], {
      input: JSON.stringify(edit(main, path.join(main, 'a.txt'))),
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
    });
    expect(res.stdout).not.toContain('deny');
  });
});

describe('guard-redirect-to-pane', () => {
  const hook = 'guard-redirect-to-pane.ts';
  test('denies EnterWorktree with Pane text', () => {
    const r = run(hook, { tool_name: 'EnterWorktree', tool_input: { name: 'x' } });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('mcp__pane__agents_start');
  });
  test('denies git worktree add', () => {
    expect(run(hook, bash(main, 'git worktree add -b x ../x')).decision).toBe('deny');
    expect(run(hook, bash(main, 'cd a && git -C b worktree add x')).decision).toBe('deny');
    expect(run(hook, bash(main, ' git worktree add -b feat ../feat')).decision).toBe('deny');
  });
  test('allows other bash, incl. worktree list', () => {
    expect(run(hook, bash(main, 'git worktree list')).decision).toBe('allow');
    expect(run(hook, bash(main, 'echo worktree add')).decision).toBe('allow');
  });
});
