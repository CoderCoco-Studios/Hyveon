## Why

Operators can only give a game-server health check a raw Secrets Manager-backed credential — the resolved secret value is injected verbatim as the `Authorization` header with no prefix. Getting HTTP Basic auth working today requires manually base64-encoding `user:pass` and writing that exact string into the secret themselves. This is error-prone, undiscoverable, and blocks the common case (a game's management API behind Basic or Bearer auth) on manual AWS Console work outside the app.

## What Changes

**Health-check credential type**
- From: `GameServerHealthCheckAuth` carries only `secretArn`; the secret's value is injected verbatim as `Authorization`, no prefix, always operator-managed in Secrets Manager.
- To: `GameServerHealthCheckAuth` gains an optional `type: 'raw' | 'basic' | 'bearer'`, defaulting to `'raw'` when absent. `raw` preserves today's behavior exactly (back-compat, operator-owned secret). `basic` and `bearer` are new app-owned credential types: the app creates and manages the Secrets Manager secret itself, and the health-check engine constructs the `Authorization` header (`Basic <base64(user:pass)>` / `Bearer <token>`) instead of requiring the operator to pre-encode it.
- Reason: removes the manual-encoding step for the two most common auth schemes, while keeping `raw` as an escape hatch for externally-managed secrets.
- Impact: non-breaking. Existing configs (no `type`) behave identically. New IPC surface for creating/updating/deleting app-owned secrets; new wizard UI; no IAM policy change (`secretsmanager:*` already covers the new calls, per `HYVEON_DEPLOY_ALL_ACTIONS` in `iamPolicy.ts`).

**Credential lifecycle**
- From: no code path ever deletes a health-check secret.
- To: app-owned (`basic`/`bearer`) secrets are deleted when the operator clears health-check auth or deletes the game. `raw` secrets are never touched — the operator owns that lifecycle, unchanged.
- Reason: app-created secrets are app-owned; leaving them orphaned accrues silent Secrets Manager cost with no way to trace them back to a deleted game.
- Impact: non-breaking, additive delete calls scoped only to secrets this feature itself created.

## Capabilities

### Modified Capabilities
- `game-health-checks`: adds the `type` discriminator, per-type header construction, app-owned secret lifecycle (create/update/delete), and wizard UI for `basic`/`bearer` credentials to the existing declarative HTTP health-check capability introduced by `add-pluggable-health-checks`.

## Impact

- `app/packages/shared/src/gameServerConfig.ts` — `GameServerHealthCheckAuth` type, redaction types.
- `app/packages/shared/src/gameServerValidator.ts` — per-type required-field validation.
- `app/packages/lambda/health-check/src/handler.ts` (~L87-113) — branch header construction on `type`.
- `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx` — type selector + per-type fields (username/password, token, or today's ARN field).
- New/extended desktop-main service + controller for secret create/update/delete, plus `desktop-preload/src/hyveon-api.ts` bridge.
- `app/packages/desktop-main/src/services/IamCheckService.ts` test coverage — regression test confirming `secretsmanager:CreateSecret`/`DeleteSecret` remain covered by the existing `secretsmanager:*` grant.
- `docs/docs/components/*` health-check docs.
- Depends on `game-health-checks` (introduced by the still-unarchived `add-pluggable-health-checks` change) having landed in code — confirmed already true (`GameServerHealthCheckAuth`, the lambda handler, and the wizard UI all exist today); the OpenSpec archival/sync of that earlier change is a separate pre-existing housekeeping gap, not something this change needs to fix.
