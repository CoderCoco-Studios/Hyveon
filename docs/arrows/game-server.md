# Arrow: game-server

What one game *is*: its declared shape (image, size, ports, HTTPS, environment, pinned hostname), the add/edit wizard that captures it, the draft that survives a restart, and the games list.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Shared model, validator and write path are implemented and tested; every active spec is implemented.

## References

### HLD
- `docs/high-level-design.md

### LLD
- `docs/intent/game-server/game-server-design.md`

### EARS
- `docs/intent/game-server/game-server-specs.md` (136 specs)

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

**Legacy requirement summary:** 33 requirements / 92 scenarios across 6 capabilities, plus 5 / 22 for pinned hostname.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Game Server Model | `GAME-MODEL-001` to `GAME-MODEL-004` | 4 | 0 | 0 |
| Shared Validation | `GAME-VALID-001` to `GAME-VALID-011` | 11 | 0 | 0 |
| Resource Picker | `GAME-RES-001` to `GAME-RES-006` | 6 | 0 | 0 |
| Environment Variables | `GAME-ENV-001` to `GAME-ENV-010` | 10 | 0 | 0 |
| Env Token Interpolation | `GAME-TOKEN-001` to `GAME-TOKEN-014` | 14 | 0 | 0 |
| HTTPS | `GAME-HTTPS-001` to `GAME-HTTPS-017` | 17 | 0 | 0 |
| Ports, Visibility and ICMP | `GAME-PORT-001` to `GAME-PORT-015` | 15 | 0 | 0 |
| Pinned Hostname | `GAME-HOST-001` to `GAME-HOST-016` | 16 | 0 | 0 |
| Write Path | `GAME-WRITE-001` to `GAME-WRITE-014` | 14 | 0 | 0 |
| IPC Surface and Games Pages | `GAME-IPC-001` to `GAME-IPC-010` | 10 | 0 | 0 |
| Add-Game Wizard Flow | `GAME-WIZ-001` to `GAME-WIZ-006` | 6 | 0 | 0 |
| Draft Persistence | `GAME-DRAFT-001` to `GAME-DRAFT-013` | 13 | 0 | 0 |

**Summary:** 136 of 136 active specs implemented; 0 deferred; 0 gaps.

## Key Findings

1. **Constraint 5 is enforced in code and carried in LID**: no game's `tcp` port may equal another game's `webPort`, and the same applies in reverse. Code enforces it in `gameServerValidator.ts:829-862` and rechecks raw reads in `gameServerPorts.ts:118-136`; `GAME-HTTPS-009` and `GAME-HTTPS-010` carry it. The design assumption that `checkPortCollisions` covers `webPort` does not match the code (Deferred 4 in the design).
2. **Pinned hostname is carried in LID**: `PINNED_HOSTNAME_PATTERN` and `HOSTNAME_SHIM_RESERVED_NAME` exist (`gameServerValidator.ts:62-72`) and `GameServer.pinnedHostname` is live; `GAME-HOST-*` carries the behaviour.
3. **`games.list` deliberately does not invalidate stack outputs**: `games.controller.ts:38-51` invalidates only the `DeploymentConfigService` cache and documents why. Sweep-6 flagged this as a bug; the code comment shows it is intentional, with stack outputs invalidated on write instead.
4. **Near-duplicate payload builders**: `draftToPayload` (`wizard-form.utils.ts:348`) and `toProposedEntry` (`:463`) build the same shape with differing trim/fallback behaviour; `remove-game-button.component.tsx:24-30` re-implements type-to-confirm on AlertDialog primitives rather than `ConfirmDialog` (documented reason: richer body).
5. **Test gaps**: no `GameWizardDraftService.test.ts` coverage for `updateStepIndex` (grep finds none); `games.draft.updateStepIndex` is absent from `games.controller.test.ts`. `[unverified]` sweep-5 also reports no tests for visibility backfill and username/password/token redaction.
6. **Stale comments from the HTTP/Terraform era**: `GamesWriteService.ts:3` "HTTP equivalents"; `gameServerConfig.ts:386-391` `/api/games`, "tfstate", issue #92; `wizard-form.utils.ts:215` `@cdktf/hcl2json`, `:340` `POST /api/games`.
7. **`games.start` refuses while an upload holds the game's volumes, on the desktop path only**: the handler returns `success: false` without calling ECS when `HelperSessionRegistry.hasUploadHolders(game)` is true (`games.controller.ts:105-108`). Its doc comment states that the Discord `/server-start` path runs in a Lambda and cannot see this refusal (`:96-98`), so a Discord start can still mount a volume mid-upload.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-server/game-server-specs.md`; items with no matching gap spec carry none. Every spec is implemented, so none remain open.

### Must Fix
1. Decide which release removes the `@deprecated` `normalizeGameServer` compatibility and whether `pinnedHostname` joins the drift field set (findings 1, 2; design Deferred 2 and 3).

### Should Fix
2. Add tests for `updateStepIndex` at service and controller level (finding 5).

### Nice to Have
3. Merge `draftToPayload`/`toProposedEntry` (finding 4).
4. Remove HTTP/tfstate/HCL-era comment residue (finding 6); give `env-token-interpolation` a real Purpose and `game-port-visibility` a title line.
5. Decide whether the Discord `/server-start` path needs an equivalent of the desktop upload guard, which it cannot see from the Lambda (finding 7).
