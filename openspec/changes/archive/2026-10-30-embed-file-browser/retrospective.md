# Retrospective: embed-file-browser

> Written: 2026-10-30 (after verify passed with warnings)
> Commit range: `2822efd1..6e3fd043`, plus the PR 6 close-out commit
> Worktree: `worktrees/embed-file-browser-6-closeout` (stack #697, PRs #694 → #695 → #696 → #698 → #699 → PR 6)

---

## 0. Evidence

- **Commit range**: `2822efd1..6e3fd043` (76 commits, plus the close-out commit)
- **Diff size**: +13587 / −2139 lines across 152 files
- **Tasks done**: 42/44 `[x]`, plus 2 `[~]` (6.1 infra apply, 6.2 dogfood; both deferred manual checks, see verify.md §7)
- **Active hours**: about 4 days of calendar time (2026-10-26 → 2026-10-30), across one session per PR plus the review rounds
- **Subagent dispatches**: subagent-driven execution for PRs 1–5 (one implementer plus review per plan task, 24 plan tasks); close-out used 1 verify research agent and 1 independent review agent
- **New external dependencies**: none (the `filebrowser/filebrowser` image was re-pinned from `:latest` to `v2.63.23@sha256:a469…`)
- **Bugs encountered during this cycle**: 31 `fix(...)` commits. Most came from task-level and CodeRabbit review. The notable classes:
  - Async ordering: grace kept after an upload releases (`91a0d55d`, `9a53f5ff`); hold acquired after a cancel (`e4e58fa8`); stale hook results (`73e1fc0d`, `2456844d`).
  - Fail-closed edges: unresolved ECS lookups (`32ee4620`); legacy single-volume fallback (`58703bdd`).
  - Start gating: start refused while an upload holds the game (`3905c343`); downloads no longer block a start (`9c292e02`); start gate kept until cancelled uploads settle (`b49c2f80`).
  - Secret and address leaks into errors (`9bbaf0f2`, `aa86bfe4`).
  - Close-out: two error texts told the operator to "Restart" with no Restart control (`e5adbecd` on PR 4, `3ee2e6af` on PR 3).
- **OpenSpec validate state at archive**: pass (47/47 before archive)
- **Test coverage signal**: vitest 4559 passed / 1 todo across 229 files, plus tier-2 integration and the Playwright chromium and electron specs added in PRs 2–5

Commit chain (chronological, abridged):

```
2fc4ff7b refactor(shared): add volume path validator subpath
...      PR 1 backend interface + pin → db4091d0
82ede00a feat(infra): export every volume's EFS access point
...      PR 2 multi-volume + #672 fix → 89f02aa6
e083746f refactor(desktop-main): expose helper launch and IP re-authorization primitives
...      PR 3 registry → 3ee2e6af
e16098cd feat(shared): add volumeFiles IPC types
...      PR 4 IPC → e5adbecd
2633284b feat(web): add volume session and listing hooks
...      PR 5 page → 6e3fd043
<close-out> chore(openspec): close out the embed-file-browser change
```

---

## 1. Wins

- The fail-closed server check was designed in up front (D7 / Open Question 9) and applied to both the Files page and the folder-upload preflight. Review then found two more unconfirmed-state edges (`32ee4620`, `58703bdd`), and they slotted into the same `server-check-failed` path with no redesign.
- The `VolumeFileBackend` seam held. PRs 2–5 never called FileBrowser directly, which made the 6.4 follow-up (#700) a desktop-main-only change by construction.
- The #672 wrong-volume upload bug was fixed in the PR that introduced multi-volume mounts (D13), with a second-volume regression test (`FolderUploadService.test.ts`, `FolderUpload.integration.test.ts`). No interim build mounted several volumes while still writing to the first.
- Secret-boundary assertions run at every tier: `34823d03` adds a Playwright check that no IPC payload carries credential, IP or URL fields, on top of the unit-level scrubbing in `aa86bfe4`.

## 2. Misses

- 🟡 [painful | evidence: `3905c343`, `9c292e02`, `b49c2f80`] The "start the server while an upload holds the helper" interaction wasn't in the design. It was discovered in CodeRabbit round 2 on PR 4 and took three fix commits to settle (refuse the start; exempt downloads; keep the gate until cancelled uploads settle). The holder model in D3 (`Set<'browse'|uploadRunId>`) was too coarse to express it, and the spec had no scenario for it until the close-out reconciliation.
- 🟡 [painful | evidence: verify.md §4 item 2, `e5adbecd`] The design and spec promised a "Restart action" for an unreachable helper, but the UI only ever offered Restart for `orphaned`. The error text, written in PR 4, told the operator to "Restart the session" with no matching button. This wasn't caught until close-out verify, because PR 4's review couldn't see the PR 5 session bar and PR 5's review didn't re-read PR 4's message strings.
- 🟡 [painful | evidence: verify.md §7] There is no automated coverage for real OS drag-and-drop through `webUtils.getPathForFile` in the sandboxed preload. The chromium e2e uses an in-page fake, and the electron smoke test only renders the page and clicks Start. Follow-up: the operator checks it during the 6.2 dogfood. If it fails, add an electron-project spec that dispatches a synthetic drop with a real temp file.
- 🟡 [painful | evidence: verify.md §7] `electron-updater` `quitAndInstall` with an owned helper isn't tested together with the quit hook. Squirrel.Mac's handling of a delayed `before-quit` is unverified. Follow-up: the operator checks it during the 6.2 dogfood, on macOS if one is available.
- 📌 [nit | evidence: verify.md §4] UI labels drifted from spec text ("Start session" → "Start", "Restart session" → "Restart"), as did one design phrase ("catch-and-log wrapper" vs a swallowing wrapper). All were reconciled at archive.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Groups 2–5 (renumbered 2026-10-26) | Multi-volume mounting and the #672 fix got their own PR, so the stack grew from 4 to 5 implementation PRs | Operator decisions 7/8: every volume in v1, with the #672 fix in-stack |
| 3.2 / 4.5 holder model | `'browse' \| uploadRunId` became `'browse' \| 'upload:<id>' \| 'download:<id>'` | Page transfers needed their own holds; downloads must not block a game start |
| 4.x (CodeRabbit) | Added the `games.start` refusal while an upload holds the game | Starting the server mid-upload mounts the volume while files are being written |
| 5.x (CodeRabbit) | Stop confirms while a download is running, not only an upload | A Stop silently aborting a download was surprising |
| 6.3 | Close-out included message-text fixes on PR 4 (`e5adbecd`) and PR 3 (`3ee2e6af`), with PRs 4 and 5 restacked | Verify and the independent review found error texts pointing at a nonexistent Restart control; the operator chose to fix them in the owning PRs |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (`brainstorm.md`) |
| superpowers:writing-plans                        | ✓ (`plan.md`) |
| superpowers:using-git-worktrees                  | ✓ (one Pane worktree per PR) |
| superpowers:subagent-driven-development          | ✓ (PRs 1–5; the close-out was inline per its brief) |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review  | ✓ (task-level and final reviews, plus an independent review of the close-out diff) |
| superpowers:finishing-a-development-branch       | ✓ (each PR via `/pr` and gh-stack) |

### Deliberately Skipped Skills

None.

## 5. Surprises

- The PR 4 and PR 5 Pane worktree directories were gone by close-out (PR 4's had only `.remember`, and PR 5's was missing). The PR 3 and PR 4 message fixes and the PR 4/PR 5 restacks were done from the PR 6 worktree on a detached HEAD, then pushed (fast-forwards for each new fix commit, `--force-with-lease` for each restacked branch). The local branch refs were moved with `git update-ref`.
- Spec text that names a UI control ("Start session", "Restart action") is a contract that two different PRs implement halves of. Neither PR's review owns the whole.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Close-out verify should diff user-facing strings against the controls that exist.** An error message that names an action ("Restart the session") needs a matching control in the state where the error appears. → **Promote to** memory (type: feedback)
  > **Why**: `e5adbecd`. PR 4 wrote "Restart the session" and PR 5's session bar offered Restart only for `orphaned`, and no single PR review saw both.
  > **How to apply**: in a stacked change where one PR writes messages and a later PR renders controls, the later PR's review (or the close-out verify) greps the message strings for action verbs and checks each against the UI's state → action table.
- [ ] 🟡 **Model session holders by kind from the start when transfers of several kinds share a resource.** → **Promote to** one-off (record only)
  > **Why**: three CodeRabbit-driven fix commits on PR 4 (`3905c343`, `9c292e02`, `b49c2f80`) came from `holders: Set<'browse'|uploadRunId>` being unable to distinguish an upload from a download.
  > **How to apply**: when a design introduces a reference-counted shared resource, list which holder kinds block which other operations (here: an upload blocks a game start, a download doesn't) in the design decision itself.
