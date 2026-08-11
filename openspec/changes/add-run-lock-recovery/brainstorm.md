<!--
Raw capture of superpowers:brainstorming output.

This file captures the brainstorming skill's output as-is, without enforcing
structure. The skill's natural output is usually a decision-log format
(context → decision chain Q1-Qn → design trade-offs), but the actual
organization may vary depending on the conversation.

design.md extracts from this file and reorganizes it into a structured
design document.

Do not copy this file's content into design.md — design.md is an
independently reorganized artifact; the two are complementary, not
overlapping.
-->

## Background

An infra `apply` got stuck live (2026-08-10) with:

> Workspace busy — an apply run is already in progress. Try again once it finishes.
> Run lock already held by "chris" (apply, runId "786b631e-5e4e-449c-96a2-29b4ec1d880e").

Investigation (Explore agent) found the app already has **two distinct locks**, only
one of which has an operator recovery path:

1. **Pulumi backend lock** — Pulumi's own S3-state-backend lock. Fully wired:
   `PulumiService.clearStaleLock(token)` (`PulumiService.ts:4602`), IPC channels
   `iac.lock.clear.mintToken` / `iac.lock.clear` (`iac.controller.ts:1112`/`:1606`),
   preload bridge (`preload.ts:796-798`), and a `StaleLockBanner` UI with a
   "Clear lock and retry" action gated behind a `ConfirmDialog`
   (`iac.page.tsx:279`).
2. **`RunService` durable apply lock** (`RunLock`, issue #106) — an in-memory +
   DynamoDB-backed lock guarding submission-level exclusivity across
   plan/apply/destroy. **No clear path anywhere**: no service method, no IPC
   channel, no preload exposure, no UI action. Only self-heals via TTL
   (`DEFAULT_LOCK_TTL_MS` = 1 hour, `isRunLockExpired`).

This is the lock the operator actually hit. Confirmed by reading
`iac.controller.ts:993-1005`: a `RunLockHeldError` is mapped to
`{ conflict: 'up' }` (driving the amber `BusyBanner`, "Workspace busy...") AND its
raw `.message` is surfaced separately as an `ErrorBanner` ("Run lock already
held by...") — so the two boxes in the operator's screenshot are **one
rejection rendered twice**, not two independent stuck locks.
`PulumiService.operationInFlight` (the separate in-process Pulumi-workspace
busy flag) was NOT also stuck — only `RunService`'s lock was. This rules out
needing to touch `operationInFlight` at all; the fix is scoped entirely to
`RunService`.

Immediate unblock used at the time (documented for context, not part of this
change): manually deleted the DynamoDB lock item (`pk=LOCK, sk=CURRENT` in the
`<projectName>-runs` table) via `aws dynamodb delete-item`, plus a desktop app
restart to reset the in-memory flag.

## Decision chain

**Q1: When should the operator be able to see/clear a stuck RunLock — reactive
(only after a rejected submission, matching the existing Pulumi-lock pattern)
or proactive (a new status-read channel so it's visible on page load)?**

→ **Reactive only.** Matches the existing `StaleLockBanner` pattern exactly:
no new read channel, smallest change, fully consistent with precedent. The
clear action appears only after a plan/apply/destroy submission is rejected
with `RunLockHeldError`.

**Q2: Should the confirmation token's TTL reuse `PulumiService`'s
`LOCK_CLEAR_CONFIRMATION_TTL_MS`, or get its own constant?**

→ **Own constant, same initial value.** `RunService` gets
`RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS`, initially equal to the Pulumi lock's TTL
but independently tunable — the two locks are conceptually distinct
(durable submission-level lock vs. Pulumi backend state lock) and happen to
share a value today, not by design coupling.

**Q3: Design review — approved as follows.**

## Design (approved)

**Architecture** — mirrors the existing Pulumi-lock mint/confirm/clear flow:

- `RunService.mintLockClearConfirmationToken(): string` — mints a single-use
  token bound to the **specific `runId`** currently holding the lock (read via
  `getCurrentLock()` at mint time), TTL-bounded by
  `RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS`.
- `RunService.clearLock(token: string): Promise<void>` — validates the token
  is fresh, unconsumed, and still bound to the *same* `runId` that was current
  at mint time. If a different run has since acquired the lock (the old one
  finished/expired and a new one started), the token no longer matches and the
  call fails safely rather than releasing the wrong run's lock. On success,
  delegates to the existing `releaseRun(runId)` — no new lock-release logic,
  just a confirmation gate in front of it.

**IPC + preload** — new `@MessagePattern`s on `iac-runs.controller.ts`:
`iac.runs.lock.clear.mintToken` / `iac.runs.lock.clear`, exposed via preload as
`window.hyveon.iac.runs.lock.mintToken()` / `.clear({ confirmationToken })` —
same shape as the existing `iac.lock.clear.*` pair.

**UI** — the existing `BusyBanner` (shown when `ack.conflict` is set) gains a
"Clear lock and retry" action + `ConfirmDialog`, styled after
`StaleLockBanner`'s, with the same cautionary copy pattern: "only confirm if
you're sure this isn't a real in-progress run — clearing a genuinely active
run's lock risks two applies running concurrently, which can corrupt state."
Only shown when the rejection came from `RunLockHeldError` (durable lock) —
**not** from `PulumiOperationInFlightError` (that one means *this* process is
genuinely busy right now; there's nothing to clear).

**Discovery** — reactive-only per Q1: no new status-read channel.

**Out of scope** — root-causing *why* a `RunLock` outlives its holder (most
likely an abandoned async generator whose cleanup `finally` never runs because
nothing drives it to `.return()`/completion) is explicitly not part of this
change. This is a recovery path, not a leak fix.
