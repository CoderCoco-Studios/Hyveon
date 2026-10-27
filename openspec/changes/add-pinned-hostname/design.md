## Context

Foundry VTT signs `/data/Config/license.json` against the host it runs on and re-verifies the signature on every start. On Fargate the container hostname cannot be set (`awsvpc` ignores the container-definition `hostname` parameter) and changes on every `RunTask`, so each start fails verification, prompts for the EULA, and re-signs for a host that will never be seen again. The license key itself is never removed.

Verified locally (`felddy/foundryvtt:release`, Foundry v14.369, real license): a CommonJS preload via `NODE_OPTIONS=--require <shim>` that replaces `os.hostname()` with a constant makes verification succeed across container hostname changes after a single signing.

Current state in the codebase:

- `app/packages/infra/src/ecs.ts` builds one task definition per `gameServers` entry: the game container, plus a Caddy sidecar and its EFS volume when `https` is true. Environment values pass through `resolveGameEnvironment` (public-address token) and, when the ipv4 token is used, an inline `/bin/sh -c` wrapper entrypoint.
- `app/packages/shared/src/gameServerValidator.ts` holds the zod `gameServerSchema` plus deep rules (`checkEnvironmentVariables`, `checkAbsolutePaths`, `checkHttpsPortRules`, …) aggregated by `validateGameServer`.
- The add-game wizard (`@hyveon/web`, React) has steps identity → resources → networking → storage → environment → review; `EditGameForm` reuses the step components.

Constraints: no ECS Service; every per-game resource fans out from `DeploymentConfig.gameServers`; Caddy terminates TLS in-task and is out of scope here; `@hyveon/shared`'s barrel gains no AWS imports; no secrets in config.

## Goals / Non-Goals

**Goals:**

- An operator can make `os.hostname()` return a fixed value inside one game's container by setting one optional field.
- Games without the field produce byte-identical task definitions (no preview diff on upgrade).
- Coexists with operator `NODE_OPTIONS`, env tokens, the ipv4 wrapper, `command`, and HTTPS.
- Settable from the add/edit-game wizard with clear guidance on when to use it.

**Non-Goals:**

- A Foundry VTT preset/template.
- Hostname pinning for non-Node games (`LD_PRELOAD`, UTS namespaces).
- Changing the Caddy sidecar, DNS, or security groups.
- Avoiding the one-time EULA acceptance when enabling the field on an existing game.

## Decisions

### D1: Field shape: `pinnedHostname?: string` holding the literal value

- **Choice**: one optional string on `GameServer` (so `GameServerConfig`). Absent = off. Present = the exact string `os.hostname()` returns.
- **Rationale**: lets an operator choose (or match an existing) host; one field, one meaning.
- **Alternatives considered**: boolean derived from the game key (can't match an existing license host, can't rename later); generic `nodePreload` scripts list (arbitrary-code surface for one behavior).

### D2: Validation alphabet

- **Choice**: `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`. Exported as `PINNED_HOSTNAME_PATTERN` with a `…_DESCRIPTION` string beside it, the same way `GAME_NAME_PATTERN` is, so wizard and server phrase the error identically.
- **Rationale**: the value is only returned from JS, never DNS-resolved, and the verified test value (`my_foundry_host`) uses underscores. The restricted set can't escape a JS string or a shell argument.
- **Alternatives considered**: strict RFC 1123 (rejects the verified underscore value); free text (needs escaping guarantees we don't want to own).

### D3: Delivery: init container + task ephemeral volume

- **Choice**: when `pinnedHostname` is set, the task definition gains:
  - volume `{ name: '<game>-hostname-shim' }`, with no `efsVolumeConfiguration`, so Fargate backs it with task ephemeral storage;
  - container `hostname-shim`: `essential: false`, image per D4, command `['/bin/sh', '-c', 'echo <base64> | base64 -d > /hyveon/hostname-shim/hostname-shim.js']`, read-write mount of the volume, `awslogs` with stream prefix `hostname-shim`;
  - on the game container: `dependsOn: [{ containerName: 'hostname-shim', condition: 'SUCCESS' }]`, an extra mount point `{ sourceVolume: '<game>-hostname-shim', containerPath: '/hyveon/hostname-shim', readOnly: true }`, and `NODE_OPTIONS` per D6.
- **Rationale**: nothing persists or touches save data; regenerated identically each start; entirely inside the existing per-game loop; ECS guarantees ordering via `dependsOn`.
- **Alternatives considered**: `file_seeds` onto EFS (Hyveon code in operator save data, needs a suitable volume, removed seeds aren't deleted); inline `--import=data:` ESM shim (no extra container but unverified, quoting-sensitive, named builtin imports need `syncBuiltinESMExports()`; candidate follow-up spike); custom image (Hyveon never builds images).

### D4: Init-container image

- **Choice**: `public.ecr.aws/docker/library/busybox:1.38.0`, as a named constant in `hostnameShim.ts`. `1.38.0` was the newest busybox release on 2026-10-26 (Docker Hub push 2026-09-23) and resolves on the ECR Public mirror. The implementing PR re-checks the registry and pins the then-latest exact tag.
- **Rationale**: ~2 MB, ships `/bin/sh` + `base64`; ECR Public sidesteps Docker Hub anonymous pull-rate limits; exact tag keeps task definitions reproducible.
- **Egress**: none new. Tasks already pull public images (game image, `caddy:2-alpine`) over the same public-subnet path.
- **Alternatives considered**: `alpine` (bigger, nothing extra needed); reusing the Caddy image (only present on HTTPS games); Docker Hub `busybox` (rate limits).

### D5: Shim ownership and generation

- **Choice**: `app/packages/infra/src/hostnameShim.ts` owns the shim source, the base64 encoding, the init-container builder, and the `NODE_OPTIONS` merge. `@hyveon/shared` owns only `PINNED_HOSTNAME_PATTERN`, its description, and `HOSTNAME_SHIM_MOUNT_PATH = '/hyveon/hostname-shim'` (plain constants, barrel-safe), because the validator needs the reserved path.
- Shim body (hostname embedded with `JSON.stringify`):
  ```js
  const os = require('node:os');
  os.hostname = () => "<pinnedHostname>";
  ```
- **Rationale**: infra is the only consumer of the bytes; base64 means no shell quoting is ever involved; the shim stays identical to the verified one.
- **Alternatives considered**: shim in shared (pulls infra-only bytes into the renderer/Lambda bundles); heredoc in the command (quoting hazards); also rewriting `process.env.HOSTNAME` (unneeded; masks the real host).

### D6: `NODE_OPTIONS` conflict policy: merge, shim first

- **Choice**: after `resolveGameEnvironment`, if the resolved environment contains `NODE_OPTIONS`, replace that entry's value with `--require=/hyveon/hostname-shim/hostname-shim.js <operator value>`; otherwise append `{ name: 'NODE_OPTIONS', value: '--require=/hyveon/hostname-shim/hostname-shim.js' }`. Exactly one `NODE_OPTIONS` reaches the container.
- **Rationale**: Node images commonly need `NODE_OPTIONS` (heap size etc.). Rejecting would force a choice between the license and the operator's flags. Merging after token resolution keeps env-token semantics unchanged; an ipv4 token in the operator's value survives for the boot wrapper.
- **Alternatives considered**: reject with a validation error (blocks a legitimate combination); append shim last (any operator flag that errors would also prevent the shim from loading, and it's harder to spot in the console).

### D7: Reserved-path collision

- **Choice**: when `pinnedHostname` is set, `checkPinnedHostname` rejects any `volumes[i].container_path` equal to `/hyveon/hostname-shim` or under it (`/hyveon/hostname-shim/…`), with path `volumes[i].container_path`.
- **Rationale**: ECS would reject or shadow overlapping mounts at `RunTask` time; validation is the earlier, clearer failure.

### D8: Wizard placement and behavior

- **Choice**: the environment step gets a "Pin hostname" switch. Turning it on sets `draft.pinnedHostname` to the game name (falling back to empty if the name is empty); off clears it. A text input bound to the value is shown when on, with an inline validation message. Helper text leads with the requirement: "Node.js game servers only. Pins the hostname the Node process sees, for games whose license is bound to the hostname (e.g. Foundry VTT). Has no effect on games that don't run on Node; check what your image runs before enabling. Enabling this on an existing game requires accepting the EULA one more time." The review step shows `Pinned hostname: <value>` when set. `draftFromGameServer`, `draftToPayload`, and `toProposedEntry` carry the field: off (`undefined`) omits it; on with an empty string is passed through so the pattern rule blocks the step rather than silently saving nothing.
- **Rationale**: no "advanced" section exists; the environment step already owns the other process-start knobs; `EditGameForm` reuses `EnvironmentStep`, so editing is covered with no extra component. Hyveon can't detect an image's runtime, so the Node.js requirement is the operator's call and the helper text says so first.

### D9: Drift

- **Choice**: no new `DriftChangedField`. The set is deliberately closed; `environment`, `command`, and `https` aren't in it either.

## Risks / Trade-offs

- [Risk] A future Foundry release stops using `os.hostname()` (e.g. reads `/etc/hostname` or a native binding) → Mitigation: docs state the dependency explicitly. Symptom is a return to today's behavior (EULA each start), not data loss. The infra test pins only Hyveon's half (shim content and wiring).
- [Risk] An operator enables it on a game that doesn't run on Node.js; the shim is silently ignored and the license problem persists → Mitigation: Hyveon can't inspect an image's runtime, so the wizard helper text and docs state "Node.js game servers only" up front and tell the operator to confirm what their image runs. The task still starts normally (the init container succeeds, and `NODE_OPTIONS` is inert outside Node).
- [Risk] The image strips or overrides `NODE_OPTIONS` before launching Node → Mitigation: docs scope the feature to Node-based images that pass the environment through; felddy's image verified locally.
- [Risk] The init container fails (image pull outage, ECR Public throttling) → Mitigation: `dependsOn: SUCCESS` means the game container never starts, and the task stops with the init container's exit reason in its ECS stopped reason and the `hostname-shim` log stream; nothing half-starts without the shim.
- [Risk] Busybox tag goes stale → Mitigation: exact pin in one named constant; the dependency rule requires a registry check whenever it's touched.
- [Trade-off] Enabling on an existing game still needs one EULA acceptance (existing signature is for the last random host) → accepted. Documented in the wizard helper text and docs. An operator who knows the old signing host could enter it to try to avoid that (unverified).
- [Trade-off] Opted-in games pull one extra ~2 MB image per start, adding about a second → accepted; negligible against game-image pulls.
- [Trade-off] Node-only → accepted; it's the verified case and the only known consumer.

## Migration Plan

1. Ship shared type + validation, infra wiring, wizard control, and docs together. Existing configs validate unchanged and preview with zero diff (the field is absent).
2. Operator opt-in for Foundry: edit the game → environment step → enable "Pin hostname" (default value = game key) → save → apply. The task definition gets a new revision.
3. First start after enabling: accept the EULA once (Foundry re-signs `license.json` for the pinned host). Every later start verifies without a prompt.
4. Operators currently running the manual workaround (a shim on EFS plus a hand-set `NODE_OPTIONS`) should remove that `NODE_OPTIONS` env entry when enabling the field. If it stays, the merge yields two `--require`s and the operator's shim loads second, so its hostname wins; that's harmless only while both values match. Entering the same hostname value the manual shim used avoids a re-sign.
5. Rollback: clear the field and apply. The task definition returns to the pre-feature shape. Foundry then fails verification on the next start (the pre-feature behavior); no data is lost.

Acceptance: lint/typecheck/unit suite green; `ecs.test.ts` asserts the absent-field snapshot is unchanged and the present-field container/volume/env wiring; validator tests cover the pattern, the reserved path, and the merge; wizard jsdom tests cover toggle/default/round-trip; one live Foundry start on a real stack verifies `Software license verification succeeded` after the one-time acceptance (manual, recorded in verify.md).

## Open Questions

- Does entering the host an existing `license.json` was signed for skip the one-time EULA? Unverified; docs say "may". Owner: operator, during the first live rollout. Doesn't change what gets built.
- Is the `--import=data:` variant (no init container) viable for Foundry's ESM entry point? Follow-up spike only; doesn't block this change.
