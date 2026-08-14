## Context

`app/packages/infra/src/securityGroups.ts`'s `defineSecurityGroups`
provisions one shared `game_servers` security group. Its ingress list is
built by `dedupedDirectGamePorts`, which walks every non-HTTPS game's
`ports` array and opens each distinct `(port, protocol)` pair to
`0.0.0.0/0` — there is no per-port visibility concept today. HTTPS games
are skipped entirely from that loop; their container ports are reached by
the in-task Caddy sidecar over localhost, and only the sidecar's own
443/80 get public ingress (a separate, unconditional block).

The `add-pluggable-health-checks` capability (shipped via PR #491; its
OpenSpec change directory is not yet archived, but the code is live on
`main`) adds a conditionally provisioned health-check Lambda and a
`healthCheck`-sourced security group that ingresses the declared
health-check port on `game_servers` from the Lambda's own SG
(`gamesWithHealthChecks`/`healthCheckSg` in `securityGroups.ts`). That
change's `checkHealthCheckRules` requires the health-check port to also
appear in the game's `ports` array — which means, under today's
`dedupedDirectGamePorts`, that same port is *also* opened to the internet.
`docs/docs/components/infra.md`'s "Health-check network confinement is
port-level, not game-level" section already names this as an accepted gap,
not something it fixes.

`GameServerPort` (`app/packages/shared/src/gameServerConfig.ts`) is
`{ container: number; protocol: string }`. `gameServerValidator.ts` splits
structural validation (zod schema) from cross-field business rules
(`check*` functions), following the same seam `add-pluggable-health-checks`
uses for its own field.

## Goals / Non-Goals

**Goals:**
- A general, per-port mechanism for marking a game's port VPC-internal
  instead of public, usable by any game for any port (not just a
  health-check port).
- Zero behavior change for every existing configuration — the field is
  optional, and its absence must reproduce today's `0.0.0.0/0` ingress
  exactly.
- A wizard UI control so operators set this without hand-editing
  `deployment-config.json`.

**Non-Goals:**
- Any change to `add-pluggable-health-checks`'s health-check Lambda
  mechanism, IAM, or SG-sourced ingress rule. That proposal's Lambda
  already reaches the task's private IP directly; this change is
  orthogonal infrastructure it can optionally build on top of later by
  marking its health-check port `internal`.
- Per-game security groups. `game_servers` remains one shared group, per
  `pulumi-infra-program`'s existing "derived by iteration" requirement —
  this change only adds a new field that iteration reads.
- Restricting ingress to specific security groups instead of the VPC CIDR.
  Considered and rejected — see Decisions.
- Any visibility control for HTTPS game ports. They're never individually
  SG-ingressed today (Caddy proxies internally), so there's nothing for
  `visibility` to change there.

## Decisions

### D0: Both `add-pluggable-health-checks` and `add-scripted-health-checks` are already-shipped/proposed capabilities this change builds alongside, not competes with

`add-pluggable-health-checks` is merged and live (PR #491); its
`healthCheck`-sourced ingress rule already exists in `securityGroups.ts`.
`add-scripted-health-checks` (a separate, still-proposed OpenSpec change)
extends the check-kind union and is unaffected by this change either way.
Neither needs to change for this proposal to land, and this proposal makes
no change to either's Lambda, IAM, or SG-sourced ingress mechanism — see
Non-Goals.

### D1: Standalone general capability, not scoped to the health-check port

- **Choice**: Add `visibility?: 'public' | 'internal'` to `GameServerPort`
  as a general field, independent of `add-pluggable-health-checks`.
- **Rationale**: A health-check port is just one instance of "a port that
  shouldn't be internet-reachable" — an RCON port, an admin panel, or any
  future management interface has the identical need. A general field
  costs no more to build and avoids inventing a second, narrower mechanism
  later when the next such port shows up.
- **Alternatives considered**: Fold this narrowly into
  `add-pluggable-health-checks` (e.g. an implicit "health-check ports are
  always internal" rule). Rejected — it solves only the one case the user
  named as an example, not the underlying gap, and would need to be
  generalized later anyway.

### D2: `undefined` visibility ≡ `'public'`

- **Choice**: `visibility` is optional; an absent value is treated
  identically to `'public'`.
- **Rationale**: Matches the existing `GameServerConfig.https` contract
  (`undefined ≡ false`) already documented and relied on elsewhere in this
  file. Every existing `deployment-config.json` is valid with no edits,
  and a `pulumi preview` against an unmodified configuration reports no
  change.
- **Alternatives considered**: Required field with no default. Rejected —
  would force every existing configuration to be edited before its next
  `pulumi preview`/`apply` succeeds, for a change that should be purely
  additive.

### D3: Internal ports are ingressed from the VPC's CIDR block, not from specific security groups

- **Choice**: A port marked `'internal'` gets ingress `cidrBlocks:
  [<vpc cidr>]` instead of `0.0.0.0/0`. The VPC CIDR is resolved inside
  `defineSecurityGroups` via `aws.ec2.getVpcOutput({ id: vpcId })` — no new
  argument needed, since `vpcId` is already passed in.
- **Rationale**: Matches the request's own framing — "VPC private ports
  ... that I can have the watchdog call from within the VPC" — a port
  reachable by anything inside the VPC, not just one pre-named caller.
  This also means a future VPC-attached component (a bastion, a
  differently-shaped watchdog) can reach an internal port without this
  change needing to be revisited to add its SG to a source list.
- **Alternatives considered**: Source ingress from specific security
  groups only (the pattern `efs_seeder` and `add-pluggable-health-checks`'s
  `healthCheckSg` already use). Tighter — only intended callers can reach
  the port — but requires every new VPC-based caller to be wired in by
  editing this change's code, and doesn't match the general "reachable
  from inside the VPC" framing the user asked for. Rejected after
  presenting both to the user, who chose the CIDR-block approach.

### D4: `dedupedDirectGamePorts` splits into two buckets, keeping its existing HTTPS skip

- **Choice**: The function's existing per-game loop (which already skips
  `config.https === true` entirely) now also branches each non-HTTPS
  port on `visibility`, producing two deduplicated port lists — public and
  internal — instead of one. `defineSecurityGroups` builds two separate
  ingress-entry blocks from them (`cidrBlocks: ['0.0.0.0/0']` and
  `cidrBlocks: [vpcCidr]` respectively) and concatenates both into
  `game_servers`'s `ingress` array, alongside the existing HTTPS and
  health-check-sourced entries. No tie-break logic is needed between the
  two buckets: `checkPortCollisions` already rejects any two games (or two
  ports within one game) declaring the same `(port, protocol)` pair, so a
  given key can only ever land in one bucket.
- **Rationale**: Minimal diff against a function whose dedup/first-seen-
  order contract is already documented and tested
  (`securityGroups.test.ts`); the HTTPS-skip and dedup-by-`(port,protocol)`
  behavior is unchanged, only which CIDR each surviving port lands in.
- **Alternatives considered**: A single list with a `visibility` field
  attached to each `GamePort`, decided at ingress-build time instead of
  dedup time. Rejected as a wash in complexity — splitting at dedup time
  keeps `GamePort`'s existing shape untouched and callers of
  `dedupedDirectGamePorts` (if any exist beyond this file) don't need to
  know about visibility at all.

## Risks / Trade-offs

[Risk] A port marked `'internal'` is reachable by anything inside the
VPC, including any other game-server task, the FileBrowser task, or a
future unrelated VPC resource — not just the intended caller (e.g. the
health-check Lambda). → Mitigation: this is the accepted trade named in
D3; the alternative (SG-sourced-only) was presented to and rejected by the
user in favor of the simpler, broader model. The spec must state this
scope accurately (VPC-reachable, not caller-scoped) rather than
overclaiming tighter confinement.

[Risk] Someone marks a game's *primary* port `'internal'` by mistake,
making the game completely unreachable from the internet with no
validation to catch it. → Mitigation: out of scope for this change — no
"at least one public port" business rule is added, matching this repo's
existing pattern of trusting operator-declared configuration (there's no
equivalent guard today preventing an empty `ports` array's worth of
reachability either). Left as a possible follow-up if it proves to be a
real operator footgun.

[Trade-off] The VPC CIDR lookup (`aws.ec2.getVpcOutput`) adds one extra
data-source read to every `pulumi preview`/`apply`, unconditionally (not
gated on any game actually declaring an internal port). → Accepted: it's a
cheap, side-effect-free data lookup, consistent with how the file already
resolves `vpcId` itself from a data source upstream.

## Migration Plan

No migration. The field is optional and every existing configuration
omits it, so an applied deployment is byte-identical (`pulumi preview`
reports no change) until an operator marks a port `'internal'`. Rolling
back is removing the field from that port's configuration and
re-applying, which returns the port to public ingress.

## Open Questions

None — both forks (standalone vs. scoped, CIDR vs. SG-sourced) were
presented to and resolved by the user during brainstorming.
