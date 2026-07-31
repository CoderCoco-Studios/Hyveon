# Copilot instructions for this repo

These instructions apply to **every GitHub Copilot interaction on this repository**, including code review on pull requests.

## Review philosophy

When reviewing a PR, **default to approval**. The author has already thought about their change, it has already passed CI, and the maintainers are going to review it themselves. Copilot's job is to catch the *small number of real issues* a human reviewer might miss — not to re-litigate every line.

A good review on this repo posts **zero comments** most of the time. Two or three comments on a ~30-file PR is already a lot. If you find yourself writing a fourth comment, stop and ask whether any of the first three are actually worth posting.

## What to comment on

Post a review comment **only** when one of the following is clearly true:

- **Bug**: the code will produce incorrect output, crash, or fail to behave as its name / surrounding comments / tests promise.
- **Security issue**: injection, auth bypass, secret leak, SSRF, prototype pollution, insecure defaults, missing authn/authz on an endpoint that should have it.
- **Crash or unhandled error path**: null dereference, unhandled promise rejection, missing `await` on something whose result matters, infinite loop / recursion, resource leak (unclosed handles, lingering timers, growing maps).
- **Production misconfiguration**: anything that works in dev but would break in production — wrong path resolution post-build, env var assumed to exist, routing that shadows API endpoints, etc.
- **Contract break**: a public API shape (HTTP response, exported type, CLI flag) changes in a way that callers aren't updated for.
- **Data-loss or destructive operation** without guards.
- **Non-conventional PR title** — see "PR title check" below; this is a real issue because we squash-merge, so flag it every time.

When you post one of these, be specific: name the exact failure scenario, not "this could be problematic".

## PR title check (always run this)

Before reviewing the diff, **read the PR title**. We squash-merge, so the PR title becomes the commit subject on `main` verbatim.

> **Important — strip shell/tool quoting before evaluating.** Whatever command or API you used to retrieve the title may wrap it in surrounding double-quotes (e.g. `"fix(docs): update readme"`). Those outer quotes are formatting added by the tool, not characters in the actual title. **Remove them before checking.** Only flag quote characters if they appear *inside* the title text itself (e.g. `fix: handle "unknown" state` — the inner quotes would be unusual but are the author's choice). Never flag a title as malformed solely because the tool output surrounded it with quotes.

The title MUST:

1. Start with a Conventional Commits type — one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`, `style`.
2. Optionally include a scope in parentheses, e.g. `feat(server):`, `fix(watchdog):`.
3. Be followed by a colon, a space, then a short imperative summary.
4. Stay under ~70 characters total.

Examples that PASS: `refactor(app): migrate server from Express+tsyringe to Nest.js`, `docs: reflect Nest.js migration in CLAUDE.md`, `fix(watchdog): stop leaking tags on failed runs`, `chore: add ESLint flat config`.

Examples that FAIL: `Add ESLint configuration` (missing type), `feat: Adding ESLint config and a comprehensive set of JSDoc comments to the whole repo` (too long, gerund instead of imperative), `Update files` (missing type, vague).

If the title fails any of those checks, **post one comment** that names the failure (missing type, wrong tense, too long, missing colon, etc.) and suggests a corrected title. This is one of the few things you should *always* comment on — it can't be fixed after merge.

## What NOT to comment on

Do not post a comment for any of the following. These waste the author's time and create review loops:

- **Style / formatting / naming preferences.** Renaming `foo` to `fooValue`, "consider using an arrow function", "prefer `const` here" — skip.
- **"Could be clearer" / "consider extracting a helper" / "this is a bit long".** Subjective readability is not your call.
- **Missing comments, docstrings, or log lines** unless the absence actively hides a bug. The repo has its own conventions for when to document; trust the author.
- **Minor duplication** (three similar lines, two `if`s that could be one). Premature abstraction is worse than repetition.
- **Test organization nits** (split this test, rename that one, add one more edge case). Only comment if a test is *incorrect*, not if it's merely incomplete.
- **Dependency-version suggestions** unless there's a known CVE in the pinned version.
- **"You could also use library X"** — the author already chose the approach.
- **Inconsistency with other files** unless the inconsistency causes a bug.
- **Preference between two equally valid patterns** (e.g. guard clause vs. nested if, `for` vs. `map`).
- **Speculative future problems** ("what if someone later…"). Today's code, today's problems.
- **Restating what the code already makes obvious.**

If a comment would fit into any of the categories above, **do not post it**. Silence is a valid review outcome.

## How to phrase comments you do post

- Open with the failure mode, not the suggestion. "`req.path.startsWith('/api')` misses the exact path `/api`, so `GET /api` returns the SPA instead of Nest's 404" is useful. "Consider also handling `/api`" is not.
- Keep them short. Two or three sentences. Link to a line if the bug depends on context elsewhere.
- Suggest *a* fix, don't dictate *the* fix. The author knows the codebase better than you do.
- Never post a summary comment or a "reviewed files" table unless specifically asked.

## Repo-specific context

- **Framework**: Nest.js (on `@nestjs/platform-express`) + TypeScript backend, React/Vite frontend, Pulumi (Automation API, TypeScript) + AWS.
- **DI**: Nest's built-in `@Injectable()` providers. Do not suggest switching to tsyringe, InversifyJS, or manual wiring — we just migrated off tsyringe deliberately.
- **ESLint runs in CI.** Don't post style comments the linter would catch — those will surface in the lint job. Do flag genuine bugs the linter misses. There is no `tflint` job — the `terraform/` tree was deleted; the infra program is TypeScript, linted by the same ESLint job as everything else.
- **Test naming**: `it('should …')`. Don't suggest `it('does …')` or the reverse — the repo convention is `should`.
- **No `as unknown as T` casts in tests.** Prefer `vi.mocked(fn)` or `Partial<T>` + single `as T`.
- **ESM-only.** The project is `"type": "module"`. Imports must use `.js` extensions. Don't suggest removing them.
- **Squash-merge.** See "PR title check" above — title becomes the commit subject on `main`, so it must be a Conventional Commit. Always check it.
- **`DeploymentConfig.gameServers` (the JSON configuration object) is the single source of truth.** Don't suggest hand-writing per-game resources — `app/packages/infra`'s resource-defining functions all loop over this map internally.
- **DNS is Lambda-managed, not infra-program-managed.** Don't suggest adding a per-game `aws.route53.Record` to `app/packages/infra`.
- **Watchdog state lives in ECS task tags.** Don't suggest adding DynamoDB / SSM / Redis for this.
- **Lambda env var `AWS_REGION_`** (trailing underscore) is intentional — `AWS_REGION` is reserved by the Lambda runtime. Don't suggest renaming.

## When in doubt

Skip the comment. A missed nitpick costs nothing. A noisy review burns author time and trust.

## Commit Structure

All commits will follow the conventional commit format. The commit message should be structured as follows:

```<type>(<scope>): <subject>
<body>
```

Where:
- `<type>` is one of the following: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`, `style`.
- `<scope>` is an optional component that provides additional context about the commit (e.g., `api`, `ui`, `infra`).
- `<subject>` is a brief description of the change.
- `<body>` is an optional component that provides a more detailed description of the change, including the motivation and any relevant context.

