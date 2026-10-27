## Why

Foundry VTT binds its license signature to the container hostname, and Fargate (`awsvpc`) cannot set one: every task gets a fresh `ip-10-0-x-y.<region>.compute.internal`. So every start logs `Software license verification failed` and blocks on a manual EULA acceptance before the server is usable, which defeats Hyveon's on-demand Discord starts. A `NODE_OPTIONS=--require` shim that pins `os.hostname()` to a constant was verified locally against `felddy/foundryvtt` v14.369 with a real license: one signing, then clean verification across hostname changes. Hyveon needs a first-class, per-game way to apply it.

## What Changes

**Per-game pinned hostname (new optional field)**
- From: a game's container always sees the random per-task Fargate hostname; there is no way to influence what `os.hostname()` returns.
- To: `GameServerConfig.pinnedHostname?: string`. When set, the game's task definition gains a task-scoped ephemeral volume, a non-essential `hostname-shim` init container (`public.ecr.aws/docker/library/busybox`) that writes a generated `hostname-shim.js` into it, a `dependsOn: SUCCESS` edge from the game container, a read-only mount at the reserved path `/hyveon/hostname-shim`, and `NODE_OPTIONS=--require=/hyveon/hostname-shim/hostname-shim.js` (prepended to any operator-supplied `NODE_OPTIONS`).
- Reason: lets Node-based games with hostname-bound licensing (Foundry VTT today) start unattended.
- Impact: non-breaking. Absent field = byte-identical task definition. Enabling it on an existing game needs one final EULA acceptance, after which every start verifies cleanly.

**Validation**
- `pinnedHostname` must match `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`.
- An operator volume whose `container_path` is, or sits under, `/hyveon/hostname-shim` is rejected when the field is set.

**Add/edit-game wizard**
- The environment step gains a "Pin hostname" switch with a hostname field pre-filled with the game key. Helper text leads with "Node.js game servers only": the shim works only when the game process runs on Node, and Hyveon can't detect an image's runtime, so the operator must know what their image runs. It also names the use case (hostname-bound licensing, e.g. Foundry VTT) and the one-time EULA caveat. The review step shows the pinned value.

Out of scope: a Foundry preset, non-Node games, any Caddy-sidecar change.

## Capabilities

### New Capabilities

- `game-hostname-pinning`: the optional `pinnedHostname` field: its validation, the init-container/ephemeral-volume/`NODE_OPTIONS` task-definition wiring and merge rule, the unchanged-when-absent guarantee, and the wizard control.

### Modified Capabilities

None. Existing requirements (`pulumi-infra-program`'s typed config model and token-free-unchanged guarantee, `in-task-tls-termination`'s Caddy sidecar, `game-environment-variables`) continue to hold as written; the new capability only adds behavior behind an opt-in field.

## Impact

- `@hyveon/shared`: `GameServer.pinnedHostname` + TSDoc (`gameServerConfig.ts`); `gameServerSchema` field + `checkPinnedHostname` deep rule + reserved-path constant (`gameServerValidator.ts`).
- `@hyveon/infra`: new `hostnameShim.ts` (shim source, init-container builder, `NODE_OPTIONS` merge); `ecs.ts` wires it into the per-game task definition.
- `@hyveon/web`: `WizardDraft` + `draftFromGameServer`/`draftToPayload`/`toProposedEntry` (`wizard-form.utils.ts`), `environment-step.component.tsx`, `review-step.component.tsx`.
- Mirrored type copies: `GameServer` in `@hyveon/desktop-preload`'s `hyveon-api.ts`; `GameWizardDraft` in `@hyveon/web`'s `api.service.ts` and `@hyveon/desktop-main`'s `ElectronStoreService.ts`, plus the `isGameWizardDraft` guard in `GameWizardDraftService.ts`. Removing those copies is out of scope; this change only keeps them in step.
- `@hyveon/desktop-main`: `diagnosticsBundleAllowlist.ts` gains a `hasPinnedHostname` flag.
- Docs: `docs/docs/components/infra.md` (new `hostnameShim.ts` row, `ecs.ts` row, task-definition contents), `docs/docs/app/games.md` (the new control and its caveats).
- AWS: no new resources. Opted-in games get a revised task definition with one extra container and one ephemeral volume. One extra public image pull (~2 MB) per start for those games.
- Invariants preserved: no ECS Service, all per-game wiring stays inside the `gameServers` fan-out, Caddy sidecar untouched, no secrets in config.
