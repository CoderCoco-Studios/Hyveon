# Verification Report: add-per-game-cost-tags

## Summary

| Dimension    | Status                                                        |
|--------------|----------------------------------------------------------------|
| Completeness | 14/14 tasks complete; 2/2 requirements, 6/6 scenarios covered   |
| Correctness  | 2/2 requirements implemented and test-covered                  |
| Coherence    | Design decisions (D1-D3) followed; no contradictions found     |

Full local verification gate (this session): `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` all pass clean — 168 test files, 2992 tests, 0 failures.

## Completeness

**Task completion:** `tasks.md` — 14/14 checked off (`[x]`), matching commits:
- 1.1-1.3 (Pulumi tags on ecs.ts/lambdas.ts) — commits `2fd998b1`, `e9955a1b`
- 2.1-2.2 (RunTask propagateTags, both call sites) — commit `cf0d3a30`
- 3.1-3.4 (test coverage, incl. the fix-round addition of interactions/watchdog/dns-updater tag assertions) — commits above + `da172079`
- 4.1-4.2 (docs) — commit `3f1eedd8`, refined in `da172079`
- 5.1-5.3 (verification gates) — re-run clean in this session

**Spec coverage:** `specs/cost-visibility/spec.md` — both ADDED requirements, all 6 scenarios, map to committed code + tests:
- "ECS task definition tagged per game" → `app/packages/infra/src/ecs.ts:221`, asserted `ecs.test.ts:141`
- "Per-game CloudWatch log group tagged per game" → `ecs.ts:132`, asserted `ecs.test.ts:99`
- "EFS-seeder Lambda tagged per game" → `app/packages/infra/src/lambdas.ts:759,786`, asserted `lambdas.test.ts`
- "Shared resources are not tagged per game" → cluster/security groups/DynamoDB/4 project-wide Lambdas/EFS untouched; negative-case assertions in `ecs.test.ts`, `securityGroups.test.ts`, `dynamodb.test.ts`, `efs.test.ts`, and (after the fix round) exact `tags` assertions for interactions/watchdog/dns-updater in `lambdas.test.ts`
- "Launching from the desktop app" → `AwsCloudProvider.ts:459` (`propagateTags: 'TASK_DEFINITION'`), asserted `AwsCloudProvider.test.ts`
- "Launching from Discord `/start`" → `handler.ts:147` (followup Lambda `runStart`), asserted `handler.test.ts`

No CRITICAL completeness issues.

## Correctness

Both requirements are implemented per their literal wording (tag key `Game`, value = game id, applied only to the enumerated per-game resources; both independent `RunTask` call sites propagate it).

One implementation gap was caught by the final whole-branch review and fixed in this session, not left for verify to catch cold:
- The followup Lambda's IAM role lacked `ecs:TagResource`, which `RunTask` requires when tag propagation is requested. Without it, the Discord `/start` path would have started failing with `AccessDenied` the moment this change shipped. Fixed in commit `7fce84c3` (scoped grant + `iam.test.ts` update), re-reviewed clean.

No open CRITICAL or WARNING correctness issues.

## Coherence

`design.md` decisions D1 (separate `Game` tag key), D2 (only independently-metered resources), and D3 (both `RunTask` call sites, since neither calls the other) are all followed exactly by the landed code — no contradictions between design intent and implementation.

**SUGGESTION (non-blocking, out of scope for this change):** the final whole-branch review noted that `FileManagerService.launch` (`app/packages/desktop-main/src/services/FileManagerService.ts`) registers a per-game FileBrowser ECS task definition and log group at runtime, which is not tagged with `Game` and is not covered by this change's Non-Goals (the design's Non-Goals list only excludes EFS, in-app UI, retroactive tagging, and shared resources — FileBrowser simply wasn't enumerated). Since the plan's Global Constraints scoped this change to exactly ECS task definitions/log groups and the EFS-seeder Lambda, expanding scope mid-implementation was declined. Recommend a small follow-up change if per-game FileBrowser cost visibility matters in practice.

## Final Assessment

No CRITICAL or WARNING issues open. All checks passed (with one correctness gap found and fixed during implementation, not deferred). **Ready for archive.**
