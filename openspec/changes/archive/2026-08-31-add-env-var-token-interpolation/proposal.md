## Why

Game server env values are static strings frozen into the ECS task definition, so operators must hard-code addresses that Hyveon itself owns and can change — the per-game public hostname and the task's public IPv4. Servers that advertise their own address (e.g. to master server lists or clients) either break when the address changes or can't be configured at all, since the public IP doesn't even exist until the task is running. Token interpolation lets a game's env vars reference these values symbolically and have Hyveon resolve them at the right time.

## What Changes

**Env value validation**
- From: `GameServerEnvironmentVariable.value` is entirely unconstrained.
- To: values may embed `${hyveon.<namespace>.<name>}` tokens from an allow-list (`${hyveon.network.public-address}`, `${hyveon.network.public-ipv4}`); unknown `${hyveon.*}` tokens are validation errors. All other text — including other `${...}`/`{...}` syntax — passes through untouched.
- Reason: tokens must fail at config time, not silently reach the container.
- Impact: non-breaking — existing values containing no `${hyveon.` prefix are unaffected.

**Task definition build (infra)**
- From: env values pass into `containerDefinitions.environment` verbatim; game container sets no `entryPoint`/`command`.
- To: `${hyveon.network.public-address}` is substituted with `<game>.<zone>` at Pulumi apply time (error if no hosted zone is configured). When any env value carries `${hyveon.network.public-ipv4}`, infra generates an inline `sh -c` entryPoint wrapper that discovers the public IP at container boot (checkip.amazonaws.com, wget/curl fallback, ~60s retry budget), substitutes it into exactly the affected env vars, and `exec`s the operator-supplied command; discovery failure exits non-zero so the start fails visibly.
- Reason: the hostname is deterministic pre-start; the IP only exists post-start — two resolution seams.
- Impact: non-breaking for games not using tokens (task definitions unchanged).

**New `GameServer.command` field**
- From: no start-command field; images always use their built-in `ENTRYPOINT`/`CMD`.
- To: optional `command: string[]`; required by validation when any env value uses the ipv4 token (the entryPoint override clears the image's default start chain). Image must provide `/bin/sh` (documented constraint).
- Reason: Hyveon cannot know an arbitrary image's original start command.
- Impact: non-breaking; only ipv4-token users must supply it.

**Wizard/edit UI**
- Env value inputs gain validation errors (new `environment[N].value` issue path plus a value error slot) and a hint listing available tokens; the add/edit game surfaces gain the optional `command` field.

## Capabilities

### New Capabilities
- `env-token-interpolation`: the `${hyveon.*}` token grammar, the v1 token catalog (`network.public-address`, `network.public-ipv4`), resolution timing semantics (apply-time vs boot-time), the boot-time discovery wrapper behavior and failure mode, and the `command` field contract it depends on.

### Modified Capabilities
- `game-environment-variables`: the "No constraint SHALL be placed on the `value` field" requirement is replaced by allow-list token validation; env value inputs gain error display and a token hint in the wizard/edit UI.
- `pulumi-infra-program`: task-definition construction gains apply-time token substitution, conditional entryPoint wrapper generation, `command` passthrough, and a hosted-zone precondition error for the hostname token.

## Impact

- `@hyveon/shared`: token constants/parser/substituter, `GameServer.command` type + zod schema, `checkEnvironmentVariables` extension (new `environment[N].value` issue path).
- `app/packages/infra/src/ecs.ts`: apply-time substitution, wrapper-script generation (injection-safe escaping), `command`/`entryPoint` wiring.
- `@hyveon/web`: `environment-step.component.tsx` value error slot + token hint; add/edit game `command` input; `wizard-form.utils.ts` projection.
- Docs: `docs/docs/components/infra.md` (field/resource table), env var operator guidance pages.
- No Lambda, IAM, DNS, or RunTask call-site changes. No new AWS resources.
