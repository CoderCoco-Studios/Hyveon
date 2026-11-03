## Context

Palworld's community-server-browser join pings a server (ICMP echo request) and only opens the UDP game connection after an echo reply. The `game_servers` security group (`app/packages/infra/src/securityGroups.ts`, `defineSecurityGroups`) derives its ingress exclusively from each game's declared `ports` array — tcp/udp only — so the ping is rejected and browser joins time out while direct connects succeed. This was proven live on 2026-08-31 with VPC flow logs (browser join = 2 ICMP echo requests, REJECT, no UDP ever sent; direct connect = straight UDP 8211, ACCEPT) and confirmed by manually adding an ICMP type-8 ingress rule, which fixed browser joins instantly. That manual rule is drift the infra program will not preserve.

Constraints: `DeploymentConfig.gameServers` is the single source of truth (per-game resources fan out from it); ECS `portMappings` rejects protocols other than tcp/udp; the `game_servers` SG is shared by all games; `checkPortCollisions` currently rejects duplicate `(container, protocol)` pairs across games.

## Goals / Non-Goals

**Goals:**
- Let an operator declare ICMP echo reachability per game in `deployment-config.json`, provisioned by the infra program (replacing the manual SG rule).
- Reuse the existing ports machinery end to end: SG derivation, `visibility`, wizard, validation.
- Keep every existing configuration byte-for-byte valid and its provisioned infrastructure unchanged.

**Non-Goals:**
- No automatic ICMP for all games (operators opt in per game).
- No ICMP support for `https: true` games (the existing tcp/udp-only deep-validation rule stands; no known use case).
- No ICMP egress modeling (SG egress is already `-1` open).
- No ICMP-based health checking or latency display inside the app.

## Decisions

### D1: Model ICMP as a `ports` entry with `protocol: 'icmp'`
- **Choice**: extend `GameServerPort.protocol` to accept `'icmp'`; for such entries `container` carries the ICMP type (8 = echo request).
- **Rationale**: the SG fan-out, per-port `visibility`, wizard port rows, and collision validation all already key off `ports`; this is one union-member extension rather than a new config surface. The `container`-as-type pun is the same one the EC2 API makes (`FromPort` = ICMP type, `ToPort` = code). Matches the operator's mental model ("a port that is opened").
- **Alternatives considered**: per-game boolean `allow_ping` (new field across shared type + wizard + docs checklist for what is still ingress — rejected as heavier); always-on ICMP on the game SG (zero config but no opt-out, silently becomes an invariant — rejected). User selected the ports-entry model 2026-08-31.

### D2: Accept ICMP types 0–255, default the wizard to 8
- **Choice**: when `protocol` is `'icmp'`, `container` must be an integer 0–255; the SG rule is `{ protocol: 'icmp', fromPort: <type>, toPort: -1 }` (all codes). New wizard ICMP rows default to type 8.
- **Rationale**: type-range validation is cheap and future-proof; echo request is the only type with a current use case, so the wizard steers there without the schema hard-coding it.
- **Alternatives considered**: restrict to type 8 only (rejected: needless re-spec when another type is wanted); allow `-1` "all types" (rejected: no use case, broadens exposure by default).

### D3: Exclude ICMP entries from ECS `portMappings`
- **Choice**: `defineEcs()` filters `protocol: 'icmp'` out of the container's `portMappings`.
- **Rationale**: ECS rejects non-tcp/udp port mappings; ICMP entries are SG-only by nature (awsvpc tasks receive ICMP on the ENI regardless of port mappings).

### D4: Exempt `icmp` from the cross-game collision rule
- **Choice**: `checkPortCollisions` skips `icmp` entries when comparing across games; same-game duplicates remain rejected. `dedupedDirectGamePorts`/`dedupedInternalGamePorts` already dedupe the shared SG rule.
- **Rationale**: multiple games legitimately want ping on the shared `game_servers` SG; rejecting the second declaration would make the feature single-game.
- **Alternatives considered**: keep the rule and document "declare it on one game only" (rejected: makes one game's config semantically load-bearing for another's reachability).

### D5: `visibility` applies to ICMP entries unchanged
- **Choice**: `'public'` (or omitted) → `0.0.0.0/0`; `'internal'` → VPC CIDR, identical to tcp/udp handling.
- **Rationale**: falls out of D1 for free; an internal-only ping (VPC health tooling) is coherent.

### D6: Discord `GAME_PORTS` uses the first non-ICMP port
- **Choice**: `firstPortByGame()` (`app/packages/infra/src/lambdas.ts`) skips `icmp` entries.
- **Rationale**: the Discord "server is up at host:port" message must never render an ICMP type as a connect port.

## Risks / Trade-offs

- [Trade-off] `container` means "ICMP type" for `icmp` entries — a semantic overload → accepted: same shape the EC2 API uses; carried by `GameServerPort` TSDoc and a wizard field hint.
- [Risk] An operator's existing manual SG rule (added during the incident) collides conceptually with the managed rule → Mitigation: Pulumi owns the SG's `ingress` list wholly, so the next apply converges to the declared set; the migration plan below tells the operator to add the config entry before the next apply so browser joins never regress.
- [Risk] Wizard UX confusion (a "port" field suddenly meaning "type") → Mitigation: protocol-aware label/hint and a prefilled 8 when `icmp` is selected; validation message names the 0–255 type range.
- [Trade-off] ICMP echo exposes liveness of the task's IP to the internet when `'public'` → accepted: the IP already serves a public game port; operators can choose `'internal'`.

## Migration Plan

1. Ship the change (shared validation → infra → wizard, one PR).
2. Operator adds `{ "container": 8, "protocol": "icmp" }` to Palworld's `ports` via the edit-game wizard.
3. Next infra apply provisions the managed ICMP rule; the manually added incident rule (`sg-0e37b362ca57210bf`, description "ICMP echo for Palworld server-browser ping") is absorbed/replaced by Pulumi's declared ingress set.
4. Rollback: remove the config entry and re-apply — the SG rule disappears; no data or task impact.

Acceptance: `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` green; a config with an `icmp` entry provisions an `icmp` SG rule in `pulumi preview`; existing configs preview with zero diff.

## Open Questions

None — all forks resolved in the 2026-08-31 session (see brainstorm.md).
