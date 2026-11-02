# Arrow: game-server

What one game *is*: its declared shape (image, size, ports, HTTPS, environment, pinned hostname), the add/edit wizard that captures it, the draft that survives a restart, and the games list.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Shared model and validator are mature and heavily tested; the write path has a secret-before-config ordering hazard.

## References

### HLD
- `docs/high-level-design.md

### LLD
- `docs/intent/game-server/game-server-design.md`

### EARS
- `docs/intent/game-server/game-server-specs.md` (135 specs)

### Tests
- `app/packages/desktop-main/src/controllers/games.controller.test.ts`
- `app/packages/desktop-main/src/controllers/games.controller.integration.test.ts`
- `app/packages/desktop-main/src/services/GamesWriteService.test.ts`
- `app/packages/desktop-main/src/services/GameWizardDraftService.test.ts`
- `app/packages/desktop-main/src/services/mergeGameLists.test.ts`
- `app/packages/shared/src/envTokens.test.ts`
- `app/packages/shared/src/gameServerPorts.test.ts`
- `app/packages/shared/src/gameServerValidator.test.ts`
- `app/packages/web/e2e/specs/games.spec.ts`
- `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/identity-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/resources-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/storage-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/environment-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/review-step.component.test.tsx`
- `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`
- `app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx`
- `app/packages/web/src/components/game-status-badges.component.test.tsx`
- `app/packages/web/src/components/remove-game-button.component.test.tsx`
- `app/packages/web/src/pages/game-detail.page.test.tsx`
- `app/packages/web/src/pages/games.page.test.tsx`

### Code

**@hyveon/shared**
- `app/packages/shared/src/gameServerConfig.ts`
- `app/packages/shared/src/gameServerValidator.ts`
- `app/packages/shared/src/gameServerPorts.ts`
- `app/packages/shared/src/envTokens.ts`
- `app/packages/shared/src/addGameWizardSteps.ts`
- `app/packages/shared/src/gamesWrite.ts`

**@hyveon/desktop-main**
- `app/packages/desktop-main/src/controllers/games.controller.ts`
- `app/packages/desktop-main/src/services/GamesWriteService.ts`
- `app/packages/desktop-main/src/services/GameWizardDraftService.ts`
- `app/packages/desktop-main/src/services/mergeGameLists.ts`

**@hyveon/web**
- `app/packages/web/src/pages/games.page.tsx`
- `app/packages/web/src/pages/game-detail.page.tsx`
- `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx`
- `app/packages/web/src/components/add-game-wizard/identity-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/resources-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/storage-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/environment-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/review-step.component.tsx`
- `app/packages/web/src/components/add-game-wizard/use-wizard-draft-autosave.hook.ts`
- `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`
- `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx`
- `app/packages/web/src/components/game-status-badges.component.tsx`
- `app/packages/web/src/components/remove-game-button.component.tsx`
- `app/packages/web/e2e/pages/GamesPage.ts` (Playwright page object)

### Cited from other leaves
- `iac/program`: `app/packages/infra/src/ecs.ts` (env-token substitution, Caddy sidecar for HTTPS, pinned-hostname init container), `app/packages/infra/src/envTokenWrapper.ts` (ipv4 boot wrapper), `app/packages/infra/src/hostnameShim.ts`, `app/packages/infra/src/securityGroups.ts` (port-visibility and ICMP ingress), `app/packages/infra/src/efs.ts` (`{game}-certs` access point), `app/packages/infra/src/lambdas.ts` (`GAME_PORTS` env).
- `deployment-config`: `app/packages/desktop-main/src/services/DeploymentConfigService.ts` (`addGameServer`/`updateGameServer`/`removeGameServer`, read-time `normalizeGameServer`), `app/packages/shared/src/drift.ts`, `DriftService.ts`, `pending-changes-banner.component.tsx` (drift chips on the games list).
- `game-runtime/health-check`: `app/packages/web/src/components/add-game-wizard/health-check-fields.component.tsx` (a section of the networking step), `app/packages/shared/src/secrets/secretsStore.ts` (app-owned `hyveon-{game}-healthcheck-auth` upsert/delete).
- `game-runtime/task-and-dns`: `app/packages/desktop-main/src/services/EcsService.ts` (backs `games.status/getStatus/start/stop` on this leaf's controller); it in turn cites the Fargate pricing constants in `gameServerValidator.ts:408-411`.
- `operator-app/diagnostics`: `AuditService.record` (called from every successful write).
- `operator-app/wizard-and-bootstrap`: `ElectronStoreService.ts` (`addGameWizardDraft` slot).
- `operator-app/ipc-bridge`: `app/packages/desktop-preload/src/hyveon-api.ts`, `app/packages/web/src/api.service.ts` (hand-mirrored `GameServer`/`GameWizardDraft` types).
- `iac/engine`: `ConfigService.getStackOutputs` (deployed game names for the merged list).
- `helper-task`: `app/packages/desktop-main/src/services/volumeFiles/HelperSessionRegistry.ts` (`hasUploadHolders`, read by this leaf's `games.start` guard), `app/packages/web/src/pages/volume-files.page.tsx` (the `/games/:name/files` file browser the detail page links to).

### OpenSpec sources
- Capabilities carried (as EARS provenance tags): `game-environment-variables` (3 requirements), `game-https-configuration` (7), `game-port-visibility` (9), `game-resource-picker` (2), `env-token-interpolation` (6), `game-draft-persistence` (6).
- Shipped work carried: pinned hostname (#692, 2 manual verification tasks outstanding), explicit HTTPS `webPort` (#688/#689/#691), ICMP ingress (#599).
- Touching this leaf, owned elsewhere: the health-check auth type (validator and wizard fields; owner `game-runtime/health-check`) and the embedded file browser (detail-page Files link and upload start guard; owner `helper-task`).

## Architecture

**Purpose:** Define the canonical per-game declaration (`GameServer`) that every per-game AWS resource fans out from, validate it identically in renderer and main process, and give the operator a list, detail page, six-step add wizard, edit form and remove action that write it into `deployment-config.json`.

**Key Components:**
1. `app/packages/shared/src/gameServerConfig.ts`: the `GameServer` interface (`:202`), its port/volume/env/health-check sub-types, `redactGameServer` (`:373`) and the merged `GameListEntry` (`:392`).
2. `app/packages/shared/src/gameServerValidator.ts`: zod `gameServerSchema` (`:289`) plus cross-game rules (port collisions, HTTPS 80/443 reservation, `webPort`, ICMP, health-check auth, env tokens, pinned hostname, Fargate CPU/memory tiers and pricing); entry point `validateGameServer` (`:1058`).
3. `app/packages/shared/src/gameServerPorts.ts`: HTTPS port helpers: `normalizeGameServer` legacy `webPort` backfill (`:54`), `ingressPorts` (`:101`), `findWebPortCollisions` raw-read recheck (`:118`).
4. `app/packages/shared/src/envTokens.ts`: the `${hyveon.*}` token allow-list (`:10`) and candidate matcher shared by the validator and `app/packages/infra/src/ecs.ts`.
5. `app/packages/desktop-main/src/controllers/games.controller.ts`: 13 IPC channels: `games.list` (`:53`, merges declared + deployed and computes drift locally), `status/getStatus/start/stop` (delegated to `EcsService`), `create/update/delete` (`:132-158`), `draft.get/save/updateStepIndex/clear` (`:168-199`).
6. `app/packages/desktop-main/src/services/GamesWriteService.ts`: write orchestrator (`createGame` `:114`, `updateGame` `:201`, `deleteGame` `:267`): structural validation, app-owned health-check secret upsert, second validation, `DeploymentConfigService` write with optimistic lock, audit, refreshed list via `mergeGameLists`.
7. `app/packages/desktop-main/src/services/GameWizardDraftService.ts` (`:25`): single `addGameWizardDraft` slot in electron-store with shape validation, legacy backfills and secret redaction on read.
8. `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx` (`:95`): six-step dialog (`ADD_GAME_WIZARD_STEPS` in `app/packages/shared/src/addGameWizardSteps.ts:11`) with live shared validation; submits via `games.create`.
9. `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` + `use-wizard-draft-autosave.hook.ts` (`:67`): draft shape, per-step validation, payload conversion, debounced autosave/resume.
10. `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx` (`:42`): reuses the wizard steps as a flat form; submits via `games.update`.
11. `app/packages/web/src/pages/games.page.tsx` (`:71`) and `game-detail.page.tsx` (`:107`): declared/deployed table with drift chips (`game-status-badges.component.tsx:41`), draft-resume banner, read-only detail with a Files link to `/games/:name/files` (`game-detail.page.tsx:140-148`), type-to-confirm `remove-game-button.component.tsx`.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| game-environment-variables | 3 | 13 | Env step, edit form, validator. |
| game-https-configuration | 7 | 27 | Cross-game `webPort` constraint 5 is enforced in code and carried by `GAME-HTTPS-009` / `GAME-HTTPS-010`. |
| game-port-visibility | 9 | 23 | Includes the ICMP and HTTPS-extra-port requirements. Infra half (`securityGroups.ts`) owned by `iac/program`. |
| game-resource-picker | 2 | 5 | Resources step, Fargate tiers in validator. |
| env-token-interpolation | 6 | 13 | Purpose still "TBD". Substitution half in `app/packages/infra/src/ecs.ts` (`iac/program`). |
| game-draft-persistence | 6 | 11 | Autosave hook, `GameWizardDraftService`, resume banner. |
| game-hostname-pinning (shipped, `add-pinned-hostname`) | 5 | 22 | Carried by `GAME-HOST-*`. |

**Legacy requirement summary:** 33 requirements / 92 scenarios across 6 capabilities, plus 5 / 22 for pinned hostname.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Game Server Model | `GAME-MODEL-001` to `GAME-MODEL-004` | 4 | 0 | 0 |
| Shared Validation | `GAME-VALID-001` to `GAME-VALID-011` | 9 | 0 | 2 |
| Resource Picker | `GAME-RES-001` to `GAME-RES-006` | 6 | 0 | 0 |
| Environment Variables | `GAME-ENV-001` to `GAME-ENV-010` | 10 | 0 | 0 |
| Env Token Interpolation | `GAME-TOKEN-001` to `GAME-TOKEN-014` | 13 | 0 | 1 |
| HTTPS | `GAME-HTTPS-001` to `GAME-HTTPS-017` | 17 | 0 | 0 |
| Ports, Visibility and ICMP | `GAME-PORT-001` to `GAME-PORT-015` | 15 | 0 | 0 |
| Pinned Hostname | `GAME-HOST-001` to `GAME-HOST-016` | 15 | 0 | 1 |
| Write Path | `GAME-WRITE-001` to `GAME-WRITE-013` | 8 | 0 | 5 |
| IPC Surface and Games Pages | `GAME-IPC-001` to `GAME-IPC-010` | 8 | 0 | 2 |
| Add-Game Wizard Flow | `GAME-WIZ-001` to `GAME-WIZ-006` | 5 | 0 | 1 |
| Draft Persistence | `GAME-DRAFT-001` to `GAME-DRAFT-013` | 12 | 0 | 1 |

**Summary:** 122 of 135 active specs implemented; 0 deferred; 13 gaps.

## Key Findings

1. **Constraint 5 is enforced in code and carried in LID**: no game's `tcp` port may equal another game's `webPort`, and the same applies in reverse. Code enforces it in `gameServerValidator.ts:829-862` and rechecks raw reads in `gameServerPorts.ts:118-136`; `GAME-HTTPS-009` and `GAME-HTTPS-010` carry it. The design assumption that `checkPortCollisions` covers `webPort` does not match the code (Deferred 9 in the design).
2. **Pinned hostname is carried in LID**: `PINNED_HOSTNAME_PATTERN` and `HOSTNAME_SHIM_RESERVED_NAME` exist (`gameServerValidator.ts:62-72`) and `GameServer.pinnedHostname` is live; `GAME-HOST-*` carries the behaviour.
3. **Health-check secret is written before the config, so a lost write leaves it mutated**: `createGame` upserts the secret at `GamesWriteService.ts:148` before `addGameServer` at `:157`; `updateGame` upserts at `:221` before `updateGameServer` at `:231`. An `OptimisticLockError` or not-found on the config write returns a modeled error with the secret already changed. An upsert failure is rethrown as a plain `Error` (`:514-525`) instead of a `GameWriteResult`.
4. **All `GameServerEntryError` reasons collapse to `not_found` on update**: `GamesWriteService.ts:236-238` maps any `GameServerEntryError` to `not_found`, whereas create distinguishes `invalid-name`/`duplicate-name` as validation (`:162-164`).
5. **Raw error object logged on the generic failure path**: `errorResult` logs `{ err }` (`GamesWriteService.ts:383`) rather than the normalised message required by `.claude/rules/logging.md`.
6. **Port protocol is not validated for non-HTTPS games**: `gameServerPortSchema` accepts any string (`gameServerValidator.ts:77`), and the only tcp/udp check is inside the HTTPS rules (`:753`); the field doc says it "Must be the exact lowercase string" (`gameServerConfig.ts:29-36`). Collision keys lowercase the protocol (`:617`), but `checkHttpsPortRules` (`:753`), the health-check port check (`:1001`) and `normalizeGameServer` (`gameServerPorts.ts:62`) compare case-sensitively, so a hand-edited `'TCP'` behaves inconsistently.
7. **`games.list` deliberately does not invalidate stack outputs**: `games.controller.ts:38-51` invalidates only the `DeploymentConfigService` cache and documents why. Sweep-6 flagged this as a bug; the code comment shows it is intentional, with stack outputs invalidated on write instead.
8. **Client collision check silently degrades**: the add wizard sets `existingGames` to `[]` when `api.games()` fails (`add-game-wizard.component.tsx:150-159`), so live cross-game validation passes; the server's second validation still catches it. On a validation result the wizard jumps only to the first issue's step (`:279-282`). `game-detail.page.tsx:112-121` likewise turns a list failure into "not found".
9. **Preload types have drifted from the shared model**: `app/packages/desktop-preload/src/hyveon-api.ts:418` `GameServer` and its `GameWizardDraft` mirror (`:650-679`) have no `webPort` or `command`, both present on `app/packages/shared/src/gameServerConfig.ts:243,254`.
10. **Near-duplicate payload builders**: `draftToPayload` (`wizard-form.utils.ts:348`) and `toProposedEntry` (`:463`) build the same shape with differing trim/fallback behaviour; `remove-game-button.component.tsx:24-30` re-implements type-to-confirm on AlertDialog primitives rather than `ConfirmDialog` (documented reason: richer body).
11. **Review step misgroups fields**: env vars and pinned hostname render inside the "Storage" card (`review-step.component.tsx:122-166`) though they belong to the Environment step.
12. **Draft discard has no error handling**: `handleDiscardDraft` awaits `api.clearGameDraft()` with no catch (`games.page.tsx:117-120`).
13. **Test gaps**: no `GameWizardDraftService.test.ts` coverage for `updateStepIndex` (grep finds none); `games.draft.updateStepIndex` is absent from `games.controller.test.ts`. `[unverified]` sweep-5 also reports no tests for visibility backfill and username/password/token redaction.
14. **Stale comments from the HTTP/Terraform era**: `GamesWriteService.ts:3` "HTTP equivalents"; `gameServerConfig.ts:386-391` `/api/games`, "tfstate", issue #92; `wizard-form.utils.ts:215` `@cdktf/hcl2json`, `:340` `POST /api/games`.
15. **`games.start` refuses while an upload holds the game's volumes, on the desktop path only**: the handler returns `success: false` without calling ECS when `HelperSessionRegistry.hasUploadHolders(game)` is true (`games.controller.ts:105-108`). Its doc comment states that the Discord `/server-start` path runs in a Lambda and cannot see this refusal (`:96-98`), so a Discord start can still mount a volume mid-upload.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-server/game-server-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Order the health-check secret write after a successful config write, or roll it back on conflict/not-found, and return upsert failures as a `GameWriteResult` (finding 3). (specs: `GAME-WRITE-004`, `GAME-WRITE-005`)
2. Decide which release removes the `@deprecated` `normalizeGameServer` compatibility and whether `pinnedHostname` joins the drift field set (findings 1, 2; design Deferred 7 and 8).

### Should Fix
3. Validate `protocol` as `tcp|udp|icmp` for every game and make all protocol comparisons case-insensitive, or normalise on read (finding 6). (specs: `GAME-VALID-010`, `GAME-VALID-011`)
4. Distinguish `GameServerEntryError` reasons on update; log the normalised message in `errorResult` (findings 4, 5). (specs: `GAME-WRITE-010`, `GAME-WRITE-012`)
5. Add `webPort`/`command` to the preload `GameServer`/`GameWizardDraft` mirrors, or derive them from `@hyveon/shared` (finding 9). (specs: `GAME-IPC-005`)
6. Surface `api.games()` failure in the wizard and detail page instead of an empty list (finding 8); catch `clearGameDraft` failures (finding 12). (specs: `GAME-IPC-007`, `GAME-DRAFT-008`)
7. Add tests for `updateStepIndex` at service and controller level (finding 13).

### Nice to Have
8. Merge `draftToPayload`/`toProposedEntry` (finding 10).
9. Move env vars and pinned hostname into their own review card (finding 11). (specs: `GAME-HOST-016`)
10. Remove HTTP/tfstate/HCL-era comment residue (finding 14); give `env-token-interpolation` a real Purpose and `game-port-visibility` a title line.
11. Decide whether the Discord `/server-start` path needs an equivalent of the desktop upload guard, which it cannot see from the Lambda (finding 15).
