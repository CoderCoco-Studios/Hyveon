## 1. Shared type and validation (`@hyveon/shared`)

- [x] 1.1 Add `pinnedHostname?: string` to `GameServer` in `gameServerConfig.ts`, with TSDoc stating it is Node.js-only (patches `os.hostname()` via a `NODE_OPTIONS` preload), the one-time EULA caveat, and "default when omitted: hostname not pinned"
- [x] 1.2 Export `PINNED_HOSTNAME_PATTERN`, `PINNED_HOSTNAME_PATTERN_DESCRIPTION`, and `HOSTNAME_SHIM_MOUNT_PATH = '/hyveon/hostname-shim'` from `gameServerValidator.ts` (plain constants; no AWS imports)
- [x] 1.3 Add `pinnedHostname: z.string().optional()` to `gameServerSchema`
- [x] 1.4 Add `checkPinnedHostname` (pattern check at `pinnedHostname`; reserved-path collision at `volumes[i].container_path` only when the field is set) and register it in `validateGameServer`
- [x] 1.5 Unit tests in `gameServerValidator.test.ts` for every validation scenario in the spec, plus round-trip through `redactGameServer`

## 2. Infra wiring (`@hyveon/infra`)

- [x] 2.1 Re-check the registry for the latest busybox release on `public.ecr.aws/docker/library/busybox` and pin the exact tag in a named constant
- [x] 2.2 Create `hostnameShim.ts`: `buildHostnameShimSource(hostname)`, `buildHostnameShimInitContainer(...)` (base64 write command, `essential: false`, read-write mount, `awslogs` prefix `hostname-shim`), and `mergeNodeOptions(environment)` (shim-first merge, exactly one `NODE_OPTIONS`)
- [x] 2.3 Unit tests in `hostnameShim.test.ts`: generated source, when `require`d in a child Node process, makes `os.hostname()` return the value; merge cases (none / existing / ipv4 token preserved)
- [x] 2.4 Widen `logConfiguration`'s `streamPrefix` union in `ecs.ts` to include `'hostname-shim'`. Then wire into `defineEcs` in `ecs.ts` for games with `pinnedHostname`: ephemeral volume, init container, game-container `dependsOn` + read-only mount + merged env (merge after `resolveGameEnvironment`, before the ipv4 wrapper is built)
- [x] 2.5 `ecs.test.ts`: opted-in wiring, HTTPS game's `caddy` definition unchanged, other games unaffected, absent-field output identical to before

## 3. Wizard (`@hyveon/web`) and mirrored types

- [x] 3.0 Add the field to the hand-kept type copies: `GameServer` in `desktop-preload/src/hyveon-api.ts` (the web app's source for `GameServer`/`RedactedGameServer`/`CreateGamePayload`); `GameWizardDraft` in `web/src/api.service.ts` and `desktop-main/src/services/ElectronStoreService.ts` (`pinnedHostname?: string`); and an `undefined || string` guard in `isGameWizardDraft` (`desktop-main/src/services/GameWizardDraftService.ts`), written like the existing `command` guard
- [x] 3.1 Add `pinnedHostname: string | undefined` to `WizardDraft`; carry it through `createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`, and `toProposedEntry` (off/empty → omitted); map the `pinnedHostname` issue path to the environment step in `stepForIssuePath`
- [x] 3.2 `environment-step.component.tsx`: "Pin hostname" switch (on → game name, off → cleared), text field with inline validation message, helper text leading with "Node.js game servers only"
- [x] 3.3 `review-step.component.tsx`: show the pinned hostname when set
- [x] 3.4 jsdom tests for every wizard scenario in the spec (helper text, pre-fill, disable omits, edit-form load, invalid blocks, review shows)

## 4. Docs

- [x] 4.0 Add `hasPinnedHostname` to the per-game summary in `desktop-main/src/services/diagnosticsBundleAllowlist.ts`, so a failed shim start is visible in a diagnostics bundle
- [x] 4.1 Use the `write-docs` skill: `docs/docs/components/infra.md` (new file-table row for `hostnameShim.ts`, the `ecs.ts` row mentions the init container and ephemeral volume, task-definition contents for opted-in games) and `docs/docs/app/games.md` (the control, Node.js-only requirement, one-time EULA, `os.hostname()` dependency)
- [x] 4.2 Run the `deployment-config-field-auditor` agent over the diff and close every gap it reports

## 5. Verification

- [x] 5.1 `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` all exit 0
- [x] 5.2 `npm run app:test:e2e` exits 0 (wizard changed)
- [ ] 5.3 Pulumi preview against an existing stack with no opted-in game shows zero task-definition diff
- [ ] 5.4 Live: enable on the Foundry game, apply, start, accept the EULA once, stop, start again → log shows `Software license verification succeeded` and no EULA prompt
