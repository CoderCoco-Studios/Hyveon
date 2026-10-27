<!--
Raw capture of superpowers:brainstorming output (2026-10-26 session).
design.md reorganizes this into a structured design document.
-->

# Brainstorm: pinned hostname for hostname-bound game licenses

## Background (how this change was born)

Live debugging session, 2026-10-26. The operator runs Foundry VTT (`felddy/foundryvtt:release`, Foundry v14.369) as a Hyveon game. On every task start the server logs `Software license verification failed`, every client connect shows the EULA prompt, and the server only comes up after someone accepts the EULA and Foundry re-signs `/data/Config/license.json`. That blocks unattended starts from Discord.

Evidence chain:

- felddy's README: "Foundry binds its software license to the container hostname." The signature inside `license.json` records the host it was signed on.
- Fargate (`awsvpc` network mode) does not support the container-definition `hostname` parameter (AWS re:Post confirms). Each task gets `ip-10-0-x-y.<region>.compute.internal`, which changes on every `RunTask`.
- The container does not delete the license (`Not modifying existing installation license key`); the key itself stays valid. Only the host-bound signature fails.

Verified fix (local Docker, real license, 4-run matrix on `felddy/foundryvtt:release` 14.369): preload a CommonJS shim through `NODE_OPTIONS=--require <path>` that replaces `os.hostname()` with a constant.

```js
const os = require('node:os');
os.hostname = () => 'my_foundry_host';
```

- New container hostname, no shim → verification failed; `license.json` still recorded the old host.
- Sign once with the shim, restart with a *different* container hostname plus the shim → `Software license verification succeeded`, no EULA prompt.

So the problem reduces to: deliver a small JS file into the game container's filesystem and set `NODE_OPTIONS`, per game, opt-in, without breaking any Hyveon invariant.

## Path classification

Project-sized, routed through OpenSpec: it adds a `GameServerConfig` field (deployment-config surface), changes task-definition generation in `@hyveon/infra`, and adds a wizard control. The operator pre-supplied the problem, the verified fix, and the shape of the design, and asked for the open questions to be resolved with recommendations rather than a question round. Scope is this field only; a Foundry game preset is explicitly out of scope.

## Decision chain

### Q1 — How is the feature modeled in `deployment-config.json`?

- **Chosen (operator-specified): `GameServerConfig.pinnedHostname?: string`.** Absent = feature off, task definition byte-identical to today. Present = the literal hostname `os.hostname()` returns inside the game container.
- Rejected: a boolean `pinHostname: true` with the value derived from the game key. Simpler UI, but an operator migrating an existing install cannot match the host their current `license.json` was signed for, and renaming is impossible without a new field later.
- Rejected: generic "preload scripts" (`nodePreload: string[]`). More powerful, but it turns a single, verifiable behavior into an arbitrary-code surface in the config and the wizard. YAGNI.

### Q2 — Is the hostname value configurable or derived from the game key?

Configurable, with the game key as the wizard's pre-filled default. The game key already matches `GAME_NAME_PATTERN` (DNS-label-safe, ≤32 chars), so the default is always valid. Making it editable lets an operator migrating an existing server type the host the old license was signed for — *possibly* skipping even the one-time EULA re-sign (unverified; recorded as such).

### Q3 — What hostname values are valid?

`^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$` — 1–63 chars, alphanumeric at both ends, letters/digits/`.`/`_`/`-` inside. Not strict RFC 1123: the value is only ever returned from a JS function, never resolved via DNS, and the operator's verified test host (`my_foundry_host`) contains underscores. The restricted alphabet also means the value can never break out of the JS string literal or the shell command that writes the shim (the shim is base64-embedded anyway, see Q6).

### Q4 — How does the shim file get into the game container?

Options considered:

- **A (chosen, operator-specified): init container + task-scoped ephemeral volume.** A non-essential init container writes `hostname-shim.js` into a bind-mount volume with no EFS config (Fargate task ephemeral storage); the game container `dependsOn` it with `condition: SUCCESS` and mounts the volume read-only. Nothing persists, nothing lands in the operator's save data, and the shim is regenerated identically on every start.
- B: `file_seeds` onto the game's EFS volume. Reuses the existing seeder Lambda, but writes Hyveon-owned code into the operator's save data, depends on the game having a volume whose path the shim can live under, and the seeder only re-applies on content change; removed seeds are never deleted, so turning the feature off would leave the file behind.
- C: no file at all: `NODE_OPTIONS=--import=data:text/javascript,...` with an inline ESM shim that patches the shared `node:os` exports. Zero extra containers or volumes, but untested against Foundry, needs NODE_OPTIONS quoting for spaces, and named ESM imports of builtins need `syncBuiltinESMExports()`. Worth a follow-up spike; not the v1 mechanism because A is the verified one.
- D: bake a custom image. Rejected: Hyveon never builds images; the operator's image reference is used verbatim.

### Q5 — Which init-container image, and does it need new egress?

`public.ecr.aws/docker/library/busybox:1.38.0` (Docker official image mirrored on ECR Public). Checked on 2026-10-26: `1.38.0` is the newest busybox release on Docker Hub (pushed 2026-09-23) and its manifest resolves on the ECR Public mirror. ~2 MB, has `/bin/sh` and `base64`. ECR Public avoids Docker Hub anonymous pull-rate limits. No new egress: game tasks already pull public images (game images, `caddy:2-alpine`) over the same public-subnet/public-IP path. The implementing PR re-checks the registry for the latest tag per the repo's dependency rule.

### Q6 — Where do the shim bytes live, and how is the shim written?

- The shim source and the init-container definition live in `@hyveon/infra` (a new `hostnameShim.ts`): infra is the only consumer of the bytes, and keeping them out of `@hyveon/shared` keeps the renderer bundle and Lambdas free of it.
- The reserved mount path (`/hyveon/hostname-shim`) is a plain string constant in `@hyveon/shared` because the validator (shared) must reject operator volumes that collide with it and infra must mount there. No AWS imports, so barrel-safe.
- The init container's command decodes a base64 payload (`echo <b64> | base64 -d > <path>`) rather than heredoc-ing JS through a shell, so no quoting or escaping is ever involved even if the hostname alphabet widens later. The hostname is embedded into the JS via `JSON.stringify` before encoding.
- The shim stays as close as possible to the verified one: patch `os.hostname` only. No `process.env.HOSTNAME` rewrite — not needed for Foundry and it would mask the real host from scripts that legitimately read it.

### Q7 — What if the operator also sets `NODE_OPTIONS` in the game's environment?

Merge, don't reject. The generated value is `--require=/hyveon/hostname-shim/hostname-shim.js` followed by a space and the operator's value. Node-based game images commonly need `NODE_OPTIONS` (e.g. `--max-old-space-size`), and forcing an operator to choose between their memory flag and their license is hostile. Prepending keeps the shim first and leaves every operator flag intact. The operator's `NODE_OPTIONS` entry is consumed by the merge (exactly one `NODE_OPTIONS` reaches the container). Interpolation tokens in the operator's value are resolved before merging, so the existing env-token rules still apply.

Rejected: reject-with-validation-error. Simpler to specify but makes a legitimate combination impossible.

### Q8 — Where does the wizard control go?

The add-game wizard has no "advanced" section today. The `environment` step is the natural home: it already owns `environment` and `command`, which are the other "how the process starts" knobs, and the edit-game form reuses `EnvironmentStep`, so edit support comes for free. Control: a "Pin hostname" switch; when on, a text field pre-filled with the game key. Helper text: for Node-based games whose licensing is bound to the hostname (e.g. Foundry VTT); enabling on an existing game requires accepting the EULA once more. The review step lists the pinned value when set.

### Q9 — Does drift detection need to know about the field?

No new `DriftChangedField`. That set is deliberately closed and lists only fields surfaced to operators as drift categories; `pinnedHostname` changes still reach the deployed state through the normal apply path, exactly like `environment`, `command`, and `https` (none of which are in the set today).

## Known limits (operator-supplied, confirmed)

- Node-only. Non-Node games with hostname-bound licensing need a different mechanism; out of scope. Operator follow-up (mid-session): the operator must know the game they're enabling it for runs on Node. Hyveon can't detect an image's runtime, so the wizard helper text leads with "Node.js game servers only" and the docs say the same.
- Enabling the field on an existing game still needs one EULA acceptance: the existing `license.json` is signed for the last random Fargate host.
- Relies on the game reading the host via `os.hostname()`. A future Foundry release could read `/etc/hostname` or a native call instead; docs say so and the infra test pins only Hyveon's half of the contract.
- Image must run its game under Node and must not clear `NODE_OPTIONS` before exec. felddy's image passes the environment through (verified locally).

## Out of scope

- A Foundry game preset/template.
- Non-Node hostname pinning (`LD_PRELOAD` `gethostname` shims, UTS namespaces, which Fargate does not expose).
- The data-URL `--import` variant (Q4-C): follow-up spike only.
