<!--
Raw capture of superpowers:brainstorming output (2026-08-31 session).
design.md reorganizes this into a structured design document.
-->

# Brainstorm: ICMP echo ingress for game servers

## Background (how this change was born)

Live debugging session, 2026-08-31, us-east-2. Symptom: the Palworld server ("The OG Tiny Weens", task `95049886…`, public IP 3.16.51.26) accepted direct connects (`DNS:8211`) but every in-game community-server-browser join failed with "connection timed out".

Evidence chain (VPC flow logs on the task ENI, correlated with the container log):

- Direct connect: client IP → `10.0.0.134:8211/udp`, ACCEPT, thousands of packets both ways. Works.
- Browser join attempt (18:10 EDT): client sent exactly **2 ICMP echo requests (protocol 1, 60 bytes each — a Windows-default ping plus one retry), both REJECT**, and then *never sent any UDP at all*. Client surfaced "connection timed out".
- Conclusion: Palworld's community-browser join pings the server first and only proceeds to the UDP handshake after an echo reply. The `game_servers` security group derives its ingress solely from declared `ports` (tcp/udp), so ICMP was rejected.
- Confirmed live: manually adding an ICMP type-8 ingress rule to `sg-0e37b362ca57210bf` fixed browser joins immediately, with no server restart.

That manual rule is unmanaged drift — the infra program will not reproduce it, and a future apply may remove it. This change makes ICMP echo ingress a first-class, config-driven part of the provisioned security group.

## Path classification

Bounded: the flow being changed (declared ports → SG ingress derivation in `app/packages/infra/src/securityGroups.ts`) already exists end-to-end; this adds one protocol concept to it. Routed through OpenSpec because it changes required behaviour (`game-port-visibility` capability) and the deployment-config surface.

## Decision chain

### Q1 — How should ICMP be modeled in `deployment-config.json`?

Options presented:

- **A (chosen, user-approved): a `ports` entry with `protocol: 'icmp'`** — e.g. `{ "container": 8, "protocol": "icmp" }`, where `container` carries the ICMP *type* (8 = echo request), mirroring how the EC2 API itself models ICMP in security-group rules (`FromPort` = type, `ToPort` = code). Reuses the entire existing fan-out: SG derivation, per-port `visibility` (`public`/`internal`), wizard port rows, collision validation. This also matches the user's own framing ("allow icmp ping traffic as a port that is opened").
- B: a per-game boolean field (`allow_ping: true`) — clearer intent but a whole new `GameServerConfig` field (shared type + infra + wizard + docs checklist) for what is semantically still ingress.
- C: always-on ICMP echo for the game SG, zero config — simplest, but no opt-out and it silently becomes an invariant.

User selected **A**.

### Q2 (resolved without user input — follows from A)

- **Which ICMP types are accepted?** `container` must be an integer 0–255 when `protocol` is `'icmp'` (it is the ICMP type, not a port). The wizard defaults a new ICMP row to type 8 (echo request), the only type with a known use case today. The SG rule uses `fromPort: <type>, toPort: -1` (all codes).
- **Task definition:** ECS `portMappings` rejects anything but tcp/udp, so `defineEcs()` must exclude `protocol: 'icmp'` entries from `portMappings`. ICMP entries affect the security group only.
- **Cross-game duplicates:** `checkPortCollisions` today rejects the same `(container, protocol)` pair across games. Two games both declaring `8/icmp` is legitimate (both want ping on the shared SG) — the cross-game collision rule must exempt `icmp`; SG-level dedupe already exists (`dedupedDirectGamePorts`). Same-game duplicates stay rejected.
- **Visibility:** an ICMP entry honours `visibility` exactly like tcp/udp entries — `'public'` → `0.0.0.0/0`, `'internal'` → VPC CIDR.
- **HTTPS games:** the existing deep-validation rule (every port of an `https: true` game must be tcp/udp) stays as-is; ICMP entries on HTTPS games remain rejected. No known use case; the Caddy sidecar path is untouched.
- **Discord `GAME_PORTS` display:** `firstPortByGame()` (`app/packages/infra/src/lambdas.ts`) feeds the "server is up at host:port" Discord message; it must take the first **non-ICMP** port so an ICMP entry listed first can't surface "type 8" as a connect port.
- **Health checks:** unaffected — `healthCheck.port` must already match a declared `tcp` port.

## Trade-offs accepted

- Overloading `container` to mean "ICMP type" for `protocol: 'icmp'` is a semantic pun, but it is the same pun the EC2 API makes (`FromPort`=type), and it avoids a second config shape. TSDoc + wizard hint carry the meaning.
- Only ingress is modeled (matching all existing port handling); ICMP egress is already open via the SG's `-1` egress rule.
- No automatic migration adds `8/icmp` to existing games; operators opt in per game (Palworld docs example gains the entry).
