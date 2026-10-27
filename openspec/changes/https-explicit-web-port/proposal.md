## Why

For https game servers the Ports step is confusing: the first `ports[]` entry is silently the Caddy upstream, and 80/443 are rejected as reserved. Operators migrating Foundry VTT (web server on 30000, public side on 443) tried 443 and hit a reserved-port error. The implicit rule also means an https game's other ports (UDP voice, game traffic) get no security-group ingress, and Discord `{port}` renders an unreachable upstream port. Releases already exist, so the fix must also migrate persisted configs.

## What Changes

**HTTPS upstream port**
- From: the Caddy upstream is implicitly `ports[0]` (must be tcp, not 80/443).
- To: a dedicated `webPort` field on `GameServerConfig`, required when `https = true` and forbidden otherwise; 80/443 are still rejected for it because Caddy binds them in the same task.
- Reason: ask for the upstream explicitly instead of encoding it in list order.
- Impact: breaking for the config shape; handled by a read-time normaliser.

**`ports[]` on https games**
- From: required, `ports[0]` must be tcp, none of it receives ingress, `visibility` ignored.
- To: optional extras; collisions also count `webPort`; extras get security-group ingress honoring `visibility`; `webPort` itself gets none (reachable only through Caddy on 443).
- Impact: UDP/game ports on https games become reachable (behavior change).

**Other consumers**
- Caddy proxies to `localhost:<webPort>`; ECS `portMappings` map `webPort` and extras.
- Discord `{port}` for https games renders the public 443 URL.
- `healthCheck.port` may target `webPort` or a declared tcp extra; health-check Lambda ingress follows the target.
- Wizard Ports step gains a dedicated web-port field for https games; extras are labeled additional.
- `DeploymentConfigService` normalises legacy https games on read (`webPort = ports[0].container`, `ports = ports.slice(1)`); persisted on next save, no schema version.
- ICMP on https games stays excluded (owned by `add-icmp-ingress`).

## Capabilities

### New Capabilities

### Modified Capabilities
- `game-https-configuration`: `webPort` required iff https; `ports[0]`-must-be-tcp and non-empty rules removed; legacy normalisation; wizard field and validation.
- `in-task-tls-termination`: sidecar upstream is `webPort`; https extras may be publicly ingressed while `webPort` is not.
- `game-port-visibility`: `visibility` now applies to https games' extra ports; collisions include `webPort`.

## Impact

- `@hyveon/shared`: `GameServerConfig`, `gameServerValidator.ts`, new shared normaliser/port helper, `formatStatus.ts`.
- `@hyveon/infra`: `ecs.ts`, `securityGroups.ts`, `lambdas.ts` (`firstPortByGame`), fixtures.
- `desktop-main`: `DeploymentConfigService` (normaliser), `DriftService`, diagnostics allowlist, draft types/backfill.
- `@hyveon/web`: `networking-step.component.tsx`, `wizard-form.utils.ts`, review step, games/game-detail pages, e2e + demo data.
- Docs: `docs/docs/app/games.md`, `components/infra.md`, `architecture.md`, `setup.md`, `guides/user.md`.
- Follows `pr-stacking.md`: 3 PRs (shared → infra/lambdas → wizard/docs).
