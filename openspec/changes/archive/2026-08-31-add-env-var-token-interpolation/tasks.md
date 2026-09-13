## 1. Shared token grammar, command field, and validation

- [x] 1.1 Add token constants and helpers to `@hyveon/shared`: the `${hyveon.<namespace>.<name>}` grammar regex, the v1 allow-list (`network.public-address`, `network.public-ipv4`), `findHyveonTokens(value)` (all `${hyveon.*}` sequences with validity), and `substituteToken(value, token, replacement)` — with unit tests covering embedded tokens, multiple tokens per value, unknown tokens, and non-hyveon `${...}`/`{...}` passthrough
- [x] 1.2 Add optional `command?: string[]` to the `GameServer` type (`gameServerConfig.ts`) with TSDoc, and to the zod schema in `gameServerValidator.ts`
- [x] 1.3 Extend `checkEnvironmentVariables` (mirroring `checkConnectMessagePlaceholders`): unknown `${hyveon.*}` token → issue at `environment[N].value` naming the token and listing allowed ones; ipv4 token present with absent/empty `command` → issue explaining the wrapper replaces the image's start command — with validator unit tests for accept/reject cases from the delta specs

## 2. Infra: apply-time substitution and boot wrapper

- [x] 2.1 In `app/packages/infra/src/ecs.ts`, substitute `${hyveon.network.public-address}` with `<game>.<zone>` when building container environment; throw a deploy-time error naming the game and token when the token is used and no hosted zone is configured
- [x] 2.2 Implement the wrapper-script generator (new module in `app/packages/infra`): checkip.amazonaws.com discovery loop (wget → curl fallback, ~60s budget), targeted substitution lines for exactly the token-bearing env vars, single-quote escaping of all operator strings (`'` → `'\''`), final `exec` of the configured command; exit non-zero on discovery failure — with unit tests including adversarial injection values and a local `sh` execution test against a stubbed IP endpoint
- [x] 2.3 Wire the wrapper into `ecs.ts`: when any env value carries the ipv4 token set `entryPoint: ["/bin/sh", "-c", script]`; pass `command` through to the container definition whenever declared (with or without tokens); leave token-free games byte-identical — with task-definition snapshot tests covering all four scenarios in the pulumi-infra-program delta

## 3. Web UI: environment editor and command field

- [x] 3.1 Add an `environment[N].value` error slot to `environment-step.component.tsx` (matching the existing name error slot) and a hint listing the two tokens with what each resolves to
- [x] 3.2 Add the optional `command` input to the add-game wizard and edit-game form (array-of-strings entry consistent with existing list controls), threading it through `wizard-form.utils.ts` projection and the issue-path→step mapping
- [x] 3.3 jsdom component tests: value-error rendering, token hint presence, command field round-trip; `validateEnvironmentStep` unit coverage in `wizard-form.utils.test.ts` for a save blocked by an unknown token

## 4. Docs and spec sync

- [x] 4.1 Update docs via the `write-docs` skill: `docs/docs/components/infra.md` (field/resource table: `command`, entryPoint wrapper), the game-configuration/env var operator pages (token catalog, ipv4 constraints: `command` required, `/bin/sh` + wget/curl in image, fail-fast on discovery timeout, per-restart IP churn vs the stable hostname token)
- [x] 4.2 Run the full pre-PR gate (`app:lint`, `app:typecheck`, `app:test`, plus integration/e2e per changed surfaces) and verify the deployment-config field checklist for `command` (shared type, infra consumption, wizard UI, infra.md)
