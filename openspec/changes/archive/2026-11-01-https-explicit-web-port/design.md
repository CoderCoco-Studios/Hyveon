## Context

For `https = true` games a Caddy sidecar terminates TLS and proxies to `localhost:<ports[0].container>` (`app/packages/infra/src/ecs.ts`). `ports[0]` is therefore overloaded: it is the upstream, it must be tcp, and 80/443 are rejected (`checkHttpsPortRules`). `securityGroups.ts` skips https games entirely when building per-port ingress, so none of their `ports[]` are reachable; `visibility` is ignored. `firstPortByGame` (`lambdas.ts`) feeds `GAME_PORTS` for Discord and ignores https, so `{port}` resolves to the unreachable upstream. The wizard presents this as an ordinary port list.

Persisted `deployment-config.json` is not re-validated on read and has no game-server schema version. Releases (v0.7.2–v0.9.1) exist, so real configs have `ports[0]` as upstream.

## Goals / Non-Goals

**Goals:**
- Ask for the upstream port explicitly via a dedicated field.
- Make `ports[]` plain additional ports with working ingress and `visibility`.
- Migrate existing https configs without operator action.
- Fix Discord `{port}` and health-check handling for https games.

**Non-Goals:**
- ICMP on https games (owned by `add-icmp-ingress`).
- A game-server schema version or write-time migration tooling.
- Changing Caddy topology, DNS ownership, or TLS issuance.
- Any Foundry-specific handling; Foundry is just the motivating config (`webPort: 30000`).

## Decisions

### D1: Dedicated `webPort?: number` on `GameServerConfig`
- **Choice**: required iff `https = true`, forbidden otherwise; integer 1–65535, not 80/443.
- **Rationale**: explicit beats positional; 80/443 stay rejected because Caddy binds them in the shared task network namespace, so a collision is real.
- **Alternatives**: `ports[]` entry flagged `upstream: true` (still mixes concerns, allows 0 or 2 flagged entries); keep ordering and only fix the message (does not address the confusion).

### D2: `ports[]` becomes optional extras
- **Choice**: drop "non-empty" and "`ports[0]` must be tcp" for https; keep tcp/udp-only and 80/443 reserved; `checkPortCollisions` includes `webPort`; icmp stays rejected on https games.
- **Rationale**: matches the requested model; collisions with the upstream must still be caught.

### D3: Ingress and visibility for https extras
- **Choice**: `dedupedGamePortsByVisibility` stops skipping https games for `ports[]` (public → 0.0.0.0/0, internal → VPC CIDR); `webPort` gets no ingress.
- **Rationale**: UDP voice/game traffic is the reason extras exist; `webPort` stays private so Caddy remains the only public entry.
- **Alternatives**: keep https ports without ingress (extras unusable).

### D4: Read-time normaliser, no schema version
- **Choice**: shared pure helper `normalizeGameServer`; `DeploymentConfigService` applies it on read: https and no `webPort` → `webPort = ports[0].container`, `ports = ports.slice(1)`. Persisted on next save.
- **Rationale**: matches `add-internal-game-ports` precedent (optional field, no migration) while covering the one shape that changes meaning; idempotent; infra (which reads config through the same service) only ever sees the new shape.
- **Alternatives**: write-time migration on app start (writes to operator's S3 without an operator action); keep legacy-tolerant validator and infra (two code paths forever).
- Wizard drafts get the same normaliser via the existing backfill hook.
- **Deprecation marking**: the legacy shape (https game with no `webPort`, `ports[0]` as upstream) is marked deprecated in code. `normalizeGameServer` and its call sites carry a TSDoc `@deprecated` modifier tag plus a comment stating the legacy shape, that it is read-only compatibility, and that it is removable once no supported release can have written it (target: the first minor after v0.9.x that ships this change plus one release of overlap). The `ports` and `webPort` TSDoc on `GameServerConfig` states that, for https games, treating `ports[0]` as the upstream is deprecated. No runtime warning is emitted; the log line for a normalised game is a `logger.debug` with the game name only (no payload).

### D5: Discord `{port}` and `healthCheck.port`
- **Choice**: `firstPortByGame` yields the public 443 URL form for https games; `healthCheck.port` may be `webPort` or a declared tcp extra, and health-check ingress follows the target.
- **Rationale**: `{port}` must be something a player can connect to; health check on the web port is the common case for https games.

### D6: Shared helper placement
- **Choice**: port helpers live in `shared/src/gameServerPorts.ts` (no AWS imports, exported from the barrel; pure). Wizard, validator, infra, and lambdas use it; no per-layer copies.
- **Rationale**: `duplication.md`; barrel invariant preserved.

## Risks / Trade-offs

- [Risk] Newly exposed ports on existing https games after normalisation → Mitigation: normalising `ports.slice(1)` exposes ports that previously had no ingress; release notes and docs call this out, and the infra preview shows the new rules before apply.
- [Risk] Normaliser applied only on read leaves S3 holding legacy shape until next save → Mitigation: all readers go through `DeploymentConfigService`; idempotent helper; test with legacy fixtures.
- [Risk] Drift detection (`DriftService`) diffs `ports` and may report drift for legacy configs → Mitigation: diff on normalised shape.
- [Trade-off] Rejecting 80/443 for `webPort` keeps one friction point for operators who type 443 → accepted; error message and field help explain the public/upstream split.
- [Trade-off] Lambda env `GAME_PORTS` shape changes for https games → accepted; lambdas deploy with the infra PR.

## Migration Plan

1. PR 1 (shared): type, validator, helper, normaliser, `DeploymentConfigService` + draft backfill.
2. PR 2 (infra/lambdas): Caddy upstream, port mappings, ingress, `firstPortByGame`/`formatStatus`, fixtures. Depends on PR 1.
3. PR 3 (web/docs/specs): wizard field, review/detail pages, e2e/demo data, docs, delta-spec sync.
Each PR passes lint, typecheck, unit tests (integration/e2e where relevant). Rollback: revert PRs in reverse; configs saved with `webPort` remain readable by the previous version only for non-https games, so rollback after a save needs the S3 object-version restore (`restoreRawConfig`).

## Open Questions

- Removal release for the legacy normaliser (proposed: one minor after this ships; owner decides at that release).
- Exact error wording when an operator enters 80/443 for `webPort` (implementation detail; follow PR #682 style).
