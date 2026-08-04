# Contributing

Thanks for working on this repo. The goal of this doc is to keep the surface area
small: a few rules that, if followed, make PRs easy to review and easy to merge.

## PR titles (squash-merge format)

We **squash-merge** every PR. The PR title becomes the commit subject on `main`
verbatim — a badly-formed title produces a badly-formed commit that can't be
fixed after merge. The title MUST follow Conventional Commits:

```
<type>(<optional-scope>): <imperative summary>
```

- `<type>` is one of: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`,
  `build`, `ci`, `style`.
- `<scope>` is optional and identifies the area (`app`, `server`, `web`,
  `watchdog`, `infra`, `lambda`, etc.).
- `<imperative summary>` reads like a command: "add", "fix", "remove" — not
  "added", "adding", or "this PR adds".
- Keep the whole subject under ~70 characters. Put details in the PR body.

**Good**

- `feat(server): add /api/games endpoint`
- `fix(watchdog): stop leaking tags on failed runs`
- `refactor(app): migrate server from Express+tsyringe to Nest.js`
- `docs: reflect Nest.js migration in CLAUDE.md`
- `chore: add ESLint flat config`

**Bad** (and why)

- `Add ESLint configuration` — missing type.
- `feat: Adding ESLint config and a comprehensive set of JSDoc comments` —
  gerund (`Adding`) instead of imperative (`add`); too long.
- `Update files` — missing type, vague.
- `feat(server): Added new endpoint.` — past tense and trailing period.

## Commit messages

Individual commits within a PR don't need to be Conventional Commits (the squash
merge replaces them with the PR title). But if you do write them in
Conventional Commits style, that's fine — see the format above.

## Local checks before opening a PR

From the repo root (a single npm-workspaces tree — there is no separate
`terraform/` directory to run tooling from any more; infrastructure is a
Pulumi program under `app/packages/infra`, exercised by the same Vitest/ESLint
commands as the rest of the app):

```bash
npm run app:lint         # ESLint over app/** (desktop-main, desktop-preload, web) — not the scripts workspace
npm run app:typecheck    # builds shared/cloud-aws/infra/desktop-preload/desktop-main, then tsc --noEmit over web, every Lambda, and scripts
npm run app:test         # Vitest over app/** (desktop-main, desktop-preload, web) — not the scripts workspace's own test
npm run app:build        # shared → infra → cloud-aws → desktop-main → desktop-preload → web
```

CI runs `app:lint` and `app:typecheck` as above, plus `app:test:coverage`
(Vitest with coverage) in place of plain `app:test`; running the local
commands first still means a faster review loop.

## What CI checks

- **eslint** (`.github/workflows/lint.yml`) — flat config at
  `app/eslint.config.js`, recommended TypeScript / React / React-hooks presets
  plus `eslint-plugin-jsdoc` (require docs on public symbols) and
  `eslint-plugin-tsdoc` (TSDoc syntax).
- **typecheck** (`.github/workflows/lint.yml`) — `npm run app:typecheck`,
  building the packages whose declarations the rest depend on and then
  running `tsc --noEmit` over web, every Lambda package, and scripts.
- **test** (`.github/workflows/test.yml`) — `npm run app:test:coverage`
  (Vitest) across `app/**`; the `scripts` workspace's own test file isn't
  part of this run.
- **CodeQL** — security analysis on JS/TS and Actions, via GitHub's default
  code-scanning setup rather than a checked-in `.github/workflows` file.

There is no Terraform/tflint CI job — the `terraform/` directory and its
tflint config were removed as part of the `migrate-iac-to-pulumi` change; the
Pulumi program under `app/packages/infra` is typechecked and unit-tested
alongside the rest of the app instead.

## Code conventions

The detailed code/test conventions live in
[`CLAUDE.md`](./CLAUDE.md#code--test-conventions) — read that for things like
test naming (`it('should …')`), TSDoc style, and the no-`as unknown as T`
rule. Also check the architecture section there before changing anything in
`app/packages/infra` or the Lambda packages, since several behaviours look
removable but are load-bearing (DNS being Lambda-managed, watchdog state in
ECS tags, the `AWS_REGION_` env var quirk, etc.).

## PR review

We follow a strict "decline most nitpicks" policy on bot reviews — see the
"PR Review Workflow" section in `CLAUDE.md`. The same applies to human reviews:
flag bugs, security issues, and contract breaks; let style live.
