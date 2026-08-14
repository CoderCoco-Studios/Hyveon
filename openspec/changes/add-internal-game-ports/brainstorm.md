<!--
Raw capture of superpowers:brainstorming output.
-->

## Background

User request: "I would like you to make it so that my containers only expose
some ports within the VPC. For example I want public ports for palworld and
then vpc private ports for the rest server in a game that has the health
check that I can have the watchdog call from within the vpc. This enables
the watchdog to control the server without allowing people on the internet
to control it."

Investigation before questions:

- `add-pluggable-health-checks` (PR #491, merged 2026-08-11; its OpenSpec
  change directory just hasn't been archived yet) already shipped a
  per-game optional `healthCheck` field, a conditionally provisioned
  health-check Lambda, and a `healthCheck`-sourced security group
  (`healthCheckSg`) that ingresses the declared health-check port on
  `gameServersSg` from the Lambda's SG only — in addition to whatever
  public ingress that same port already gets. Confirmed live in
  `securityGroups.ts`, `gameServerConfig.ts`, and `gameServerValidator.ts`
  on `main`, not just proposed.
- Confirmed gap: `app/packages/infra/src/securityGroups.ts`'s
  `dedupedDirectGamePorts` iterates **every** port in a non-HTTPS game's
  `ports` array and opens each one to `0.0.0.0/0` on `gameServersSg` — with
  no exception for a port that's also used as a health-check/management
  port. A game's REST/management port, once declared in `ports` (required
  for the health-check port per `add-pluggable-health-checks`'s design:
  "the declared port must appear in the game's `ports`"), is therefore
  *also* wide open to the internet, on top of the SG-sourced rule the
  health-check Lambda uses. `add-pluggable-health-checks`'s own design.md
  flags this in "Risks / Trade-offs" as a known gap, not fixed there.
- `GameServerPort` (`app/packages/shared/src/gameServerConfig.ts`) is
  currently `{ container: number; protocol: string }` — no visibility
  concept at all.
- `defineSecurityGroups` (`securityGroups.ts`) currently takes `vpcId` but
  not the VPC's CIDR block; nothing in the file resolves it today.

## Decision chain

**Q1. Should this be scoped narrowly to just `add-pluggable-health-checks`'s
health-check port, or be a standalone general capability (any port,
any game, marked VPC-private)?**

Options presented:
- Standalone general capability — add a per-port `visibility: public |
  internal` field to `GameServerPort`. Any game can mark any port
  VPC-private (RCON, admin panels, health-check ports, etc.).
  `add-pluggable-health-checks`'s health-check port then just uses this
  field instead of inventing its own mechanism. **Recommended.**
- Fold into `add-pluggable-health-checks` only — narrower, faster, but no
  general mechanism for e.g. a future RCON port someone wants VPC-only.

**Answer: Standalone general capability.**

**Q2. How should "internal" ports be restricted — the whole VPC CIDR
block, or specific security groups only (matching the existing
`efs_seeder`/health-check SG-sourced pattern)?**

Options presented:
- Whole VPC CIDR block — any resource inside the VPC (health-check Lambda,
  a future bastion, watchdog if it ever gets VPC access) can reach it.
  Simple, matches the user's framing of "callable from within the VPC".
  Wider blast radius: any compromised VPC resource can reach it, not just
  intended callers. **Recommended, and the option the user picked.**
- Specific security groups only — tighter, but requires each new
  VPC-based caller to be wired in explicitly, and doesn't match the
  user's framing of a general "reachable from within the VPC" port.

**Answer: Whole VPC CIDR block.**

## Design presented and approved

1. **Schema** — add `visibility?: 'public' | 'internal'` to `GameServerPort`
   (`@hyveon/shared/gameServerConfig.ts`), optional, `undefined ≡ 'public'`
   (matches the existing `https` undefined-contract convention — zero
   behavior change for every existing config). Zod schema in
   `gameServerValidator.ts` gets the enum.
2. **Security groups** (`securityGroups.ts`) — `dedupedDirectGamePorts`
   splits into two buckets: public (unchanged, `0.0.0.0/0`) and internal
   (new). Internal ports get ingress sourced from the VPC's CIDR block
   instead of the open internet. Needs the VPC's CIDR — fetched via
   `aws.ec2.getVpcOutput({ id: vpcId })` inside `defineSecurityGroups` (one
   extra data lookup, no new arg needed). Only applies to non-HTTPS games
   — HTTPS games' container ports already aren't individually
   SG-ingressed (Caddy sidecar proxies internally over localhost), so
   `visibility` is a no-op there, matching `dedupedDirectGamePorts`'s
   existing https-skip scoping.
3. **Wizard** (`@hyveon/web` add/edit-game port editor) — per-port
   visibility toggle, default Public, so operators can mark e.g. a
   REST/management port VPC-only without hand-editing JSON.
4. **Docs** — `docs/docs/components/infra.md` ingress-rule table gets a
   column/note for internal vs public ports.

**Out of scope**: no change to `add-pluggable-health-checks`'s health-check
Lambda mechanism itself (already reaches the task's private IP directly) —
this only gives operators the tool to also close the port to the internet,
which that proposal's own design doc already flags as a gap it deliberately
left open.

User approved this design ("yeah") and separately confirmed the wizard/UI
toggle (section 3) was already in scope when asked to double check.
