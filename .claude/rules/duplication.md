# Duplication

## The second copy is the review gate

1. When a method, component, or resource block differs from an existing one only by an
   identifier, a channel prefix, or a resolved name, extract the shared body **before**
   opening the PR — do not wait for a reviewer to ask. Threshold: **≥3 occurrences, or ≥2
   with a non-trivial body**.
2. Name the extraction in the PR body so the reviewer can check it rather than find it.
3. Extract at **every** layer the pair crosses, not just the first one found. PR #538 fixed
   `LogsService` but left the identical pair in `logs.controller.ts` and `preload.ts` — the
   duplication survived the review meant to kill it.
4. If a comment says "mirrors X", "duplicates X", or "keep this copy in sync with X", stop.
   That comment is the bug report, not a mitigation.

**Why:** this is the single most-repeated review comment in Hyveon's PR history — PR #538
("seeing some duplication between the lambda and non lambda get log calls. Can we extract
common functionality out into shared class functions?") and PR #537 ("byte-for-byte identical
… across three call sites") — and the fix is always cheaper before the diff is written than
after.
