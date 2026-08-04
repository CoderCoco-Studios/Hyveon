---
name: write-docs
description: Write or update the Hyveon Docusaurus documentation under docs/docs/**. Use this skill whenever a change needs documenting, whenever the user mentions docs, documentation, the docs site, a setup guide, a component page, an architecture page, or a README-style walkthrough for this repo, and whenever you are about to open a PR that changed behaviour — even if the user never says the word "documentation". It maps changed code to the pages that must be updated, drafts them through a writer subagent, and runs three evaluator subagents (accuracy, coverage, style) over the result before you call it done.
---

# Writing Hyveon docs

Docs in this repo are not a nice-to-have. `CLAUDE.md` deliberately contains almost
no architecture — it routes to OpenSpec and to `docs/`, so a stale docs page
directly misleads the next agent (and the operator following the setup guide).
That is the reason for the verification pressure in this skill: a confidently
wrong docs page is worse than a missing one.

## Scope

**In scope:** everything under `docs/docs/**` — the Docusaurus site.

**Out of scope, route elsewhere:**

| Surface | Use instead |
|---------|-------------|
| `openspec/specs/**`, `openspec/changes/**` prose | `/opsx:propose`, `/opsx:update`, `/opsx:sync` |
| `CLAUDE.md` | `claude-md-management:claude-md-improver` |
| Code comments / TSDoc | ordinary editing — see the conventions in `CLAUDE.md` |

## Workflow

### 1. Establish the footprint

Never start from a blank page. Start from what changed:

```bash
git diff origin/main...HEAD --name-only     # or the base ref the user names
```

Map changed paths to the pages that own them:

| Changed | Page that must be updated |
|---------|---------------------------|
| `app/packages/infra/**` | `docs/docs/components/infra.md`; `docs/docs/setup.md` too if an operator must configure it |
| `app/packages/lambda/**` | `docs/docs/components/lambdas.md` |
| `app/packages/{desktop-main,desktop-preload,web,cloud-aws,shared}/**` | `docs/docs/components/management-app.md` |
| A renderer page or its controls (`app/packages/web/src/pages/**`, wizard components) | the matching page under `docs/docs/app/` — these are the operator-facing walkthroughs, and they embed the generated screenshots |
| Packaging, `electron-builder.yml`, the updater | `docs/docs/install.md` |
| `app/packages/web/e2e/**`, vitest/playwright configs, test harnesses | `docs/docs/components/integration-tests.md` |
| The `HyveonDeployAll` IAM policy, any new AWS action | `docs/docs/setup.md` (single source of truth for the policy) |
| A cross-cutting invariant or control loop | `docs/docs/architecture.md` |
| Anything an operator does by hand | `docs/docs/guides/user.md` or `guides/maintainer.md` |

If a change touches an area with no obvious owner page, say so and propose where
it belongs rather than wedging it into the nearest page — the site is small enough
that a new page is often correct, and `docs/docs/components/index.md` is where new
component pages get listed.

Read the relevant `openspec/specs/<capability>/spec.md` before drafting. Specs
state required behaviour precisely; docs explain it. Docs that contradict a spec
are a bug in the docs.

### 2. Draft through the writer subagent

Dispatch `docs-writer` (one per page, in parallel when pages are independent).
Drafting means reading a lot of code and emitting a lot of prose — neither needs
to occupy the orchestrating context.

Give each writer:

- the exact page path, and whether it is a new page or an edit
- the diff range and the specific changed files it must document
- the relevant spec paths
- what the reader is trying to do on that page (operator setting things up?
  maintainer debugging? agent looking up a variable?)

The writer returns a summary plus the source references it verified against. It
does not return the prose — read the file if you need it.

### 3. Review through the three evaluators, in parallel

Dispatch all three in a single message. They are read-only and each has one lens,
which is what keeps their reports specific:

| Agent | Asks |
|-------|------|
| `docs-accuracy-auditor` | Is every claim on this page true of the code as it exists right now? |
| `docs-coverage-auditor` | Did this change update everything it was obliged to update? |
| `docs-style-reviewer` | Will this build, navigate, and read like the rest of the site? |

Give each of them, explicitly: `base ref: <ref>` — the same ref you diffed against
in step 1 — plus the list of pages touched and the changed code files. Say the ref
rather than assuming they will recompute it; on a stacked branch or a custom base,
an evaluator that guesses `origin/main` audits the wrong range and reports clean.

### 4. Apply findings

- **Accuracy findings: fix all of them.** A wrong claim is the failure mode this
  whole workflow exists to prevent.
- **Coverage findings: fix or explicitly justify.** "That page genuinely doesn't
  change" is a legitimate answer — say it out loud rather than skipping silently.
- **Style findings: use judgment**, except anything that breaks the build
  (see gotchas) which is not optional.

Re-run `docs-accuracy-auditor` only if you changed factual claims while applying
fixes. Re-running all three on a cosmetic edit is waste.

### 5. Verify

```bash
npm --prefix docs ci            # install precondition — see below
npm --prefix docs run build     # catches broken links and MDX parse errors
```

Build against a clean install. An incremental `docs/node_modules` that has fallen
out of step with `docs/package.json` fails SSG for *every* page with
`Cannot read properties of undefined (reading 'id')` — an install artifact that
looks alarmingly like a content error and has sent at least one agent chasing a
phantom. `npm ci` first and the signal is trustworthy.

Treat a build failure as yours until you have proven otherwise, and do not claim
the site builds when you have not seen it build. Reporting a real error as
"pre-existing" is the single worst outcome of this step: the build is the only
check that catches a broken link, and `onBrokenLinks` is `throw`.

## House conventions

- **Frontmatter on every page**: `title` and `sidebar_position`. The sidebar is
  autogenerated from the directory tree (`docs/sidebars.ts`), so ordering comes
  from `sidebar_position`, and a new directory needs a `_category_.json` with
  `label`, `position`, and a `link` to its index doc.
- **Internal links are root-relative without a `/docs` prefix** —
  `[Infra program](/components/infra)`. `routeBasePath` is `/` and `baseUrl`
  (`/Hyveon/`) is applied automatically. `onBrokenLinks` and
  `onBrokenMarkdownLinks` are both `throw`, so a wrong link fails the build.
- **Voice**: second person, present tense, concrete. Match the page you are
  editing — these docs favour tables over prose lists, short paragraphs, and
  copy-pasteable fenced commands with a comment above each explaining why.
- **Explain the why, not just the what.** The pages that earn their keep are the
  ones stating *why* something is the way it is (why no ALB, why DNS is
  Lambda-managed, why watchdog state lives in task tags). Anyone can re-read the
  code for the what.
- **Screenshots under `docs/static/img/app/` are generated** by
  `npm run docs:screenshots` — never hand-place files there. Reference them as
  `/img/app/<name>.png`.
- **Mermaid diagrams** are available (`@docusaurus/theme-mermaid`) via ```mermaid
  fences — prefer one over a paragraph describing a flow.

## Gotchas

- `.md` files are parsed as MDX. A bare `{` or `<` outside a code fence is a parse
  error — wrap identifiers like `{game}-server` or `Partial<T>` in backticks.
- Don't duplicate `openspec/specs/**` requirement wording into docs. Link to the
  behaviour and explain it; two copies drift and the spec is the one that wins.
- Don't restate what `CLAUDE.md` covers (workflow rules, PR conventions). The
  arrow points the other way: `CLAUDE.md` points at docs.
- Adding a new component page means also adding it to
  `docs/docs/components/index.md`, and to the routing table in `CLAUDE.md`.
