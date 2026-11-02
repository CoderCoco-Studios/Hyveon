<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: add-healthcheck-auth-type

## Classification

**Architectural.** Changes `GameServerHealthCheckAuth`, a shared interface consumed by the lambda health-check handler, the add-game-wizard UI, and `gameServerValidator.ts` — a "deployment-config field" per this repo's own CLAUDE.md checklist, and an interface change per brainstorming's own architectural criteria.

## Background

Today `GameServerHealthCheckAuth` (`app/packages/shared/src/gameServerConfig.ts:97-101`) has only `secretArn`. `app/packages/lambda/health-check/src/handler.ts:87-113` fetches the Secrets Manager secret and injects its raw value verbatim as the `Authorization` header, no prefix. Operators wanting HTTP Basic auth must pre-encode `Basic <base64(user:pass)>` themselves before storing it as the secret value — there is no way to declare the auth *type*.

## Decision chain

**Q1 — For 'basic' auth, where does the username live?**
Options: (a) both username+password JSON-encoded inside the one Secrets Manager secret, or (b) username as a plain (non-secret) config field, password-only in the secret.
**Decision: (a) both in the secret.** Secret value is `JSON.stringify({username, password})`. Keeps the entire credential inside Secrets Manager — nothing sensitive-adjacent sits in plaintext `deployment-config.json` — and rotating the secret rotates both fields together.

**Q2 — Does the add-game-wizard networking step need structured UI for entering the secret payload, or just a type tag + the existing raw ARN field?**
Options: (a) type selector + per-type fields (username/password for basic, token for bearer, ARN for raw) with the wizard doing the encoding, or (b) type selector only, operator still hand-manages the secret's value externally.
**Decision: (a) type selector + per-type fields.** Solves the actual pain point (manual base64/JSON encoding) rather than just labeling it.

**Q3 — Where does the Secrets Manager secret come from — operator-supplied ARN (app only writes the value via PutSecretValue), or does the app provision the secret itself (CreateSecret)?**
Options: (a) operator supplies ARN as today, app writes value only — matches existing Discord bot-token precedent (`putBotToken`/`PutSecretValueCommand` in `secretsStore.ts`), no new IAM permission needed; or (b) app calls `CreateSecretCommand` itself, operator never touches Secrets Manager directly for `basic`/`bearer`.
**Decision: (b) app creates the secret.** Better operator UX — no manual AWS Console step for the common cases. `raw` keeps the operator-supplied-ARN model unchanged (it's the escape hatch for pre-existing/externally-managed secrets).

**Q4 — Should app-created secrets be deleted when the operator clears health-check auth or deletes the game?**
Options: (a) delete on unset/game-removal, or (b) never auto-delete (matches existing bot-token/public-key behavior, where nothing calls DeleteSecret today).
**Decision: (a) delete on unset/game-removal.** App-created secrets are app-owned; leaving them creates silent orphaned-cost accumulation. `raw`-type secrets (operator-owned) are never touched by this lifecycle.

**Q5 — IAM: does the Settings-page "deployed account" health check need new required actions for CreateSecret/DeleteSecret?**
Investigated `IamCheckService` (`app/packages/desktop-main/src/services/IamCheckService.ts`): it simulates `HYVEON_DEPLOY_ALL_ACTIONS` from `app/packages/shared/src/iamPolicy.ts`, which already grants `secretsmanager:*` (line 20/93). No new discrete action is needed in the policy.
**Decision:** no IAM policy change required, but add explicit regression test coverage (simulate-policy test asserting `secretsmanager:CreateSecret`/`DeleteSecret` are not denied) so a future narrowing of that wildcard can't silently break this feature without the Settings-page health check catching it.

## Resolved design

- `GameServerHealthCheckAuth.type: 'raw' | 'basic' | 'bearer'`, optional, defaults to `'raw'` when absent — existing configs with only `secretArn` are unaffected (back-compat).
- `raw`: unchanged behavior. Operator supplies an arbitrary pre-existing `secretArn`; engine injects the secret's value verbatim as `Authorization`, no prefix; operator owns the secret's lifecycle.
- `basic`: app-owned secret, value `JSON.stringify({username, password})`. Engine parses it and sets `Authorization: Basic <base64(username:password)>`.
- `bearer`: app-owned secret holding the raw token. Engine sets `Authorization: Bearer <token>`.
- Wizard (`networking-step.component.tsx`): type selector (`None / Raw ARN / Basic / Bearer`); `raw` keeps today's single ARN input; `basic` shows username+password inputs; `bearer` shows a token input. Editing an existing app-created credential blanks both fields (mirrors today's `secretSet` pattern) — operator must re-enter both to change it, never a partial update.
- New desktop-main IPC (create/update/delete secret for `basic`/`bearer`) + preload bridge; lifecycle hooks into "clear health-check auth" and "delete game" flows to call `DeleteSecretCommand` for app-created secrets only.
- Redaction (`RedactedGameServerHealthCheck`) shape is unchanged — still just `secretSet: boolean`; no `type`-specific plaintext (including username) ever leaves the main process.
- Error handling: malformed secret JSON for `basic` (or any resolve failure) is caught, logged via `logger.warn`, and the health check evaluates as failed for that cycle — reuses the existing request-failure path, no new error class.
- IAM: no policy change (`secretsmanager:*` already covers Create/Put/Delete); add regression test on `IamCheckService`'s action-simulation covering the new calls.

## Touchpoints

- `app/packages/shared/src/gameServerConfig.ts` — `GameServerHealthCheckAuth` type, redaction types
- `app/packages/shared/src/gameServerValidator.ts` — per-type required-field validation
- `app/packages/lambda/health-check/src/handler.ts` (~L87-113) — branch header construction on `type`
- `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx` — type selector + per-type fields
- New/extended desktop-main service + controller for secret create/update/delete, + `desktop-preload/src/hyveon-api.ts` bridge
- `app/packages/desktop-main/src/services/IamCheckService.ts` (or its test file) — regression coverage for CreateSecret/DeleteSecret under `secretsmanager:*`
- `docs/docs/components/*` health-check docs, `docs/docs/setup.md` if IAM section needs a note (even if no policy change)
- Tests: `gameServerValidator.test.ts`, `handler.test.ts`, new wizard component tests, new IPC service tests
