#!/usr/bin/env bun
/**
 * PreToolUse guard (Edit, Write, NotebookEdit, Bash): tracked-file changes
 * must never land on a repo's main checkout (.claude/rules/worktree.md).
 *
 * Judges the edit target's own repo, not the session cwd, so a worktree
 * session can't edit the main checkout and Pane worktrees nested under the
 * main toplevel aren't falsely denied. Bash is limited to `git
 * add|commit|merge|rebase|reset`, resolved against `cwd` and any `git -C`.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { getInput, deny, allow, isRecord } from './lib/hook-io.js';
import { isMainCheckout } from './lib/git-context.js';
import { PANE_GUIDANCE } from './lib/pane-guidance.js';

const WORD = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_MUTATION = new RegExp(
  String.raw`^\s*git\s+((?:(?:-[Cc]\s+${WORD}|--[a-z][a-z-]*(?:=\S+)?)\s+)*)(?:add|commit|merge|rebase|reset)\b`,
);
const SEGMENT_SPLIT = /[;&|\n]+/;
const CD = new RegExp(String.raw`^\s*(?:cd|pushd)\s+(${WORD})\s*$`);

// CI runners use a fresh isolated clone per run, the guarantee a worktree gives locally.
if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') allow();

const input = await getInput(
  (v): v is { tool_name: string; tool_input?: unknown; cwd?: unknown } =>
    isRecord(v) && typeof v.tool_name === 'string',
);

const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();

function block(what: string): never {
  return deny(`Blocked: ${what} targets the main checkout. Tracked-file changes must happen in a worktree. ${PANE_GUIDANCE}`);
}

/** Strips one layer of matching quotes from a shell word. */
const unquote = (w: string): string => (/^(["']).*\1$/.test(w) ? w.slice(1, -1) : w);

/** Resolves a cd/-C target against `base`; null when it can't be known statically (variables, substitution, `-`, `~user`). */
function resolveDir(base: string | null, word: string): string | null {
  const t = unquote(word);
  if (base === null || !t || /[$`()]/.test(t) || t === '-' || (t.startsWith('~') && t !== '~' && !t.startsWith('~/'))) return null;
  return path.resolve(base, t.startsWith('~') ? t.replace('~', homedir()) : t);
}

function checkMain(dir: string | null): boolean {
  if (dir === null) return true;
  try {
    return isMainCheckout(dir);
  } catch {
    return true;
  }
}

if (input.tool_name === 'Bash') {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  let effective: string | null = cwd;
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const cd = CD.exec(segment);
    if (cd) {
      effective = resolveDir(effective, cd[1]!);
      continue;
    }
    if (/^\s*popd\b/.test(segment)) effective = null;
    const match = GIT_MUTATION.exec(segment);
    if (!match) continue;
    let dir = effective;
    for (const c of (match[1] ?? '').matchAll(new RegExp(String.raw`-C\s+(${WORD})`, 'g'))) dir = resolveDir(dir, c[1]!);
    if (checkMain(dir)) block('this git command');
  }
} else if (['Edit', 'Write', 'NotebookEdit'].includes(input.tool_name)) {
  const target = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof target === 'string' && target && checkMain(path.resolve(cwd, target))) block('this edit');
}

allow();
