# Logging

## Every IPC handler logs on entry; no error escapes uncaught

1. Every `@MessagePattern` handler (`app/packages/desktop-main/src/controllers/*.ts`) starts with `logger.debug('<ControllerName>: <pattern> invoked', { ...safeIdentifiers })` as its first line — the pattern name plus non-secret identifiers only (e.g. `game`), never raw payload/credential contents.
2. Every service method that calls an AWS SDK/external API and can fail: catch it, normalize via `err instanceof Error ? err.message : String(err)`, `logger.warn` (expected/recoverable) or `logger.error` (unexpected) the result, then return a modeled result or throw a plain `Error` with just `.message`. Never let a raw SDK/Node error object escape uncaught — match `GuidedIamService`/`AwsProfileService`/`IamCheckService`.
3. Never log secret values (keys, passphrases, raw IPC payloads that might carry them) — log identifiers only, per `ElectronStoreService`'s convention.
4. Applies to every `@Controller()` in that directory, not just `WizardController`.

**Why:** no exception filter, no HTTP cycle — the winston log file is the only record once an operator reports "it hung." PR #436's wizard-hang incident had zero log line on the failing path; the AWS-side cause had to be inferred after the fact instead of read from the log. `ipc-main-bridge.ts`'s handler-level safety net normalizes uncaught rejections — it's a backstop, not a substitute for catching where the failure actually happens.
