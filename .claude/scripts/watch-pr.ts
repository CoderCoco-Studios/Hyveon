/**
 * Polls a GitHub PR and prints ONE line per change to stdout (new comment/review,
 * check result, merge/close). Intended to run under the `Monitor` tool.
 * Usage: bun run .claude/scripts/watch-pr.ts <pr-number>
 * Comment text is untrusted: snippets are sanitized and length-capped.
 */

export interface Snapshot {
  state: string;
  mergedAt: string | null;
  /** check key (type + workflow + name) -> conclusion, or status/state when not yet concluded */
  checks: Record<string, string>;
  /** check key -> readable `workflow/name` label */
  checkLabels: Record<string, string>;
  /** dedupe key -> printable line */
  items: Record<string, string>;
}

const SNIPPET_MAX = 120;

/** Strips control chars/newlines, collapses whitespace, caps length. */
export function snippet(text: unknown): string {
  const s = String(text ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s;
}

interface Author { login?: string }
interface PrView {
  state?: string;
  mergedAt?: string | null;
  statusCheckRollup?: Array<{ __typename?: string; workflowName?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
  comments?: Array<{ id?: string; author?: Author; body?: string }>;
  reviews?: Array<{ id?: string; author?: Author; body?: string; state?: string }>;
}
export interface InlineComment { id?: number; user?: Author; body?: string; path?: string }

/** Builds a snapshot from raw gh output. Pure. */
export function buildSnapshot(view: PrView, inline: InlineComment[]): Snapshot {
  const checks: Record<string, string> = {};
  const checkLabels: Record<string, string> = {};
  for (const c of view.statusCheckRollup ?? []) {
    const name = snippet(c.name ?? c.context ?? 'unknown');
    const workflow = snippet(c.workflowName);
    const key =
      c.__typename === 'StatusContext' ? `StatusContext:${name}` : `${c.__typename ?? 'Check'}:${workflow}:${name}`;
    checks[key] = c.conclusion || c.state || c.status || 'PENDING';
    checkLabels[key] = workflow ? `${workflow}/${name}` : name;
  }
  const items: Record<string, string> = {};
  for (const c of view.comments ?? []) {
    items[`c:${c.id}`] = `comment by ${snippet(c.author?.login)}: ${snippet(c.body)}`;
  }
  for (const r of view.reviews ?? []) {
    items[`r:${r.id}`] = `review (${snippet(r.state)}) by ${snippet(r.author?.login)}: ${snippet(r.body)}`;
  }
  for (const c of inline) {
    items[`i:${c.id}`] = `inline comment by ${snippet(c.user?.login)} on ${snippet(c.path)}: ${snippet(c.body)}`;
  }
  return { state: view.state ?? 'UNKNOWN', mergedAt: view.mergedAt ?? null, checks, checkLabels, items };
}

const PENDING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', '']);

/** Lines describing changes from prev to next. Pure. */
export function diffSnapshots(prev: Snapshot, next: Snapshot): string[] {
  const lines: string[] = [];
  for (const [key, line] of Object.entries(next.items)) {
    if (!(key in prev.items)) lines.push(line);
  }
  for (const [key, result] of Object.entries(next.checks)) {
    if (prev.checks[key] !== result && !PENDING.has(result)) lines.push(`check ${next.checkLabels[key] ?? key} -> ${result}`);
  }
  if (next.state !== prev.state) {
    lines.push(next.mergedAt ? 'PR merged' : `PR ${next.state.toLowerCase()}`);
  }
  return lines;
}

/** Consecutive fetch failures after which the watcher repeats its warning, and after which it gives up. */
export const WARN_AFTER = 5;
export const GIVE_UP_AFTER = 10;

/** Decides what to print and whether to exit after the `failures`-th consecutive fetch failure. Pure. */
export function failureAction(failures: number, err: unknown): { message: string | null; exit: boolean } {
  const report = failures === 1 || failures === WARN_AFTER || failures >= GIVE_UP_AFTER;
  const message = report ? `watcher error: ${snippet(err instanceof Error ? err.message : err)}` : null;
  return { message, exit: failures >= GIVE_UP_AFTER };
}

export const isDone = (s: Snapshot): boolean => s.state === 'MERGED' || s.state === 'CLOSED';

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh exited ${code}`);
  return out;
}

async function fetchSnapshot(pr: string): Promise<Snapshot> {
  const [view, inline] = await Promise.all([
    gh(['pr', 'view', pr, '--json', 'state,mergedAt,reviewDecision,statusCheckRollup,comments,reviews']),
    gh(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${pr}/comments`]),
  ]);
  return buildSnapshot(JSON.parse(view), (JSON.parse(inline) as InlineComment[][]).flat());
}

async function main(): Promise<void> {
  const pr = process.argv[2];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('usage: watch-pr.ts <pr-number>');
    process.exit(2);
  }
  const POLL_MS = 60_000;
  const MAX_BACKOFF_MS = 300_000;
  let prev: Snapshot | null = null;
  let failures = 0;
  for (;;) {
    let delay = POLL_MS;
    try {
      const next = await fetchSnapshot(pr);
      failures = 0;
      if (!prev) {
        console.log(`watching PR #${pr}: ${next.state}, ${Object.keys(next.checks).length} checks`);
      } else {
        for (const line of diffSnapshots(prev, next)) console.log(line);
      }
      prev = next;
      if (isDone(next)) process.exit(0);
    } catch (err) {
      failures++;
      const { message, exit } = failureAction(failures, err);
      if (message) console.log(message);
      if (exit) process.exit(1);
      delay = Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
    }
    await Bun.sleep(delay);
  }
}

if (import.meta.main) await main();
