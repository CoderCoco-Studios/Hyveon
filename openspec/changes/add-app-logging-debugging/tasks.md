## 1. Console forwarding — IPC surface (Group 1 PR: `logging-1-console-forwarding`)

- [ ] 1.1 Extend `ReportRendererErrorInput` (`diagnostics.controller.ts`) or add a sibling payload type to also carry ordinary console entries (level discriminant, optional stack, `'console'` source), per `design.md` Decision 1
- [ ] 1.2 Extend/add the `@MessagePattern` handler(s) with the required entry `logger.debug` line, accepting a batch of entries in one call
- [ ] 1.3 Extend `DiagnosticsService.logRendererError()` (or add a sibling method) to write forwarded console entries into the same winston log file, tagged with level and source, distinguishable from the existing crash-only log line shape
- [ ] 1.4 Never log secret values or raw IPC payload contents from forwarded console entries, per `.claude/rules/logging.md`
- [ ] 1.5 Unit tests: successful forward, batch write, and no-crash-on-malformed-entry

## 2. Console forwarding — preload bridge (Group 1 PR, same as above)

- [ ] 2.1 Add/extend the method(s) on `HyveonDiagnosticsApi` in `hyveon-api.ts`
- [ ] 2.2 Add/extend the `invoke(...)` call(s) in `preload.ts`'s `api` object literal
- [ ] 2.3 Confirm the new/extended channel is covered by the generic `registerIpcMainBridges()` bridge (no self-bridging needed — this is a one-shot batch call, not a stream)

## 3. Console forwarding — renderer install (Group 1 PR, same as above)

- [ ] 3.1 Implement `installConsoleForwarding()` in `report-renderer-error.utils.ts`: override `console.log`/`info`/`warn`/`error` to call through to the original method, then enqueue an entry
- [ ] 3.2 Implement the batching/throttling queue: flush on interval or size cap, whichever first; on cap overflow within a flush, emit an explicit "N entries dropped" marker instead of silently discarding
- [ ] 3.3 Reuse the existing no-op-when-no-bridge guard pattern (`typeof window.hyveon?.diagnostics?... !== 'function'`) so the override is safe with no Electron bridge present
- [ ] 3.4 Wire `installConsoleForwarding()` alongside `installGlobalErrorReporting()` in `main.tsx`
- [ ] 3.5 Unit tests (Vitest + jsdom): override forwards to IPC, original console behavior preserved, batching/cap behavior, no-op without a bridge

## 4. Service-layer diagnostic logging sweep (Group 2 PR: `logging-2-service-layer-sweep`)

- [ ] 4.1 `AuditService.ts` — entry `logger.debug` + failure logging on AWS SDK calls
- [ ] 4.2 `AwsProfileService.ts` — same
- [ ] 4.3 `ConfigService.ts` — same
- [ ] 4.4 `CostService.ts` — same
- [ ] 4.5 `DiagnosticsService.ts` — same (excluding the Group-1-added forwarding method, which already gets its own entry log in Group 1)
- [ ] 4.6 `DiscordCommandRegistrar.ts` — same
- [ ] 4.7 `DiscordConfigService.ts` — same
- [ ] 4.8 `DriftService.ts` — same
- [ ] 4.9 `EcsService.ts` — same
- [ ] 4.10 `GamesWriteService.ts` — same
- [ ] 4.11 `GuidedIamService.ts` — same (already follows the modeled-result pattern in places; confirm every AWS-calling method has entry debug logging, fill gaps only)
- [ ] 4.12 `IamCheckService.ts` — same
- [ ] 4.13 `LogsService.ts` — same
- [ ] 4.14 `PulumiCancellation.ts` — same
- [ ] 4.15 `PulumiCredentialResolver.ts` — same
- [ ] 4.16 `PulumiEngineService.ts` — same
- [ ] 4.17 `PulumiLeakedPromise.ts` — same
- [ ] 4.18 `PulumiLockRecovery.ts` — same
- [ ] 4.19 `PulumiService.ts` — same
- [ ] 4.20 `RunRecordService.ts` — same
- [ ] 4.21 `RunService.ts` — same
- [ ] 4.22 `SafeStorageService.ts` — same
- [ ] 4.23 `awsCredentialSource.ts` — same
- [ ] 4.24 `verifyAccessKeyWithRetry.ts` — same
- [ ] 4.25 Confirm `mergeGameLists.ts` and `sleep.ts` are deliberately left untouched (pure helpers, no failure mode) — no task needed, just verify no debug lines were added there
- [ ] 4.26 Unit tests: for each file touched, at least one test asserting a failure path logs via `logger.warn`/`logger.error` rather than letting a raw error escape (extend existing test files; do not create parallel logging-only test suites)

## 5. Diagnostics panel UX (Group 3 PR: `logging-3-diagnostics-panel-ux`)

- [ ] 5.1 Add pause/resume state to `DiagnosticsPanel.tsx`: polling continues in the background, new lines buffer while paused, buffered lines apply on resume
- [ ] 5.2 Add level classification (reuse the regex classification `/logs`'s `ansi-log-viewer.component.tsx` already applies) and level-filter toggles (INFO/WARN/ERROR/DEBUG)
- [ ] 5.3 Add substring search with match highlighting, no regex support, matching `/logs`'s existing scope
- [ ] 5.4 Component tests (Vitest + jsdom): pause freezes the view, resume applies buffered lines in order, level filter narrows the visible set, search highlights matches without removing non-matching lines

## 6. Documentation (Group 4 PR: `logging-4-docs`, per pr-stacking.md's sanctioned "docs land once the flow is verifiable end-to-end" exception)

- [ ] 6.1 Update `docs/docs/components/management-app.md` — document renderer console forwarding, the extended `diagnostics.reportError`/new channel, and the service-layer logging convention now covering the service layer, not just controllers
- [ ] 6.2 Update `docs/docs/app/settings.md`'s Diagnostics panel section — document pause/filter/search
- [ ] 6.3 Confirm no other `docs/docs/**` page describes the old crash-only-forwarding or bare-scrolling-panel behavior in a way that now reads as stale

## 7. Verification (run before opening each PR in the stack, per `CLAUDE.md`)

- [ ] 7.1 `npm run app:lint` clean
- [ ] 7.2 `npm run app:typecheck` clean
- [ ] 7.3 `npm run app:test` green
- [ ] 7.4 `npm run app:test:integration` green (Group 1 and Group 4 touch controllers/services)
- [ ] 7.5 `npm run app:test:e2e` green (Group 1 and Group 3 touch renderer/preload/IPC surface)
