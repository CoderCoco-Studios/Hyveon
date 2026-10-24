## Context

Per-game env vars (`GameServerEnvironmentVariable[]` in `@hyveon/shared`, `gameServerConfig.ts:52-58`) flow verbatim into the ECS container definition at Pulumi apply time (`app/packages/infra/src/ecs.ts:178`) and are frozen into the task definition revision. Neither RunTask call site (`AwsCloudProvider.ts:451`, `lambda/followup/src/handler.ts:139`) passes container overrides — and overrides could not carry the public IP anyway, because the task's ENI (and therefore its public IPv4) does not exist until after RunTask. The per-game hostname `<game>.<zone>` is the opposite case: fully deterministic at apply time (the Caddy sidecar command already interpolates it, `ecs.ts:198`), with `lambda-update-dns` keeping the A record pointed at whatever IP the current task has.

Game images are operator-supplied and arbitrary; the game container currently sets no `entryPoint` or `command`. The repo's one templating precedent is `connect_message`'s `{host}`/`{ip}`/`{port}`/`{game}` allow-list (`gameServerValidator.ts:532-549`). Env value validation today is name-only; the `game-environment-variables` spec explicitly places no constraint on `value`.

Stakeholders: operators configuring games whose servers advertise their own public address; the infra program; the wizard/edit UI.

## Goals / Non-Goals

**Goals:**
- Let env values reference Hyveon-derived network values symbolically: `${hyveon.network.public-address}` (hostname) and `${hyveon.network.public-ipv4}` (literal IP).
- Fail invalid or unresolvable tokens at config/deploy time (or visibly at start time for boot-resolved tokens), never silently.
- Keep the mechanism extensible to future namespaces/tokens without redesign.
- Zero change to games that use no tokens; zero new AWS resources, Lambdas, or IAM grants.

**Non-Goals:**
- A larger token catalog (ports, region, game name, etc.) — deferred until a concrete need appears.
- Interpolation in any config field other than env values (`connect_message` keeps its existing `{token}` grammar).
- Stable IPs across restarts (an Elastic IP feature would be its own change).
- Supporting images without `/bin/sh` for the ipv4 token.
- RunTask-time container overrides.

## Decisions

### D1: Token grammar — prefixed `${hyveon.<namespace>.<name>}`, allow-list only
- **Choice**: tokens match `${hyveon.<namespace>.<name>}`; only cataloged tokens are legal. Unknown `${hyveon.*}` → validation error. Any other `${...}` or `{...}` text passes through byte-for-byte.
- **Rationale**: the `hyveon.` prefix cannot collide with a game image's own `${VAR}` shell expansion or JSON braces in values; strict allow-listing makes typos fail at save time.
- **Alternatives considered**: extending the existing `{token}` grammar (bare `{word}` collides with JSON fragments in env values); un-prefixed `${network.*}` (false matches against shell-style expansion, and ambiguous unknown-token policy).

### D2: Two variables with two resolution seams
- **Choice**: `public-address` resolves at Pulumi apply time in `ecs.ts` (string substitution into the container definition, same seam as Caddy's hostname). `public-ipv4` resolves at container boot inside the task.
- **Rationale**: the hostname is deterministic pre-start; the IP structurally does not exist until the task is RUNNING. One mechanism cannot serve both without either paying idle EIP cost or making the hostname path needlessly dynamic.
- **Alternatives considered**: per-game Elastic IP (IP known at apply time, stable across restarts, but ~$3.65/mo per game even while stopped — conflicts with the scale-to-zero cost model; user declined); deferring ipv4 entirely (user wants it now).

### D3: Boot-time discovery via inline entryPoint wrapper, no IAM
- **Choice**: when any env value carries the ipv4 token, `ecs.ts` sets the game container's `entryPoint` to `["/bin/sh", "-c", <generated script>]`. The script retries `https://checkip.amazonaws.com` (wget, falling back to curl) within a ~60s budget, substitutes the IP into exactly the env vars that carry the token (the set is known at apply time), then `exec`s the operator's `command`.
- **Rationale**: no EFS staging, no new Lambda, no taskRole/IAM additions (Fargate task metadata does not expose the public IP; the AWS-run checkip endpoint avoids `ec2:DescribeNetworkInterfaces` entirely). Generating targeted substitution lines at apply time keeps the script trivial — no generic env scanning in sh.
- **Alternatives considered**: task role + DescribeNetworkInterfaces from inside the container (IAM surface, needs a JSON parser in arbitrary images); EFS-staged wrapper script (adds seeding lifecycle for no benefit over an inline script); sidecar writing the IP to a shared volume (second moving piece, still needs the entryPoint override).

### D4: Injection-safe script generation
- **Choice**: operator env values are embedded in the generated script inside single quotes with `'` escaped as `'\''`; the IP value is substituted via a shell variable, never re-parsed. The script is assembled by a unit-tested generator in infra.
- **Rationale**: env values are operator-controlled strings entering a shell script — quoting by construction removes the injection class instead of filtering it.
- **Alternatives considered**: blacklist validation of dangerous characters (incomplete by nature, and would restrict legitimate values).

### D5: New optional `GameServer.command: string[]`, required with the ipv4 token
- **Choice**: add `command` to the shared type/zod schema; infra passes it to `containerDefinitions.command`. Validation requires it whenever any env value uses the ipv4 token; without tokens it remains optional passthrough.
- **Rationale**: overriding `entryPoint` clears the image's built-in `ENTRYPOINT`/`CMD` chain, and Hyveon cannot introspect arbitrary registries for the original. Making the operator state the start command is the honest constraint, enforced at save time rather than discovered as a boot crash.
- **Alternatives considered**: requiring it only at deploy time (worse feedback loop); attempting registry inspection of image config (auth/registry sprawl, still unreliable).

### D6: Failure mode — fail the start
- **Choice**: if IP discovery exhausts its retry budget, the wrapper exits non-zero; the task stops and surfaces through normal stopped-task visibility.
- **Rationale**: a server silently advertising a wrong/empty address is harder to diagnose than a visible failed start. (Chris confirmed this explicitly.)
- **Alternatives considered**: launching anyway with the token unresolved (silent misconfiguration).

### D7: Validation shape mirrors the connect_message precedent
- **Choice**: extend `checkEnvironmentVariables` with an allow-list token check on values (new `environment[N].value` issue path), mirroring `checkConnectMessagePlaceholders`; add the matching value error slot in `environment-step.component.tsx` (only `name` has one today) plus a hint listing available tokens. The hosted-zone precondition for `public-address` is enforced in infra at preview/apply time (the shared validator does not know whether a zone is configured).
- **Rationale**: same validator pattern operators and the codebase already have; deploy-time is the earliest point the zone question is answerable.

## Risks / Trade-offs

- [Risk] Operator image lacks `/bin/sh` (distroless) → wrapper cannot run. → Mitigation: documented constraint on the ipv4 token; failure is an immediate visible task stop, and the docs page names the symptom.
- [Risk] Operator image lacks both wget and curl → discovery fails. → Mitigation: wget/curl fallback covers the overwhelming majority of game images (busybox/alpine/debian); failure mode is the visible fail-fast exit, documented.
- [Risk] checkip.amazonaws.com unreachable or slow at boot → start fails despite a healthy task. → Mitigation: ~60s retry loop absorbs transient egress lag (the ENI is up before the container starts); the endpoint is AWS-operated.
- [Risk] Shell injection via crafted env values. → Mitigation: D4 — single-quote escaping by construction, generator unit-tested against adversarial values.
- [Trade-off] `command` becomes required for ipv4-token games — extra operator burden. → Accepted: unavoidable consequence of the entryPoint override; enforced at save time with a clear message.
- [Trade-off] The public IP env value changes on every restart (Fargate IPs are ephemeral). → Accepted: inherent to the no-EIP cost model; the hostname token is the stable alternative and is documented as such.

## Migration Plan

Non-breaking, additive. Existing games redeploy with byte-identical task definitions (no tokens → no substitution, no entryPoint, no command). Rollout is an ordinary app release plus a Pulumi apply for games that adopt tokens. Rollback: remove tokens from the game's env config and redeploy — no state or resource cleanup involved.

## Open Questions

None — all design forks were resolved in brainstorming (grammar, catalog scope, ipv4 mechanism, failure mode, `command` requirement).
