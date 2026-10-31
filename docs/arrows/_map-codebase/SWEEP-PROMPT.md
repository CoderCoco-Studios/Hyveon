# Sweep worker instructions (brownfield LID mapping, Phase 1)

You are a reconnaissance subagent for a brownfield mapping operation on the Hyveon repo (worktree at /home/chris/GitHub/Hyveon/worktrees/lid-conversion — run everything from there, never cd to the main checkout). Your job is to **read every file** in your assigned scope and produce a structured per-file report. Do not segment, cluster, or design — that happens later.

Read file contents with `cat`/`sed -n` or the Read tool. Use `git ls-files <scope>` to enumerate your scope exactly. Do NOT skip files because they look like boilerplate, tests, or config. Test files: still read them, but you may summarize a test file in 1-2 lines focused on *which behaviours it pins down*.

## For each file, record one entry:

```yaml
- path: {relative path from repo root}
  purpose: {one line}
  exports: {functions, classes, types, IPC channels, endpoints exposed}
  dependencies: {specific internal modules / symbols + notable external libs}
  data_shapes: {structures produced/consumed, briefly}
  side_effects: {filesystem, network, AWS, electron-store, logs, IPC — "none" if pure}
  role: {UI component / IPC controller / Nest service / Lambda handler / Pulumi resource definer / config / test / docs / script / etc.}
  observations: {unusual things with file:line — TODOs, deprecated comments, duplication, tight coupling, references to missing code, behavioural quirks}
```

## Constraints
- Read every file in scope. Read actual content, not filenames.
- Cite file:line for observations.
- Don't infer design intent; describe what the code does. "Appears to…" when unsure.
- Group entries under `## <directory>` headings.
- At the END of the file add a section `## Observed behaviours` — a flat bulleted list of notable runtime behaviours / invariants you saw, each with file:line references (e.g. "DNS record is DELETEd on task STOPPED — app/packages/lambda/update-dns/src/handler.ts:88"). Aim for 20-60 bullets.
- Then a `## Cross-scope references` section: things in your scope that call into, or are called by, areas outside your scope (name the module/symbol).

## Output
Write the report to the path given by the orchestrator. Do not emit the report inline. End your response with a 3-5 line summary: files read, files you couldn't read, scope ambiguities.
