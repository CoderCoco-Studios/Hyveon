## Why

Every port a non-HTTPS game declares in `ports` is opened to `0.0.0.0/0` on
the shared `game_servers` security group, with no way to restrict a port to
VPC-only callers. This means a game's REST/management/health-check port —
the exact kind of port the shipped `add-pluggable-health-checks` capability
(PR #491) requires an operator to declare — is exposed to the whole
internet, not just to the health-check Lambda that's supposed to be its
only caller. Operators need a way to keep a game's public game port open
while closing its management-style ports to VPC-internal traffic only, so
a component like the health-check Lambda can control the server without
the internet also being able to.

## What Changes

**Per-port network visibility**
- From: `GameServerPort` has no visibility concept — every declared port on
  a non-HTTPS game is ingressed from `0.0.0.0/0`.
- To: `GameServerPort` gains an optional `visibility: 'public' | 'internal'`
  field. `undefined` is treated as `'public'` (zero behavior change for
  every existing configuration). A port marked `'internal'` is ingressed
  from the VPC's CIDR block instead of the open internet.
- Reason: gives operators a general mechanism to keep a game's public port
  (e.g. Palworld's game port) open while closing a management/REST port to
  VPC-internal callers only.
- Impact: non-breaking (opt-in, default preserves current behavior).
  Affects `@hyveon/shared` (schema + validator), `@hyveon/infra`
  (security-group ingress), `@hyveon/web` (add/edit-game wizard), and docs.

**Scope note**: only applies to non-HTTPS games' ports. HTTPS games'
container ports are never individually security-group-ingressed today —
the in-task Caddy sidecar proxies to them over localhost, and only the
sidecar's own 443/80 ports get public ingress — so `visibility` has no
effect there.

**Explicitly out of scope**: no change to `add-pluggable-health-checks`'s
health-check Lambda mechanism. That Lambda already reaches a task's
private IP directly rather than through the public port; this change only
gives operators the tool to also close that port to the internet, which
`docs/docs/components/infra.md`'s "Health-check network confinement is
port-level, not game-level" section already names as a known gap left
open.

## Capabilities

### New Capabilities
- `game-port-visibility`: per-port `public`/`internal` visibility on
  `GameServerPort`, the security-group ingress behavior it drives, and the
  wizard UI to set it.

### Modified Capabilities
(none — `pulumi-infra-program`'s existing requirement that security-group
ingress is derived from the game-server map "by iteration" is unaffected;
this change only adds a new field that iteration reads, not a new
derivation mechanism.)

## Impact

- `app/packages/shared/src/gameServerConfig.ts` — `GameServerPort.visibility` field.
- `app/packages/shared/src/gameServerValidator.ts` — zod enum for the new field.
- `app/packages/infra/src/securityGroups.ts` — `dedupedDirectGamePorts` split
  into public/internal buckets; VPC CIDR lookup; internal ingress rules.
- `app/packages/web` add/edit-game port editor — visibility toggle per port.
- `docs/docs/components/infra.md` — ingress-rule documentation update.
- No IAM, no new AWS resources, no new Lambda — purely a security-group
  ingress-source change plus schema/UI.
