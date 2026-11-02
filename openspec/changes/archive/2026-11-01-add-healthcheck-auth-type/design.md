## Context

`GameServerHealthCheck` (`app/packages/shared/src/gameServerConfig.ts`) is the declarative HTTP health check introduced by `add-pluggable-health-checks`: scheme/port/path/method/headers/timeout plus a single `activeWhen` condition and an optional `auth: GameServerHealthCheckAuth`. `GameServerHealthCheckAuth` today is `{ secretArn: string }` — the lambda handler (`app/packages/lambda/health-check/src/handler.ts:87-113`) fetches that secret and injects its raw value verbatim as `Authorization`, no prefix. The wizard (`app/packages/web/src/components/add-game-wizard/networking-step.component.tsx:409-421`) exposes a single "Credential (Secrets Manager ARN)" text field; the operator must have already created the secret out-of-band with whatever pre-encoded value the scheme requires (e.g. `Basic <base64>`).

Stakeholders: operators configuring games through the add-game-wizard; the health-check Lambda at runtime; the Settings page's IAM health check (`IamCheckService`), which simulates the account's actual permissions against `HYVEON_DEPLOY_ALL_ACTIONS` (`app/packages/shared/src/iamPolicy.ts`) and must keep passing for accounts already granted that policy.

## Goals / Non-Goals

**Goals:**
- Let operators declare `basic` or `bearer` auth without hand-encoding anything.
- Keep today's `raw` behavior (and all existing configs) working unchanged.
- Keep the credential's plaintext (secret value, username) out of `deployment-config.json` and out of anything sent to the renderer.
- Avoid orphaned Secrets Manager entries for credentials the app itself creates.

**Non-Goals:**
- No new auth schemes beyond `raw`/`basic`/`bearer` (no OAuth, no mTLS, no per-request signing).
- No change to how `raw`-type secrets are provisioned — that stays fully operator-managed, as today.
- No change to the `activeWhen` condition model or check-kind discriminator (`kind: 'http'`) — out of scope for this change.

## Decisions

### D1: `type` discriminator, default `'raw'`
- **Choice**: `GameServerHealthCheckAuth.type?: 'raw' | 'basic' | 'bearer'`. Absent `type` is treated as `'raw'` everywhere (validator, engine, redaction, wizard hydration).
- **Rationale**: every existing config has only `secretArn` and must keep working with zero migration. An optional field defaulting to today's behavior is the only non-breaking shape.
- **Alternatives considered**: a required `type` field with a one-time config migration — rejected, adds migration machinery for no behavioral benefit since `'raw'` is a correct default for every pre-existing config.

### D2: Basic-auth secret shape — username+password both in the secret
- **Choice**: for `type: 'basic'`, the Secrets Manager secret value is `JSON.stringify({ username, password })`.
- **Rationale**: keeps the entire credential inside Secrets Manager rather than splitting it across a secret (password) and plaintext config (username). Rotating the secret rotates both fields atomically; `deployment-config.json` never carries anything credential-adjacent.
- **Alternatives considered**: `username` as a plain `GameServerHealthCheckAuth` field, only `password` in the secret — rejected because it puts a piece of the credential in a JSON config file that's included in support bundles/exports, for a marginal simplicity gain.

### D3: App-owned secret provisioning for `basic`/`bearer`
- **Choice**: for `basic`/`bearer`, the app itself calls `CreateSecretCommand` (first save) and `PutSecretValueCommand` (subsequent edits) — the operator never touches Secrets Manager directly and never sees or enters an ARN for these two types. `raw` is unchanged: operator supplies an existing ARN, app never creates or writes to it.
- **Rationale**: removes the manual AWS Console round-trip entirely for the two new, common cases — the actual pain point driving this change. `raw` remains the pressure-release valve for operators who want to point at an externally-managed secret (rotation via a different pipeline, a secret shared across tools, etc).
- **Alternatives considered**: operator-supplied ARN + app writes the value only (mirrors the existing `putBotToken`/`PutSecretValueCommand` Discord precedent in `secretsStore.ts`) — rejected as the chosen design in favor of the fuller UX improvement; noted as the lower-scope fallback if `CreateSecret` IAM/ownership concerns surface during implementation.

### D4: Lifecycle — delete app-owned secrets on unset/game-delete
- **Choice**: clearing health-check auth (switching away from `basic`/`bearer`, or disabling the health check) and deleting the game both trigger `DeleteSecretCommand` for any secret this feature created. `raw`-type secrets are never deleted by this code path.
- **Rationale**: app-created resources are app-owned; the alternative is silent, untraceable Secrets Manager cost accumulation with no operator-facing indication of why a secret exists.
- **Alternatives considered**: never auto-delete (mirrors existing bot-token/public-key secrets, which nothing in the codebase deletes today) — rejected because those secrets are few and infra-provisioned once per deployment, whereas health-check credentials are created per-game and per-edit, making orphan accumulation a real operational nuisance rather than a hypothetical one.

### D5: Header construction moves into the engine, per type
- **Choice**: `app/packages/lambda/health-check/src/handler.ts`'s credential-resolution branches on `auth.type`: `raw` → inject the secret value verbatim (today's code, unchanged); `basic` → `JSON.parse` the secret, base64-encode `username:password`, set `Basic <encoded>`; `bearer` → set `Bearer <token>` directly from the secret value.
- **Rationale**: the encoding step is exactly what operators shouldn't have to do by hand — moving it into the one place that already resolves the secret is the minimal change that fixes the actual complaint.
- **Alternatives considered**: encode at write-time (wizard/app pre-computes and stores the final `Basic ...` string as the secret value, engine keeps injecting verbatim) — rejected because it collapses `basic`/`bearer` back into `raw` at the storage layer, losing the ability to validate/redisplay the credential's structure and making `type` purely cosmetic.

### D6: No IAM policy change; add regression coverage instead
- **Choice**: `HYVEON_DEPLOY_ALL_ACTIONS` already grants `secretsmanager:*` (`iamPolicy.ts:20,93`), which covers `CreateSecret`/`PutSecretValue`/`DeleteSecret`. No policy edit is needed. Add a test against `IamCheckService`'s action-simulation asserting these three actions are not denied under the existing policy.
- **Rationale**: confirmed by reading `IamCheckService.actionsToCheck()`, which sources directly from `iamPolicy.ts`. The regression test exists so a future narrowing of the `secretsmanager:*` wildcard (e.g. someone scoping it down for least-privilege) fails loudly here instead of silently breaking this feature for already-deployed accounts.
- **Alternatives considered**: none — this was a verification step (raised explicitly during design review), not a design fork.

## Risks / Trade-offs

- [Risk] Malformed/legacy secret value under a declared `basic` type (e.g. not valid JSON) → Mitigation: caught in the engine, `logger.warn`'d, health check evaluates as failed for that cycle — same failure path as any other request error, no crash, no uncaught exception (per this repo's logging invariant).
- [Risk] `CreateSecret` naming collisions across games/redeploys → Mitigation: name app-owned secrets deterministically from game id + a fixed suffix (e.g. `hyveon-{gameId}-healthcheck-auth`), and on save check for an existing app-owned ARN in the persisted config first — reuse + `PutSecretValue` if present, `CreateSecret` only when none exists.
- [Trade-off] App now performs a destructive AWS call (`DeleteSecretCommand`) it didn't before → accepted because it's scoped tightly (only secrets this feature created, tracked by ARN in config) and mirrors the ownership model already used elsewhere in the app (e.g. per-game resources fanning out from `DeploymentConfig.gameServers`).
- [Trade-off] `basic`/`bearer` secrets deleted via `DeleteSecretCommand` default to AWS's 7-30 day recovery window unless `ForceDeleteWithoutRecovery` is passed → decide during implementation which is more consistent with operator expectations (recoverable-by-default vs. immediate); leaning toward the default recovery window (safer against accidental data loss from a wizard mis-click) unless cost of lingering pending-deletion secrets is a concern.

## Migration Plan

N/A — additive, backward-compatible field. No data migration: every existing `GameServerHealthCheckAuth` (only `secretArn` set) continues to behave exactly as `type: 'raw'` with no config rewrite required. No infra/Pulumi resource changes (no new IAM policy, no new Lambda). Rollout is: ship the type-aware validator/engine/wizard together in one PR (per this repo's "docs ship with the behavior change" rule) — there is no partial-rollout window where old and new engine code could disagree, since the Lambda and the config schema deploy from the same package.

## Open Questions

- Exact `DeleteSecretCommand` recovery-window behavior (immediate vs. default recovery period) — resolve during implementation (D4/Risks above); default to AWS's standard recovery window unless a concrete reason for immediate deletion emerges.
- Exact naming scheme for app-owned secret names — proposed `hyveon-{gameId}-healthcheck-auth`, confirm no collision with any existing naming convention used by other app-created secrets (Discord bot token/public key) during implementation.
