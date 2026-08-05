---
name: scan-vocabulary
description: Deterministically sweep the whole repo for leftover references to specific terms — old class/service names, retired tooling vocabulary (e.g. "terraform", "tfvars"), a deprecated env var, a renamed field — using a parallel worker_threads scanner instead of ad hoc grep. Use this to independently verify a rename/removal actually reached every file before calling a cleanup complete, or any time you need a repeatable, reviewable "did we miss anything" pass over the codebase.
---

# Scanning for leftover vocabulary

`scan-vocabulary.mjs` in this skill's directory is a deterministic, dependency-free
Node script that scans every non-binary file under a root directory for one or more
search terms, using `worker_threads` to parallelize across CPU cores. Re-running it
against an unchanged tree always produces the same report — file, then line, then
column — which is what makes it useful as a verification gate rather than a one-off
grep: the output is reviewable and diffable across runs.

Reach for this whenever you (or a prior session) claim "we renamed X everywhere" or
"Y is fully removed" and want a ground-truth check that isn't just "the agent said
so". This repo's post-Pulumi-migration Terraform/tfvars naming cleanup needed five
independent validation rounds before a sweep came back clean — each round's
self-reported "found everything" turned out incomplete on the next check. That
pattern is the reason this tool exists: repeated independent sweeps converge toward
zero rather than hitting it in one shot. This tool is the fast, mechanical first
pass; a human or an agent still has to read the matches and judge which are real gaps
versus legitimate (e.g. a comment correctly explaining old-name history).

## Running it

```bash
node .claude/skills/scan-vocabulary/scan-vocabulary.mjs <rootDir> --terms=term1,term2,... [--boundary=term1] [--json]
```

- `<rootDir>` — directory to scan (required, positional). Usually the repo root.
- `--terms` — comma-separated search terms (required). Case-insensitive substring
  match by default.
- `--boundary` — comma-separated subset of `--terms` to search with **word-boundary**
  matching instead of plain substring, for short/generic terms (2-4 letters) that
  would otherwise produce noise matching inside unrelated words. Also auto-generates
  a PascalCase word-segment variant, so a boundary term like `tf` additionally catches
  camelCase identifiers such as `TfOutputs`/`getTfOutputs` that a strict boundary
  check alone would miss.
- `--json` — emit the full match list as JSON instead of a human-readable report.

Examples:

```bash
# Simple sweep for a couple of retired terms, plain substring for both
node .claude/skills/scan-vocabulary/scan-vocabulary.mjs . --terms=terraform,tfvars

# Same, but "tf" is short/generic enough to need boundary matching to avoid
# matching inside unrelated words (plain substring would hit "outfit")
node .claude/skills/scan-vocabulary/scan-vocabulary.mjs . --terms=terraform,tfvars,tf --boundary=tf

# Verify a class rename reached everywhere
node .claude/skills/scan-vocabulary/scan-vocabulary.mjs . --terms=OldServiceName
```

## What it excludes by default

- `node_modules`, `.git`, `dist`, `out`, `release`, `coverage`, `.docusaurus`,
  `.cache`, `.turbo`, `.next` — build output and vendored code, never source.
- `.claude/worktrees`, `.worktrees` — nested worktree copies of this same repo (would
  otherwise multiply every result and slow the scan down enormously).
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` — machine-generated lockfiles
  whose base64/hex integrity hashes produce meaningless matches, especially for short
  boundary terms (a hash substring coincidentally containing "Tf" is not a reference
  to anything).
- Common binary/asset extensions (images, fonts, archives, `.wasm`, `.map`, `.lock`).

If a future sweep needs a different exclusion, edit the `EXCLUDED_DIR_NAMES`,
`EXCLUDED_PATH_PREFIXES`, `EXCLUDED_FILE_NAMES`, or `BINARY_EXTENSIONS` sets at the top
of the script directly — there's no config file layer, the constants are the config.

## Workflow for a "did we miss anything" check

1. Run the scan with `--json` and the terms/boundary set appropriate to what you're
   verifying.
2. Read every match — don't skim. Classify each as: (a) legitimate (an accurate
   historical/provenance comment, a deliberately-out-of-scope term), (b) a real gap
   that needs fixing, or (c) genuinely ambiguous and worth a second opinion.
3. Fix every (b). Re-run the scan on the fixed state — a clean rerun (only (a)/(c)
   remaining) is the actual completion signal, not the first pass's absence of
   obviously-wrong hits.
4. If the same handful of files keep reappearing as "legitimate" across runs (e.g. a
   resource-mapping table that's supposed to cite old names as history), that's a
   sign to hardcode that specific allowlist into your own review notes for next time
   — but resist baking a permanent allowlist into the script itself; what counts as
   "legitimate" is specific to each sweep's terms and this repo's history at the time,
   not a fixed property of a file path.
