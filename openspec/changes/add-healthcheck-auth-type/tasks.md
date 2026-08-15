## 1. Shared types and validation

- [ ] 1.1 Add `type?: 'raw' | 'basic' | 'bearer'` to `GameServerHealthCheckAuth` in `app/packages/shared/src/gameServerConfig.ts`; document that absent `type` means `'raw'`.
- [ ] 1.2 Update `RedactedGameServerHealthCheck`/the `secretSet` redaction logic so it stays correct for all three types — no username, password, or token ever survives redaction, only the existing boolean.
- [ ] 1.3 Add per-type validation to `app/packages/shared/src/gameServerValidator.ts`: `basic` requires username and password on create; `bearer` requires a token; `raw`/no-`type` requires a `secretArn`, unchanged.
- [ ] 1.4 Update `gameServerValidator.test.ts` for the new validation branches (missing username/password for `basic`, missing token for `bearer`, existing `raw` cases untouched).

## 2. Health-check engine

- [ ] 2.1 In `app/packages/lambda/health-check/src/handler.ts` (~L87-113), branch credential resolution on `auth.type`: `raw`/undefined keeps today's verbatim injection; `basic` parses the secret as `{ username, password }` JSON and sets `Authorization: Basic <base64(username:password)>`; `bearer` sets `Authorization: Bearer <token>`.
- [ ] 2.2 Treat a `basic` secret that isn't valid `{ username, password }` JSON as an unavailable credential — same failure path as any other resolve failure (caught, `logger.warn`'d, check evaluates as failed/active per the existing fail-safe requirement).
- [ ] 2.3 Update `handler.test.ts` with cases for `raw` (unchanged), `basic` (success + malformed-secret failure), and `bearer`.

## 3. App-owned secret lifecycle

- [ ] 3.1 Design the app-owned secret naming scheme (e.g. `hyveon-{gameId}-healthcheck-auth`) and confirm it doesn't collide with existing app-created secrets (Discord bot token/public key).
- [ ] 3.2 Add create/update logic: on saving a `basic`/`bearer` credential, `PutSecretValue` if an app-owned secret ARN is already on record for that game's health check, else `CreateSecret` and persist the resulting ARN.
- [ ] 3.3 Add delete logic: removing a `basic`/`bearer` credential from a health check, or deleting the game, calls `DeleteSecretCommand` for that app-owned secret. Never delete a `raw`-type secret.
- [ ] 3.4 Decide and implement the `DeleteSecretCommand` recovery-window behavior (default recovery window vs. `ForceDeleteWithoutRecovery`) per design.md's open question.
- [ ] 3.5 Wire the new create/update/delete calls into desktop-main as an IPC-exposed service method (following this repo's IPC handler logging convention — log on entry, catch/normalize SDK errors, never let a raw error escape), and expose it through `desktop-preload/src/hyveon-api.ts`.
- [ ] 3.6 Unit tests for the new service: create-on-first-save, update-in-place on edit, delete-on-remove, delete-on-game-delete, and that `raw` credentials are never touched by any of these paths.

## 4. Wizard UI

- [ ] 4.1 In `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`, add an auth-type selector (`None / Raw ARN / Basic / Bearer`) replacing the single always-visible ARN field.
- [ ] 4.2 Render the existing ARN input only for `raw`; render username+password inputs for `basic`; render a token input for `bearer`.
- [ ] 4.3 On editing an existing app-owned (`basic`/`bearer`) credential, blank the input fields and show the existing `secretSet`-style indicator — operator must re-enter both fields to change it, never a partial update, matching the current `raw` ARN field's blanking behavior.
- [ ] 4.4 Component tests for the new selector and per-type field rendering/validation-message plumbing.

## 5. IAM permission verification

- [ ] 5.1 Add a regression test on `IamCheckService`'s action-simulation (or the shared `iamPolicy.ts` action list) asserting `secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue`, and `secretsmanager:DeleteSecret` are covered by `HYVEON_DEPLOY_ALL_ACTIONS`, so a future narrowing of the `secretsmanager:*` grant fails this test instead of silently breaking already-deployed accounts.
- [ ] 5.2 Confirm no change is needed to `docs/docs/setup.md`'s IAM policy documentation (the grant already covers these actions); note this explicitly in the PR description.

## 6. Documentation

- [ ] 6.1 Update the health-check documentation under `docs/docs/components/*` to describe `type: 'raw' | 'basic' | 'bearer'`, the app-owned secret model for `basic`/`bearer`, and the wizard's new fields. Use the `write-docs` skill.
- [ ] 6.2 Run the `docs-accuracy-auditor`, `docs-coverage-auditor`, and `docs-style-reviewer` evaluators over the updated docs before opening the PR.

## 7. Pre-PR verification

- [ ] 7.1 `npm run app:lint` — clean.
- [ ] 7.2 `npm run app:typecheck` — clean.
- [ ] 7.3 `npm run app:test` — full unit suite green, including all new tests from sections 1-5.
- [ ] 7.4 `npm run app:test:integration` — required since IPC/controllers changed.
- [ ] 7.5 `npm run app:test:e2e` — required since the wizard renderer and preload bridge changed.
- [ ] 7.6 Run `/opsx:verify` to confirm implementation matches this change's specs and tasks before archiving.
