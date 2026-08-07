# Logging

## Every IPC handler logs on entry, and errors are never left to escape uncaught

Every `@MessagePattern` handler in `app/packages/desktop-main/src/controllers/*.ts`
must start with a one-line `logger.debug('<ControllerName>: <pattern> invoked')`
call (pattern name only — never payload contents, which can carry pasted AWS
credentials or other secrets). Every service method that can fail in a way
the operator needs to understand logs the failure via `logger.warn`/
`logger.error` before returning or rethrowing, mirroring the modeled-result
pattern already used throughout `GuidedIamService`/`AwsProfileService`/
`IamCheckService` (catch, `err instanceof Error ? err.message : String(err)`,
log, return a discriminated result — never let a raw SDK/Node error object
escape a service method uncaught).

**Why:** this app has no NestJS exception filter anywhere and no HTTP
request/response cycle to fall back on for tracing — `desktop-main` is an
Electron IPC microservice, so the daily winston log file
(`userData/logs/main-*.log`) is the only record of what happened once a
report like "the wizard hung" or "step 2 errored out" comes in from an
operator who can't easily hand over a full repro. A real incident (the
guided-IAM wizard step hanging, PR #436) traced back to a handler
(`GuidedIamService.intakeBootstrapKey`) that let a raw AWS SDK error escape
with no log line anywhere on that path — by the time it was diagnosed, only
the operator's own copy-pasted console output existed as evidence, and nulling
that out meant the AWS-side cause (`InvalidClientTokenId`) had to be inferred
after the fact instead of read straight out of the log file.

**How to apply:**

- New `@MessagePattern` handler → add the entry `logger.debug` line as the
  first statement, before any other logic. See `wizard.controller.ts` for the
  established shape.
- New service method that calls an AWS SDK / external API and can fail →
  catch it, log via `logger.warn` (recoverable/expected failure, e.g. invalid
  input) or `logger.error` (unexpected failure), and return a modeled result
  or throw a plain `Error` with just `.message` — never let the raw SDK
  exception object propagate. `ipc-main-bridge.ts`'s `registerIpcMainBridges`
  is a last-resort safety net that normalizes any handler-level rejection to
  a plain, cloneable `Error` and logs it — it exists so a missed catch
  degrades to a clear error message instead of a silent hang, not as a
  substitute for logging failures where they actually happen with real
  context (which resource, which step, which operator action).
- Never log secret values — access keys, secret keys, passphrases, or raw
  IPC payloads that might carry them. Log identifiers (pattern names, step
  names, resource names, non-secret IDs) instead, matching
  `ElectronStoreService`'s own convention (e.g. `setSecretAccessKeyId` logs
  "aws.accessKeyId written (encrypted)", never the value).
- This applies to every `@Controller()` in `app/packages/desktop-main/src/controllers/`,
  not just `WizardController` — extend newly-added controllers the same way.
