# Pinned Hostname Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator pin the hostname a game's Node.js process sees (`os.hostname()`) via an optional `pinnedHostname` field, so hostname-bound licenses (Foundry VTT) verify on every Fargate start.

**Architecture:** One optional field on `GameServer` (`@hyveon/shared`) with a pattern + reserved-path rule. `@hyveon/infra` turns it into a per-task-definition init container (busybox) that writes a base64-embedded CommonJS shim into an ephemeral volume, which the game container mounts read-only and preloads via a shim-first merged `NODE_OPTIONS`. The wizard's environment step gets a switch + field.

**Tech Stack:** TypeScript npm workspaces, zod (`@hyveon/shared`), Pulumi AWS (`@hyveon/infra`), React + vitest/jsdom (`@hyveon/web`).

**Spec:** `openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md` (design: `openspec/changes/add-pinned-hostname/design.md`)

## Global Constraints

- Node.js-only feature; every operator-facing string about it leads with that (design D8).
- Hostname pattern: `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`.
- Reserved mount path: `/hyveon/hostname-shim`; shim file `/hyveon/hostname-shim/hostname-shim.js`.
- `NODE_OPTIONS` value: `--require=/hyveon/hostname-shim/hostname-shim.js`, then a space and the operator's resolved value when present; exactly one entry.
- Games without the field: container definitions and volumes byte-identical to today.
- No ECS Service; no resource outside the task definition; Caddy definition untouched; `@hyveon/shared` barrel gains no AWS imports.
- Init image: exact tag on `public.ecr.aws/docker/library/busybox`, re-checked against the registry at implementation time (was `1.38.0` on 2026-10-26).
- TSDoc per `.claude/rules/tsdoc-tags.md`; comments per `comment-conciseness.md`; tests per `testing-conventions.md`.

## Review Focus

1. Operator already has `NODE_OPTIONS` containing a `${hyveon.network.public-ipv4}` token → token must survive the merge for the boot wrapper (Task 2 test `keeps ipv4 token in merged NODE_OPTIONS`).
2. Hostname with `.`/`_` (e.g. `my_foundry_host`) → shim returns it verbatim, no escaping artefacts (Task 2 test `shim returns underscore hostname`).
3. Turning the switch on before a game name is entered → field starts empty and shows the pattern error rather than silently saving `""` (Task 3 test `enabling with empty name shows validation`).
4. Volume at `/hyveon/hostname-shimmer` (prefix but not a child) → must NOT be rejected (Task 1 test `sibling path with shared prefix is allowed`).
5. Edit form opened on a game without the field, then saved unchanged → payload must not gain `pinnedHostname` (Task 3 test `untouched edit omits field`).

---

### Task 1: Shared field and validation

**Files:**
- Modify: `app/packages/shared/src/gameServerConfig.ts` (`GameServer`, after `healthCheck`)
- Modify: `app/packages/shared/src/gameServerValidator.ts` (constants near `GAME_NAME_PATTERN` ~L50; `gameServerSchema` ~L271; new `checkPinnedHostname`; register in `validateGameServer` ~L921)
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Produces: `GameServer.pinnedHostname?: string`; `PINNED_HOSTNAME_PATTERN: RegExp`; `PINNED_HOSTNAME_PATTERN_DESCRIPTION: string`; `HOSTNAME_SHIM_MOUNT_PATH = '/hyveon/hostname-shim'`; issues at paths `pinnedHostname` and `volumes[i].container_path`.

- [ ] **Step 1: Write failing tests** in a `describe('pinnedHostname')` block calling `validateGameServer('foundry', entry, [])` on a valid base entry:
  - `accepts my_foundry_host` → no issue with path `pinnedHostname`.
  - `rejects "foundry host"`, `rejects "-foundry"`, `rejects 64-char value` → an issue with path `pinnedHostname` whose message includes `PINNED_HOSTNAME_PATTERN_DESCRIPTION`.
  - `rejects volume at reserved path` (`container_path: '/hyveon/hostname-shim'`) and `rejects volume under reserved path` (`'/hyveon/hostname-shim/x'`) → issue at `volumes[0].container_path`.
  - `sibling path with shared prefix is allowed` (`'/hyveon/hostname-shimmer'`) → no reserved-path issue.
  - `reserved path is free when field absent` → no reserved-path issue.
  - `redactGameServer preserves pinnedHostname`.
- [ ] **Step 2: Run** `npx vitest run app/packages/shared/src/gameServerValidator.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.** Field TSDoc: Node.js-only, patches `os.hostname()` through a `NODE_OPTIONS` preload, enabling on an existing game needs one EULA acceptance, default when omitted: not pinned. Add `pinnedHostname: z.string().optional()` to the schema. `function checkPinnedHostname(entry: GameServerEntryInput): GameServerValidationIssue[]`: returns nothing when the field is undefined.
- [ ] **Step 4: Run** the same command — expected PASS. Then `npm run app:typecheck` — clean.
- [ ] **Step 5: Commit** `feat(shared): add pinnedHostname field and validation`.

### Task 2: Infra shim and task-definition wiring

**Files:**
- Create: `app/packages/infra/src/hostnameShim.ts`
- Create: `app/packages/infra/src/hostnameShim.test.ts`
- Modify: `app/packages/infra/src/ecs.ts` (`defineEcs` per-game loop, ~L198-290)
- Test: `app/packages/infra/src/ecs.test.ts`

**Interfaces:**
- Consumes: `HOSTNAME_SHIM_MOUNT_PATH` (Task 1), `GameServerEnvironmentVariable`, the local `logConfiguration(logGroupName, awsRegion, streamPrefix)` in `ecs.ts` (pass the result in rather than importing it).
- Produces:
  - `HOSTNAME_SHIM_IMAGE: string` (exact tag)
  - `HOSTNAME_SHIM_CONTAINER_NAME = 'hostname-shim'`
  - `buildHostnameShimSource(hostname: string): string`
  - `buildHostnameShimContainer(args: { game: string; hostname: string; logConfiguration: Record<string, unknown> }): Record<string, unknown>`
  - `hostnameShimVolumeName(game: string): string` → `` `${game}-hostname-shim` ``
  - `mergeNodeOptions(environment: GameServerEnvironmentVariable[]): GameServerEnvironmentVariable[]`

- [ ] **Step 1: Check the registry** for the newest busybox release tag on `public.ecr.aws/docker/library/busybox` (Docker Hub tag list + ECR Public manifest 200) and record it for `HOSTNAME_SHIM_IMAGE`.
- [ ] **Step 2: Write failing `hostnameShim.test.ts` tests:**
  - `shim makes os.hostname return the value`: write `buildHostnameShimSource('foundry')` to a temp file, `execFileSync(process.execPath, ['--require', file, '-e', "process.stdout.write(require('node:os').hostname())"])` → `'foundry'`.
  - `shim returns underscore hostname`: same with `'my_foundry_host'`.
  - `container decodes to the shim`: the container's command is `['/bin/sh','-c', …]`, its base64 payload decodes to `buildHostnameShimSource(hostname)`, `essential === false`, mount `{ sourceVolume: 'foundry-hostname-shim', containerPath: '/hyveon/hostname-shim', readOnly: false }`.
  - `mergeNodeOptions appends when absent` → one entry `--require=/hyveon/hostname-shim/hostname-shim.js`.
  - `mergeNodeOptions prefixes operator value` (`--max-old-space-size=2048`) → one entry `--require=/hyveon/hostname-shim/hostname-shim.js --max-old-space-size=2048`, at the operator entry's original index.
  - `keeps ipv4 token in merged NODE_OPTIONS` → raw `${hyveon.network.public-ipv4}` still present after the prefix.
- [ ] **Step 3: Write failing `ecs.test.ts` tests** (reuse `runDefineEcs`/`findByName`):
  - `opted-in game gets init container and mounts`: fixture game with `pinnedHostname: 'foundry'` → containerDefinitions include `hostname-shim`; game container `dependsOn` `[{ containerName: 'hostname-shim', condition: 'SUCCESS' }]`, read-only mount at `/hyveon/hostname-shim`, `NODE_OPTIONS` present; volumes include `{ name: '<game>-hostname-shim' }` with no `efsVolumeConfiguration`.
  - `https game caddy definition unchanged`: deep-equal the `caddy` definition with and without the field.
  - `other games unaffected` and `absent field is unchanged`: a game without the field has no `hostname-shim` container/volume/mount/`NODE_OPTIONS` and deep-equals the pre-change output for `FIXTURE_GAME_SERVERS`.
  - `ipv4 wrapper coexists`: field + `command` + ipv4 token → wrapper `entryPoint` kept, merged `NODE_OPTIONS` present.
- [ ] **Step 4: Run** `npx vitest run app/packages/infra/src/hostnameShim.test.ts app/packages/infra/src/ecs.test.ts` — expected FAIL.
- [ ] **Step 5: Implement** `hostnameShim.ts`. Shim body is exactly `const os = require('node:os');\nos.hostname = () => ${JSON.stringify(hostname)};\n`. Container command: `` `echo ${base64} | base64 -d > ${HOSTNAME_SHIM_MOUNT_PATH}/hostname-shim.js` ``.
- [ ] **Step 6: Wire into `ecs.ts`.** Only when `config.pinnedHostname !== undefined`: push the volume, apply `mergeNodeOptions` to `resolvedEnvironment` before `usesIpv4Token` and the wrapper are computed, add `dependsOn` + the read-only mount to the game container, and push the init container with `logConfiguration(logGroupName, awsRegion, 'hostname-shim')`. The no-field path must not change key order or add empty arrays.
- [ ] **Step 7: Run** the Step 4 command — expected PASS. Then `npm run app:typecheck` — clean.
- [ ] **Step 8: Commit** `feat(infra): pin game hostname via NODE_OPTIONS shim init container`.

### Task 3: Wizard control

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` (`WizardDraft` ~L153, `createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`, `toProposedEntry`, `stepForIssuePath`)
- Modify: `app/packages/web/src/components/add-game-wizard/environment-step.component.tsx`
- Modify: `app/packages/web/src/components/add-game-wizard/review-step.component.tsx`
- Test: `wizard-form.utils.test.ts`, `environment-step.component.test.tsx`, `review-step.component.test.tsx`, `../edit-game-form/edit-game-form.component.test.tsx`

**Interfaces:**
- Consumes: `PINNED_HOSTNAME_PATTERN_DESCRIPTION` (Task 1, through the existing `validateStep` → `validateGameServer` path, so no client-side copy of the rule).
- Produces: `WizardDraft.pinnedHostname: string | undefined` (`undefined` = switch off).

- [ ] **Step 1: Write failing tests:**
  - utils: `draftToPayload omits pinnedHostname when undefined`, `round-trips my_foundry_host`, `stepForIssuePath('pinnedHostname') === 'environment'`, `untouched edit omits field` (`draftToPayload(draftFromGameServer(gameWithoutField))` has no key).
  - environment step: `helper text states Node.js requirement` (text matches `/Node\.js game servers only/`); `enabling pre-fills game name` (`name: 'foundry'` → field value `foundry`, `onChange` called with `{ pinnedHostname: 'foundry' }`); `disabling clears` (→ `{ pinnedHostname: undefined }`); `enabling with empty name shows validation` (issue at `pinnedHostname` rendered next to the field); `shows issue message for invalid value`.
  - review step: `lists pinned hostname` when set; nothing when `undefined`.
  - edit form: `loads existing pinnedHostname` → switch checked, field shows `my_foundry_host`.
- [ ] **Step 2: Run** `npx vitest run app/packages/web/src/components/add-game-wizard app/packages/web/src/components/edit-game-form` — expected FAIL.
- [ ] **Step 3: Implement.** Switch id `pin-hostname-toggle`, input id `pinned-hostname-input`. Helper text (exact copy from design D8): "Node.js game servers only. Pins the hostname the Node process sees, for games whose license is bound to the hostname (e.g. Foundry VTT). Has no effect on games that don't run on Node; check what your image runs before enabling. Enabling this on an existing game requires accepting the EULA one more time." Extend the step's `Pick<WizardDraft, …>` props to include `pinnedHostname` and `name`.
- [ ] **Step 4: Run** the Step 2 command — expected PASS.
- [ ] **Step 5: Commit** `feat(web): add pin-hostname control to game wizard`.

### Task 4: Docs and field audit

**Files:**
- Modify: `docs/docs/components/infra.md`, `docs/docs/app/games.md`

- [ ] **Step 1:** Run the `write-docs` skill over the branch diff. `infra.md`: opted-in task-definition contents (init container, ephemeral volume, mount, `NODE_OPTIONS` merge, no new resources). `games.md`: the control, Node.js-only requirement, one-time EULA, dependency on the game reading `os.hostname()`.
- [ ] **Step 2:** Dispatch `deployment-config-field-auditor` on the diff; fix every gap it reports.
- [ ] **Step 3: Commit** `docs: document pinned hostname`.

### Task 5: Gate and live check

- [ ] **Step 1:** `npm run app:lint`, `npm run app:typecheck`, `npm run app:test`, `npm run app:test:e2e` — all exit 0.
- [ ] **Step 2:** Pulumi preview on a stack with no opted-in game → zero task-definition diff.
- [ ] **Step 3 (live, manual):** enable on the Foundry game, apply, start, accept the EULA once, stop, start → container log shows `Software license verification succeeded`, no EULA prompt on connect. Record in `verify.md`.
