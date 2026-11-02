<!--
Raw capture of superpowers:brainstorming output.
design.md reorganizes this; do not copy it verbatim.
-->

# Brainstorm: explicit web port for https game servers

## Background

Operator feedback: for `https = true` games the add/edit-game wizard Ports step is confusing. Today `ports[0]` is implicitly the Caddy upstream (`caddy reverse-proxy --from <game>.<zone> --to localhost:<ports[0].container>`, `app/packages/infra/src/ecs.ts:251`), and container ports 80/443 are rejected as reserved for Caddy (`checkHttpsPortRules`, `app/packages/shared/src/gameServerValidator.ts`). Operators migrating Foundry VTT (listens on 30000, `FOUNDRY_PROXY_SSL=true`, `FOUNDRY_PROXY_PORT=443`) tried 443 and hit the reserved-port error. Foundry on 30000 behind Caddy on 443 is the correct topology.

Requested: for https games, ask explicitly for the port the game's web server listens on (the Caddy upstream) as a dedicated field; `ports[]` becomes an optional list of additional ports (e.g. UDP voice, game traffic).

## Recon findings (code, 2026-10-26)

- Releases exist (tags v0.7.2 … v0.9.1), so persisted https games with `ports[0]` as upstream are real; migration is required, not optional.
- `deployment-config.json` is not re-validated on read; there is no game-server schema version. Precedent (`add-internal-game-ports`) is an optional field with no migration; wizard drafts are backfilled on read (`GameWizardDraftService.backfillPortVisibility`).
- `securityGroups.ts` `dedupedGamePortsByVisibility` skips https games entirely, so none of an https game's `ports[]` (UDP, extras) get ingress today. Public 443/80 rules exist if any game is https.
- `lambdas.ts` `firstPortByGame` feeds `GAME_PORTS` (update-dns, followup, `formatStatus`); it picks the first public non-icmp port and ignores https, so Discord `{port}` resolves to the unreachable upstream port. `docs/docs/guides/user.md` says https games "connect over 443", contradicting it.
- `healthCheck.port` must be a declared tcp port (`checkHealthCheckRules`); health-check Lambda ingress is applied regardless of https.
- `visibility: 'public'|'internal'` is ignored on https games today (spec `game-port-visibility`).
- Validator is called by web (`wizard-form.utils.ts` `validateWizardDraft`, `use-deployment-settings.hook.ts`) and desktop-main (`GamesWriteService`); nothing re-implements the rules. Lambdas never validate.
- ICMP on https games is excluded by active change `add-icmp-ingress`.
- Palworld demo fixture (`web/e2e/screenshots/demo-data.ts`) is https with only UDP ports — rejected by the current validator.

## Decision chain

1. **Ingress for https games' additional ports?** Q: should extras get security-group ingress honoring `visibility`? User: **yes**. (Behavior change: today they get none; needed for UDP voice/game traffic.)
2. **Playback** of scope + my calls; user: **looks good**.

## Agreed design

- New `webPort?: number` on `GameServerConfig`: required when `https = true`, forbidden otherwise.
- `webPort` rejects 80/443 (Caddy binds them in the same task network namespace). Wizard label: the port the game's web server listens on; Caddy serves it publicly on 443.
- `ports[]` becomes optional extras for https games: `ports[0]`-must-be-tcp rule dropped; `checkPortCollisions` also treats `webPort` as taken; reserved 80/443 rules stay for `ports[]`.
- Migration: read-time normaliser in `DeploymentConfigService`; https game with no `webPort` → `webPort = ports[0].container`, `ports = ports.slice(1)`. Persisted on next save. No schema version.
- Caddy `--to localhost:<webPort>`; `portMappings` still map `webPort` and extras.
- No security-group ingress for `webPort` (reachable only via Caddy 443).
- https extras honor `visibility` (public → 0.0.0.0/0, internal → VPC CIDR). Spec/doc lines saying visibility does nothing on https games are removed.
- Discord `{port}` for https games renders the public 443 URL, not the upstream port (in scope).
- `healthCheck.port` may target `webPort` or a declared tcp extra; health-check Lambda ingress follows the target.
- ICMP on https games stays excluded (owned by `add-icmp-ingress`).
- Decomposition (pr-stacking.md): 3 PRs — (1) shared type + validator + normaliser, (2) infra + lambdas, (3) wizard + docs. Each independently green.

## Acceptance

- Foundry config with `webPort: 30000` validates; Caddy proxies to `localhost:30000`.
- Legacy https config normalises correctly on read.
- UDP extra on an https game gets a security-group rule.
- `npm run app:lint`, `app:typecheck`, `app:test` green; integration and e2e where relevant.

## Constraints

- No Foundry credentials/license keys in files or PRs.
- `@hyveon/shared` barrel stays free of new AWS SDK imports.
- Duplication rule: extract shared port helpers rather than copying.
