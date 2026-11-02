## Why

Palworld's in-game community server browser pings a server (ICMP echo request) before joining; only after an echo reply does the client open the UDP connection. The `game_servers` security group derives its ingress exclusively from declared tcp/udp `ports`, so the ping is rejected and every browser join fails with "connection timed out" even though direct connect works. Verified live 2026-08-31: flow logs showed the browser join sending only ICMP (REJECTed, never followed by UDP), and manually adding an ICMP type-8 ingress rule fixed browser joins immediately. That manual rule is unmanaged drift the infra program will fight; ICMP ingress needs to be config-driven and provisioned.

## What Changes

**Port protocol surface**
- From: `GameServerPort.protocol` accepts `"tcp"` or `"udp"`; every entry maps to both a security-group ingress rule and an ECS `portMappings` entry.
- To: `protocol: "icmp"` is also accepted. For an ICMP entry, `container` carries the ICMP *type* (8 = echo request, the wizard default), the security group gets an `icmp` ingress rule (`fromPort` = type, `toPort` = -1), and the entry is excluded from ECS `portMappings` (ECS rejects non-tcp/udp).
- Reason: lets ping reachability be declared per game with the machinery that already exists for ports — SG fan-out, `visibility`, wizard rows, validation — mirroring how the EC2 API itself models ICMP rules.
- Impact: non-breaking. Existing configurations are untouched; operators opt in per game.

**Cross-game port collision rule**
- From: `checkPortCollisions` rejects any duplicate `(container, protocol)` pair across games.
- To: `icmp` entries are exempt from the *cross-game* collision check (several games may each declare `8/icmp`; SG-level dedupe already handles the shared rule). Same-game duplicates remain rejected.
- Reason: ping ingress on the shared security group is legitimately wanted by multiple games at once.
- Impact: non-breaking; relaxes validation only for `icmp`.

**Discord connect message port**
- From: `firstPortByGame()` feeds `GAME_PORTS` from the first declared port.
- To: first non-ICMP port, so an ICMP entry listed first cannot surface an ICMP type as a connect port.
- Impact: non-breaking display fix.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `game-port-visibility`: port declarations gain a third protocol, `icmp`, with type-based semantics for `container`, SG-only provisioning (no `portMappings`), `visibility` support, an ICMP-type range validation rule, an `icmp` exemption from the cross-game collision rule, and wizard support.

## Impact

- `@hyveon/shared`: `GameServerPort` TSDoc (`gameServerConfig.ts`), `gameServerPortSchema` + deep validation + `checkPortCollisions` (`gameServerValidator.ts`).
- `@hyveon/infra`: `securityGroups.ts` (icmp ingress rule shape), `ecs.ts` (exclude icmp from `portMappings`), `lambdas.ts` (`firstPortByGame` skips icmp).
- `@hyveon/web`: add-game wizard networking step (`PROTOCOL_OPTIONS`, ICMP-type field semantics/default, validation messages).
- Docs: `docs/docs/components/infra.md`, games/wizard app pages, Palworld example configs (README, `docs/docs/setup.md`).
- AWS: one additional ingress rule on the existing `game_servers` security group per deduped ICMP declaration; no new resources.
