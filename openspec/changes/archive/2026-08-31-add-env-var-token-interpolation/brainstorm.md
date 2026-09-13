<!--
Raw capture of superpowers:brainstorming output (session 2026-08-31).
design.md extracts from this file and reorganizes it into a structured design document.
-->

# Brainstorm: env var token interpolation for game servers

## Background

Chris's idea: allow game server environment variables to reference Hyveon/AWS-derived values via a placeholder syntax (initial proposal: `${network.public-address}` resolving to the task's public IPv4), so operators don't hard-code addresses that can change.

Classification: **architectural** — new interpolation contract on `GameServerConfig` env vars, touching shared types, infra task definitions, and the container start path.

## Context findings (codebase research)

- Per-game env vars are `GameServerEnvironmentVariable { name, value }` arrays (`app/packages/shared/src/gameServerConfig.ts:52-58`, `:215`), passed verbatim into the ECS container definition at Pulumi apply time (`app/packages/infra/src/ecs.ts:178`). Values are frozen into the task definition revision.
- Neither RunTask call site (`app/packages/cloud-aws/src/AwsCloudProvider.ts:451-461`, `app/packages/lambda/followup/src/handler.ts:138-149`) passes container overrides — and overrides wouldn't help for the IP anyway: the ENI (and its public IP) doesn't exist until after RunTask.
- The public IPv4 becomes known only once the task is RUNNING; `lambda-update-dns` discovers it via DescribeTasks → ENI → DescribeNetworkInterfaces with retries (`app/packages/lambda/update-dns/src/handler.ts:66-108`) and UPSERTs the A record for the deterministic hostname `<game>.<zone>` (`handler.ts:294`).
- The hostname `<game>.<zone>` is deterministic and known at apply time — the Caddy sidecar command already interpolates it (`app/packages/infra/src/ecs.ts:198`).
- Existing templating precedent: `connect_message` uses `{host}`/`{ip}`/`{port}`/`{game}` tokens with an allow-list validator (`app/packages/shared/src/gameServerValidator.ts:532-549`). No `${...}` interpolation exists anywhere in shared/infra.
- Game images are operator-supplied and arbitrary (`itzg/minecraft-server:latest`-style); the game container currently sets no `entryPoint`/`command` (`ecs.ts:170-184`).
- Env var validation today: non-empty unique names only; the `value` field is explicitly unconstrained (`gameServerValidator.ts:489-519`; `openspec/specs/game-environment-variables/spec.md` states "No constraint SHALL be placed on the `value` field").
- Wizard env UI: `environment-step.component.tsx`; only the `name` input has an error slot today.

## Decision chain

**Q1 — What does the game actually need: literal IPv4 or a stable public address?**
→ **Both, as separate variables.** A DNS-hostname variable (known pre-start) and a literal-IPv4 variable (post-start only) with different resolution mechanisms.

**Q2 — Catalog scope for v1?**
→ **Just the two network variables**, with the mechanism designed for extension. YAGNI on a larger catalog.

**Q3 — Placeholder grammar?**
Options considered: extend the existing `{token}` grammar (one grammar repo-wide, but bare `{word}` collides with JSON fragments in env values); bare `${network.*}` (collides with shell-style `${VAR}` expansion some images use); prefixed `${hyveon.*}`.
→ **`${hyveon.<namespace>.<name>}`**, allow-list only. Unknown `${hyveon.*}` tokens are validation errors; any other `${...}`/`{...}` text passes through untouched.

**Q4 — Resolution mechanism for the literal IPv4?**
Options considered: pre-allocated Elastic IP per game (IP known at apply time, stable across restarts, but ~$3.65/mo idle cost per game — conflicts with the scale-to-zero cost model); in-container boot-time discovery (zero idle cost, but entryPoint override on arbitrary images); defer IPv4 to a follow-up.
→ **In-container boot-time discovery.**

**Q5 — Design approval + failure mode.**
→ Design approved as presented, including the `command` requirement for ipv4-token games. On discovery failure: **fail the task start** (wrapper exits non-zero after ~60s of retries) rather than launching with an unresolved/wrong address.

## Approved design (as presented)

1. **Token grammar & catalog (v1)** — `${hyveon.<namespace>.<name>}`, allow-list only. Catalog: `${hyveon.network.public-address}` → `<game>.<zone>` hostname; `${hyveon.network.public-ipv4}` → task public IPv4. Tokens may be embedded in larger strings (`host=${hyveon.network.public-ipv4}:8211`). `GameServerEnvironmentVariable.value` stays a plain string.
2. **Resolution mechanics** —
   - `public-address`: substituted at Pulumi apply time in `ecs.ts` (same seam Caddy uses). Zero runtime changes.
   - `public-ipv4`: raw token stays in the task definition; `ecs.ts` sets an inline `sh -c` entryPoint wrapper generated at apply time (no EFS staging, no new Lambda, no IAM/taskRole changes). The wrapper loops on `https://checkip.amazonaws.com` (wget/curl fallback, ~60s timeout), substitutes the IP into exactly the env vars infra knows carry the token, then `exec`s the operator-supplied command. Generation single-quote-escapes operator strings (injection-safe by construction).
   - Consequence: new optional `command: string[]` field on `GameServer` — required when any env value uses the ipv4 token, because the entryPoint override clears the image's default `CMD`/`ENTRYPOINT`. Image must contain `/bin/sh` (documented constraint).
3. **Validation & wizard UX** — extend `checkEnvironmentVariables` mirroring `checkConnectMessagePlaceholders`: allow-list check on values, new `environment[N].value` issue path + value error slot in `environment-step.component.tsx`; wizard hint lists available tokens. `public-address` with no hosted zone configured → error at deploy/preview time in infra. Amends the `game-environment-variables` spec's "no constraint on value" clause.
4. **Error handling** — discovery failure after retries exits non-zero → task stops → normal stopped-task visibility. No silently wrong address.
5. **Testing** — shared token parser/substituter + escaping units; validator cases; `ecs.ts` task-def snapshots with/without tokens; wizard value-error integration test; wrapper-script generator unit tests plus a local `sh` execution test against a stubbed IP endpoint.
