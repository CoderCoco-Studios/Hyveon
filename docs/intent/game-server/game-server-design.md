---
parent: high-level-design
prefix: GAME
---

# Game Server

## Context and Design Philosophy

Hyveon's cost model rests on one per-game declaration: every per-game AWS resource fans out from a `GameServer` entry in the `gameServers` map of `deployment-config.json`. This leaf owns that declaration. It defines the shape (`app/packages/shared/src/gameServerConfig.ts:202`), the single validator that renderer and main process both run (`app/packages/shared/src/gameServerValidator.ts:1058`), the write orchestrator that turns an operator's submission into a config write (`app/packages/desktop-main/src/services/GamesWriteService.ts:70`), the merged games list, and the operator surfaces that capture a game: the six-step add wizard, the edit form, the detail page, the remove action and the autosaved wizard draft.

The guiding principle visible throughout the code is "one copy of every rule". The validator, the step order (`app/packages/shared/src/addGameWizardSteps.ts:11`), the env-token catalog (`app/packages/shared/src/envTokens.ts:10`), the HTTPS port helpers (`app/packages/shared/src/gameServerPorts.ts`), the name and pinned-hostname patterns (`gameServerValidator.ts:51,62`) and the write payload/result union (`app/packages/shared/src/gamesWrite.ts:104`) all live in `@hyveon/shared` so that the wizard's live feedback and the server's authoritative check can never disagree on a rule. The renderer validates for feedback; the main process validates again before writing, and that second check is the one that counts.

What this leaf deliberately does not own:

- **The stored document.** Reading, parsing, writing and optimistic locking of `deployment-config.json`, plus the read-time `normalizeGameServer` call and drift, belong to `deployment-config` (`DeploymentConfigService.addGameServer`/`updateGameServer`/`removeGameServer`, `app/packages/desktop-main/src/services/DeploymentConfigService.ts:486,516,545`). This leaf calls them.
- **Turning a declaration into AWS resources.** Task definitions, the Caddy sidecar, env-token substitution, the ipv4 boot wrapper, the hostname shim init container and security-group ingress are `iac/program` (`app/packages/infra/src/ecs.ts`, `securityGroups.ts`, `hostnameShim.ts`, `envTokenWrapper.ts`). A write here changes only the JSON; nothing reaches AWS until a plan/apply (`app/packages/web/src/components/remove-game-button.component.tsx:32-35`).
- **Running a game.** `games.status/getStatus/start/stop` are registered on this leaf's controller but delegate wholesale to `EcsService` (`app/packages/desktop-main/src/controllers/games.controller.ts:73-121`), owned by `game-runtime/task-and-dns`.
- **Health-check semantics.** The health-check fields render inside the networking step but are owned by `game-runtime/health-check`, as is the app-owned `hyveon-{game}-healthcheck-auth` secret store (`app/packages/shared/src/secrets/secretsStore.ts`). This leaf only sequences the secret upsert/delete around its writes.
- **The bridge.** The preload `GameServer`/`GameWizardDraft` mirrors and `api.service.ts` belong to `operator-app/ipc-bridge`.

CLAUDE.md invariants that live here:

- **`DeploymentConfig.gameServers` is the single source of truth.** Adding a game is adding one map entry; `GamesWriteService` is the only writer of per-game entries from the UI.
- **No persistent ECS Service.** The games list and detail page only ever offer start/stop through `RunTask`/`StopTask` (`games.controller.ts:93-110`).
- **Secrets never reach the renderer.** `redactGameServer` (`gameServerConfig.ts:373`) replaces health-check `auth` with `secretSet`/`authType`, and `mergeGameLists` is the seam where every declared entry passes through it before crossing IPC (`app/packages/desktop-main/src/services/mergeGameLists.ts:39`). The wizard draft is redacted on read (`app/packages/desktop-main/src/services/GameWizardDraftService.ts:344-360`).
- **The desktop app has no HTTP transport.** Every handler is an IPC `@MessagePattern`; references to HTTP routes in comments are residue (see Deferred).

## The GameServer Model

`GameServer` is the flattened form of one `gameServers` entry: `name` is the map key copied onto the value so a list is self-describing (`gameServerConfig.ts:203-209`), and `GameServerConfig = Omit<GameServer, 'name'>` is the stored value shape (`gameServerConfig.ts:325`).

| Field | Required | Meaning and constraint (validator rule) |
|---|---|---|
| `image` | yes | Container image pulled by the task. Non-empty is a wizard check (`wizard-form.utils.ts:526`); the zod schema only requires a string (`gameServerValidator.ts:290`). |
| `cpu`, `memory` | yes | Fargate units/MiB; must be a valid Fargate pairing from `FARGATE_CPU_MEMORY_TABLE` (`gameServerValidator.ts:358,446`). |
| `ports[]` | yes (may be empty) | `{ container, protocol, visibility? }`. `visibility` absent means `'public'` (`gameServerValidator.ts:621-623`). `protocol: 'icmp'` reuses `container` as the ICMP type 0-255 (`:786-814`). |
| `webPort` | iff `https` | The Caddy upstream; integer 1-65535, not 80/443; forbidden when not HTTPS (`gameServerValidator.ts:704-733`). Gets no security-group ingress (`gameServerConfig.ts:236-243`). |
| `https` | no | Absent reads as `false`, never a third state (`gameServerConfig.ts:263-283`). |
| `environment[]` | no | Non-empty, unique names (`gameServerValidator.ts:505-530`); values may carry allow-listed `${hyveon.*}` tokens (`:548-584`). |
| `command[]` | no | Required when any value uses `${hyveon.network.public-ipv4}`, because the boot wrapper replaces the image's start command (`gameServerConfig.ts:246-254`, `gameServerValidator.ts:576-581`). |
| `volumes[]` | yes, at least one | EFS mounts; `container_path` must be absolute (`gameServerValidator.ts:297-299,475-503`). |
| `file_seeds[]` | no | Files seeded onto EFS; absolute `path` (`:491-500`). |
| `connect_message` | no | Discord hint; only `{host}`, `{ip}`, `{port}`, `{game}` placeholders (`:533,597-614`). |
| `healthCheck` | no | Replaces the network-traffic idle heuristic (`gameServerConfig.ts:299-306`); rules in `checkHealthCheckRules` (`gameServerValidator.ts:992`). |
| `pinnedHostname` | no | Node.js-only `os.hostname()` override; `PINNED_HOSTNAME_PATTERN`, and neither the game nor a volume may use the shim's reserved name or mount path (`gameServerValidator.ts:62-72,944`). |

The game name itself is not checked by `validateGameServer`. `GAME_NAME_PATTERN` (`gameServerValidator.ts:51`) is enforced server-side by `DeploymentConfigService` when it inserts the entry (`DeploymentConfigService.ts:208-210`) and client-side by the wizard's `checkName` (`app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts:435-460`), and duplicate names are pre-checked by `GamesWriteService.createGame` (`GamesWriteService.ts:130-136`).

Two derived shapes cross the IPC boundary. `RedactedGameServer` (`gameServerConfig.ts:354`) is what the renderer sees for a declared game. `GameListEntry` (`gameServerConfig.ts:392-416`) is one row of the merged list: `declared` (in `gameServers`), `deployed` (in the stack's `gameNames` output), the redacted `config` when declared, and an optional `drift` finding.

The legacy HTTPS shape (an `https: true` game with no `webPort`, where `ports[0]` was the implicit Caddy upstream) is still readable. `normalizeGameServer` rewrites it to the explicit shape on read and is marked `@deprecated` with a removal condition (`gameServerPorts.ts:33-66`); `findWebPortCollisions` rechecks raw reads that bypass the write-path validator (`gameServerPorts.ts:118-136`).

## Validation: One Rule Set, Two Callers

`validateGameServer(name, proposed, existingGameServers)` (`gameServerValidator.ts:1058-1106`) takes untrusted input and returns either `{ success, data: GameServer }` or a list of `{ path, message }` issues. Its structure is deliberate: field-level business rules run only after the zod parse succeeds (`:1065-1076`), but the port and HTTPS rules run on the raw `ports`/`https`/`webPort` independently of the full parse (`:1078-1097`), so a wizard draft still missing `volumes` gets HTTPS feedback on the networking step. The comment at `:1078-1082` states this reason.

The cross-game rules exist because all games share one security group whose ingress rules union:

| Rule | Function | What it prevents |
|---|---|---|
| Port collisions within and across games, keyed `container/protocol` case-insensitively | `checkPortCollisions` (`:640-692`) | Two games claiming the same port; `icmp` pairs may repeat across games if effective visibility matches (`:670-681`). |
| HTTPS extras must be tcp/udp, not 80/443, and no tcp extra equal to `webPort` | `checkHttpsPortRules` (`:749-777`) | Breaking the Caddy sidecar's bind. |
| 80/443 tcp reserved for every game once any game is HTTPS, in both edit orders | `checkReservedHttpsPortsAcrossDeployment` (`:894-938`) | An `internal` 443 rule sitting beside Caddy's `0.0.0.0/0` rule. |
| No tcp port equal to another game's `webPort`, in both directions | `checkWebPortCollisionsAcrossDeployment` (`:838-875`) | Exposing another game's upstream directly, bypassing Caddy. |

The renderer calls the same function through `validateWizardDraft` (`wizard-form.utils.ts:579-615`), which adds name, image and ICMP-row checks, runs `checkConnectMessagePlaceholders` even when the structural parse failed, and dedupes. `validateStep` (`:639-650`) filters issues to the current step by mapping each issue path's first segment to a step (`stepForIssuePath`, `:395-418`); unknown paths fall to `review`. `existingGames` comes from `api.games()` on open, and the edit form validates everything as one `review` pass in `'edit'` mode (`app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx:110`).

Where intent and code differ: the established Caddy port constraints are the 80/443 reservation, tcp/udp-only extras, no extra equal to `webPort`, and the deployment-wide 80/443 reservation; the code enforces a fifth, the cross-game `webPort` rule (`GAME-HTTPS-009`, `GAME-HTTPS-010`). The design intent that `checkPortCollisions` covers `webPort` does not match the code: `webPort` is handled by separate functions (`checkHttpsPortRules` same-game, `checkWebPortCollisionsAcrossDeployment` cross-game) and `checkPortCollisions` sees only `ports`. Protocol is also loosely typed: `gameServerPortSchema` accepts any string (`gameServerValidator.ts:77`) though the field doc says it must be the exact lowercase string (`gameServerConfig.ts:29-36`), and comparisons are mixed: `portKey`, `isTcpPort` and `isCaddyReservedPort` lowercase (`:616-618,817-824`) while `checkHttpsPortRules` (`:753,765`) and `normalizeGameServer` (`gameServerPorts.ts:62`) compare exactly.

## The Write Path

All three writes enter through `GamesController` (`games.controller.ts:132-162`), which returns `GamesWriteService`'s `GameWriteResult` verbatim and never throws, because `ipcMain.handle` strips custom error properties and the renderer needs `code`, `issues` and the etags (`:123-131`).

`createGame` and `updateGame` share one sequence (`GamesWriteService.ts:114-172,201-246`):

1. Validate the write-side health-check credential input (`validateHealthCheckAuthInput`, `:116,206`).
2. Read siblings from `DeploymentConfigService.getGameServers()`. Create rejects a duplicate name here (`:130-136`), before any AWS call, because a later duplicate failure would arrive after the existing game's live secret had been overwritten (`:123-129`).
3. Structural pass: validate a preview in which a `basic`/`bearer` credential carries the inert `STRUCTURAL_PREVIEW_SECRET_ARN` (`:53,142-146,215-219,411-433`), so port, Fargate and other rules reject the entry before Secrets Manager is touched.
4. Resolve the credential for real (`resolveHealthCheckAuthSecret`, `:474-511`): `undefined` keeps the prior `auth`; `null` clears it and deletes an app-owned secret; `raw` uses the operator's ARN and deletes a now-orphaned app-owned secret; `basic`/`bearer` upsert `hyveon-{game}-healthcheck-auth`.
5. Validate again with the real ARN (`:149,223`).
6. Write through `DeploymentConfigService`, forwarding `expectedVersionId`.
7. On success (`successResult`, `:308-337`): invalidate both the deployment-config and stack-outputs caches, log, `AuditService.record` with redacted before/after and `versionId`, and return the redacted game plus a freshly merged list so the renderer needs no second round trip.

`deleteGame` skips validation, removes the entry, and only then deletes an app-owned secret (`:267-293`). Secret deletion failures are logged and swallowed so cleanup never blocks the write (`:527-539`).

| Thrown during the config write | create result | update/delete result |
|---|---|---|
| `OptimisticLockError` | `conflict` with both etags (`:159-161,346-359`) | `conflict` |
| `GameServerEntryError` `invalid-name`/`duplicate-name` | `validation`, path `name` (`:162-164`) | n/a |
| `GameServerEntryError` any reason | `error` | `not_found` (`:236-238,279-281`) |
| `ConfigurationNotConfiguredError` | `setup_incomplete` (`:369-372`) | `setup_incomplete` |
| anything else | `error`, generic message (`:382-385`) | `error` |

Two ordering properties matter. First, the secret write in step 4 precedes the config write in step 6, and nothing rolls it back. Step 3 removes most reasons the config write could fail, but not all: a conflict, a not-found on update (an `updateGame` for an undeclared name resolves with `before = null` and will upsert a fresh secret, `:204,221`), a setup-incomplete or an S3 error all return a modeled failure with the secret already created, changed or deleted. An upsert failure itself is rethrown as a plain `Error` (`:514-525`), so it escapes as a rejection rather than a `GameWriteResult`, contrary to the controller's "never throws" contract. Second, optimistic locking is opt-in and unused by this leaf's UI: no games write in `@hyveon/web` sends `expectedVersionId` (the settings form is the only caller that does, `app/packages/web/src/hooks/use-deployment-settings.hook.ts:24-32,324`), and `DeploymentConfigService.writeConfig` then fetches and puts without `ifMatch` (`DeploymentConfigService.ts:586-596,618-631`). Game writes are therefore last-writer-wins at the document level.

## IPC Surface and the Games List

| Channel | Payload | Returns | Owner of behaviour |
|---|---|---|---|
| `games.list` | none | `{ games: GameListEntry[] }` | this leaf (`games.controller.ts:53-60`) |
| `games.status` / `games.getStatus` | none / game | ECS status | `task-and-dns` via `EcsService` (`:73-91`) |
| `games.start` / `games.stop` | game | ECS result; `games.start` first returns `success: false` without calling ECS while `helper-task`'s `HelperSessionRegistry.hasUploadHolders(game)` is true (`:105-108`) | `task-and-dns` (`:102-122`) |
| `games.create` / `games.update` | `CreateGamePayload` / `UpdateGamePayload` (`gamesWrite.ts:117-131`) | `GameWriteResult` | this leaf (`:132-149`) |
| `games.delete` | `DeleteGamePayload` (`gamesWrite.ts:134-137`) | `GameWriteResult` | this leaf (`:158-162`) |
| `games.draft.get` | none | `StoredGameWizardDraft \| null` (redacted) | this leaf (`:168-172`) |
| `games.draft.save` | `{ draft, stepIndex }` | void | this leaf (`:178-182`) |
| `games.draft.updateStepIndex` | `{ stepIndex }` | void | this leaf (`:189-193`) |
| `games.draft.clear` | none | void | this leaf (`:199-203`) |

`games.list` invalidates only the deployment-config cache, then reads declared games and stack outputs in parallel, computes drift locally with the pure `computeDriftFromOutputs`, and merges (`games.controller.ts:54-60`). The doc comment explains both choices: calling `DriftService.getDrift()` would issue a second racing S3 read, and the stack-outputs cache fronts an expensive Pulumi round trip on a hot path, so it is invalidated on write instead (`:37-51`). `mergeGameLists` is pure and deterministic: declared entries in `deployment-config.json` order, then deployed-only "ghost" entries in deployed order (`mergeGameLists.ts:18-20,26-59`).

The games page renders the merged rows with "In sync", "Pending deploy" and "Undeclared" status chips plus drift (`app/packages/web/src/pages/games.page.tsx:27-35`, `game-status-badges.component.tsx:41`). The detail page reads the same list and finds its row by name; a failed list read becomes an empty list and therefore "not found" (`app/packages/web/src/pages/game-detail.page.tsx:112-121`). Remove is a type-to-confirm `AlertDialog` (`remove-game-button.component.tsx:24-31,46`) that tells the operator the AWS resources stay live until the next apply.

## Wizard, Edit Form and Draft Persistence

The add wizard (`app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx:95`) is a dialog over the six `ADD_GAME_WIZARD_STEPS`: identity, resources, networking, storage, environment, review. "Next" is gated on the current step's issues (`:223-230`); after a server rejection the step shows the server's issues instead of live ones until the next edit clears them (`patchDraft` clears them, `:200-205`; selection at `:224-228`). On a `validation` result the wizard jumps to the step of the first issue only (`:279-284`); every other failure lands on review with the message (`:286-297`). On success it persists any folder-seed selection, clears the draft and navigates to the new game's page (`:259-276`). The edit form reuses the step components as one flat form with the name read-only and submits `games.update` (`edit-game-form.component.tsx:42,120-150`). Both convert the draft with `draftToPayload` (`wizard-form.utils.ts:348`) while live validation converts it with `toProposedEntry` (`:463`): two builders for one shape.

The draft is one slot, `addGameWizardDraft`, in electron-store (`app/packages/desktop-main/src/services/ElectronStoreService.ts:278-284`), because only one add wizard can be open. Its lifecycle:

- **Autosave.** `useWizardDraftAutosave` debounces 1 s through an RxJS subject and suppresses saves while a submit is in flight, rechecking at fire time (`app/packages/web/src/components/add-game-wizard/use-wizard-draft-autosave.hook.ts:95-105,160-188`). Nothing is saved until the operator makes a field edit or a stored draft already exists (`:86-93,186`).
- **Flush.** Dialog close and component unmount flush immediately, bypassing debounce and the submit gate; effect order is load-bearing (`:10-15,143-152`).
- **Read.** `GameWizardDraftService.get` treats any malformed entry as no draft (`GameWizardDraftService.ts:35-50,114-127`), backfills fields added since the draft was saved (legacy HTTPS `webPort`, port `visibility`, health check, `command`; `:45,275-339`), and blanks env values, file-seed content and health-check credentials before returning (`:344-360`).
- **Step-only navigation on a resumed draft.** Because the renderer holds the blanked copy, saving it would overwrite the real values on disk, so pure navigation calls `updateStepIndex`, which touches only `stepIndex` (`GameWizardDraftService.ts:70-93`, hook `:73-85,171-173`).
- **Resume.** The games page fetches the draft on mount and shows a Resume/Discard banner; after a resumed wizard closes it re-fetches rather than trusting its mount-time copy (`games.page.tsx:100-135`).

The draft is stored in plaintext on disk; `ElectronStoreService` justifies this by matching the plaintext `deployment-config.json` it becomes (`ElectronStoreService.ts:157-167`). That remark predates health-check `basic`/`bearer` credentials, which the draft also carries and which are written to a Secrets Manager secret, not to the config, on submit.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Where validation rules live | One `validateGameServer` in `@hyveon/shared`, run by renderer and main | Separate client and server validators | Stated in code: "single source of truth" exports so wizard and server phrase errors identically (`gameServerValidator.ts:779-785`, `wizard-form.utils.ts:424-427`). |
| When port/HTTPS rules run | Independently of the full structural parse | Run all rules only after a successful parse | Stated: an incomplete draft must not "silently swallow HTTPS feedback" (`gameServerValidator.ts:1078-1082`). |
| Who checks the game name | `DeploymentConfigService` and the wizard, not `validateGameServer` | Name rule inside the validator | [inferred] The name is the map key, not part of the stored value, so it is checked where the key is inserted. |
| HTTPS upstream | Explicit `webPort`, required iff `https` | `ports[]` entry flagged `upstream: true`; keep `ports[0]` ordering | Explicit beats positional: a flagged `ports[]` entry still mixes concerns and allows zero or two flagged entries, and keeping the ordering while only fixing the message leaves the confusion. 80/443 stay rejected for `webPort` because Caddy binds them in the shared task network namespace, so a collision is real. The one friction point, operators who type 443, is accepted and explained by the error message and field help. |
| Legacy HTTPS configs | Read-time `normalizeGameServer`, persisted on next save, `@deprecated` | Write-time migration on app start; legacy-tolerant validator and infra forever | A write-time migration would write to the operator's S3 without an operator action, and a legacy-tolerant validator and infra program would keep two code paths forever. The read-time helper is idempotent, needs no schema version (an optional field with no migration, as for internal ports), and infra, which reads config through the same service, only ever sees the new shape. All readers go through `DeploymentConfigService`; wizard drafts get the same normaliser through the draft backfill hook. Consequence: S3 keeps the legacy shape until the next save, so rolling back after a save needs an S3 version restore (`restoreRawConfig`). Normalising `ports.slice(1)` newly exposes old HTTPS extra ports on the next apply; the infra preview shows the new rules before apply. |
| HTTPS extra-port exposure | `webPort` gets no ingress, so Caddy stays the only public entry; extra `ports[]` entries do (public to `0.0.0.0/0`, internal to the VPC CIDR) | Leave HTTPS extras without ingress | UDP voice and game traffic is the reason extras exist, so extras without ingress would be unusable. `healthCheck.port` may equal `webPort` or be a declared tcp extra, since a health check on the web port is the common HTTPS case; the Discord `{port}` renders the public 443 URL form for HTTPS games. The port helpers live in the pure `gameServerPorts.ts` so no layer keeps a copy and the shared barrel stays free of AWS imports. |
| ICMP | A `ports` entry with `protocol: 'icmp'`, type in `container`, exempt from cross-game collisions when visibility matches | `allow_ping` boolean; always-on ICMP | The SG fan-out, per-port `visibility`, wizard port rows and collision validation already key off `ports`, so ICMP is one union-member extension rather than a new config surface; `container` carries the ICMP type, the same pun the EC2 API makes (`FromPort` is the type). A per-game boolean would add a field across the shared type, wizard and docs for what is still ingress, and always-on ICMP gives no opt-out and silently becomes an invariant. Cross-game collisions exempt `icmp` because several games legitimately want ping on the shared game security group; keeping the rule and declaring it on one game only would make that game's config load-bearing for another's reachability. Types 0-255 are accepted (the SG rule is `toPort: -1`, all codes) and the wizard defaults to type 8, echo request, the only type with a current use; type-8-only would need re-specifying for any other type, and an all-types `-1` has no use case and broadens exposure. ICMP entries are filtered out of ECS `portMappings` (ECS rejects non-tcp/udp mappings) and out of the Discord connect port. The motivating evidence is that a browser join needs ICMP echo: flow logs on 2026-08-31 showed two ICMP echo REJECTs and then no UDP until a manual rule was added. |
| Pinned hostname | `pinnedHostname?: string` with a JS-safe alphabet | Boolean derived from game key; strict RFC 1123; free text | One optional string holds the exact value `os.hostname()` returns, so an operator can match an existing license host; a derived boolean cannot match one or rename later, and a generic preload-script list is an arbitrary-code surface for one behaviour. The alphabet `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$` (exported with a description string, like the game-name pattern) admits underscores because the value is only returned from JavaScript, never DNS-resolved; strict RFC 1123 would reject the verified `my_foundry_host`, and free text would make this layer own escaping guarantees. The restricted set cannot escape a JS string or a shell argument. |
| Pinned hostname reserved path and drift | While `pinnedHostname` is set, `volumes[i].container_path` may not equal or sit under `/hyveon/hostname-shim`; no drift field for `pinnedHostname` | Let ECS reject or shadow overlapping mounts at `RunTask`; add a drift field | Validation is an earlier, clearer failure than a `RunTask` rejection. The drift field set is deliberately closed (`environment`, `command` and `https` are not in it either); whether `pinnedHostname` should join it is Deferred question 8. |
| Pinned hostname UI | A "Pin hostname" switch on the environment step, defaulting the value to the game name, with Node.js-only helper text and a review-step line | A separate advanced section | The environment step already owns the other process-start knobs and the edit form reuses it. Hyveon cannot inspect an image's runtime, so the helper text states "Node.js game servers only" first and tells the operator to confirm what their image runs; an empty string with the switch on is passed through so the pattern rule blocks the step rather than silently saving nothing. |
| Secret ordering on create/update | Structural preview with an inert ARN, then upsert, then config write | Write config first then secret; roll back the secret on failure | Stated for the preview (`GamesWriteService.ts:455-463`); the remaining secret-before-config order is [inferred] to follow from validation needing a real ARN. |
| Duplicate-name check placement | Up front in `createGame`, before any AWS call | Rely on `addGameServer` throwing | Stated: prevents overwriting an existing game's live secret (`GamesWriteService.ts:83-91`). |
| Error transport across IPC | Modeled `GameWriteResult` union, handlers never throw | Throw typed errors | Stated: `ipcMain.handle` strips custom error properties (`games.controller.ts:123-131`). |
| Optimistic locking for game writes | Opt-in `expectedVersionId`, not sent by the UI | Always send the last-read etag (as the settings form does) | [inferred] Per-game entries rarely contend in a single-operator desktop app; `use-deployment-settings.hook.ts:24-27` calls it "an opt-in caller convenience" without saying why. |
| Games list freshness | Invalidate deployment-config cache per call; stack outputs only on write | Invalidate both on every read; call `DriftService` | Stated: avoids a second racing S3 read and a hot-path Pulumi round trip (`games.controller.ts:37-51`). |
| Draft storage | One plaintext electron-store slot, redacted on read, step-only updates for resumed drafts | Encrypted field; no redaction; no draft | Stated: one wizard at a time, plaintext matches the config it becomes, redaction keeps secrets out of the renderer (`ElectronStoreService.ts:157-167,280-283`, `GameWizardDraftService.ts:13-23`). |
| Remove dialog | AlertDialog primitives with type-to-confirm | Shared `ConfirmDialog` | Stated: `ConfirmDialog`'s plain-text description cannot carry the plan/apply hint (`remove-game-button.component.tsx:24-31`). |

## Open Questions & Future Decisions

### Resolved

1. ✅ HTTPS games declare an explicit `webPort`; `ports[]` become optional extras that receive ingress (`GAME-HTTPS-004` onward).
2. ✅ ICMP is modelled as a port entry and may repeat across games at matching visibility (`GAME-PORT-009` through `GAME-PORT-015`).
3. ✅ The pinned hostname is a literal string delivered by a busybox init container that writes a shim into task-ephemeral storage, preloaded through `NODE_OPTIONS` merged shim-first with any operator value. Rejected delivery routes: `file_seeds` onto EFS (Hyveon code in operator save data), an inline `--import=data:` shim (unverified and quoting-sensitive), and a custom image (Hyveon never builds images). If the init container fails the game never starts, with the reason in the stopped reason and the `hostname-shim` log stream.

### Deferred

1. Should the health-check secret be written only after a successful config write, or rolled back on conflict, not-found, setup-incomplete or S3 failure? Today it is mutated first (`GamesWriteService.ts:148,157,221,231`), including a fresh upsert for an `updateGame` on an undeclared name (`:204,221`), and deletes on clear/switch-to-raw also happen before the config write (`:480-505`).
2. Should a Secrets Manager upsert failure return a `GameWriteResult` instead of rejecting with a plain `Error` (`GamesWriteService.ts:514-525`), given the controller promises never to throw (`games.controller.ts:123-131`)?
3. Should `updateGame`/`deleteGame` distinguish `GameServerEntryError` reasons instead of mapping all of them to `not_found` (`GamesWriteService.ts:236-238,279-281`)? A `structural` reason (missing `gameServers` map) is not a not-found.
4. `errorResult` logs the raw error object (`GamesWriteService.ts:383`), which `.claude/rules/logging.md` forbids. Should it log the normalised message?
5. Should `protocol` be validated as `tcp|udp|icmp` for every game, and should every comparison be case-insensitive or the value be normalised on read (`gameServerValidator.ts:77,753,765,1001`, `gameServerPorts.ts:62`)?
6. Should game writes from the UI send `expectedVersionId`? Without it `writeConfig` is a fetch-then-unconditional-put (`DeploymentConfigService.ts:586-596,630`), so two concurrent writers silently lose one edit, and the `conflict` UI branches (`add-game-wizard.component.tsx:286`, `edit-game-form.component.tsx:141`) are unreachable from this leaf's own callers.
7. Which release removes the `@deprecated` `normalizeGameServer` read-time compatibility (`gameServerPorts.ts:33-66`)? It is removable once no supported release can have written the legacy HTTPS shape (`ports[0]` as upstream, no `webPort`); the target was the first minor after the release that ships `webPort` plus one release of overlap, and the owner has not picked the release.
8. Open questions for the pinned hostname: does entering the host an existing `license.json` was signed for skip the one-time EULA (unverified; enabling on an existing game otherwise needs one more acceptance), is the `--import=data:` variant viable for Foundry's ESM entry point (follow-up spike, no init container), and should `pinnedHostname` get a drift field or the drift banner state the narrowed scope (`CONFIG-DRIFT-008`)?
9. Should the assumption that `checkPortCollisions` covers `webPort` be corrected in the design, or should `checkPortCollisions` absorb `webPort` rather than leave it to `checkHttpsPortRules` and `checkWebPortCollisionsAcrossDeployment`?
10. The preload `GameServer`/`GameWizardDraft` mirrors lack `webPort` and `command` (`app/packages/desktop-preload/src/hyveon-api.ts:415-421,650-679`) and carry a "keep this copy in sync" comment, which `.claude/rules/duplication.md` treats as the bug report. Derive them from `@hyveon/shared`?
11. Should the wizard and detail page surface an `api.games()` failure instead of degrading to an empty list (`add-game-wizard.component.tsx:150-159`, `game-detail.page.tsx:112-121`)? The wizard's live cross-game checks pass vacuously; the server still catches collisions.
12. Should a `validation` result surface every affected step rather than jump only to the first issue's step (`add-game-wizard.component.tsx:279-284`)?
13. `handleDiscardDraft` has no error handling (`games.page.tsx:117-120`). Catch and toast?
14. After resuming a draft, the first field edit saves the full in-memory draft, whose env values, file-seed content and credentials were blanked on read (`use-wizard-draft-autosave.hook.ts:168-170`, `GameWizardDraftService.ts:344-360`), so the on-disk values are lost unless re-entered. Is that the intended "re-enter on resume" contract, and should `game-draft-persistence` say so?
15. Health-check `basic`/`bearer` credentials sit in plaintext in the draft on disk, while the `StoredGameWizardDraft` remark lists only env and file-seed redaction and justifies plaintext by the config's own posture (`ElectronStoreService.ts:157-167`). Should credentials be excluded from the persisted draft or encrypted?
16. Merge `draftToPayload` and `toProposedEntry` (`wizard-form.utils.ts:348,463`), which build the same shape with differing trim and fallback behaviour?
17. The review step renders env vars and the pinned hostname inside the "Storage" card (`review-step.component.tsx:122-166`) although `stepForIssuePath` maps them to the environment step (`wizard-form.utils.ts:412-415`). Give them their own card?
18. Test gaps: `updateStepIndex` has no service or controller test. `[unverified]` sweep claim: no tests for draft visibility backfill and credential redaction.
19. HTTP/Terraform-era residue in comments: `GamesWriteService.ts:3`, `gamesWrite.ts:4`, `gameServerConfig.ts:386-391` (`/api/games`, tfstate, issue number), `mergeGameLists.ts:7`, `wizard-form.utils.ts:215,340`. Remove?
20. `env-token-interpolation` still has a "TBD" Purpose and `game-port-visibility` has no title line. Fix in the specs?
21. Sweep disagreement, settled by code: sweep-6 flagged `games.list` not invalidating stack outputs as a bug; the doc comment (`games.controller.ts:43-50`) shows it is intentional. Should the EARS spec record the freshness contract (stale stack outputs until the next write or apply) explicitly?
22. `games.start` refuses while an upload holds the game's volumes (`games.controller.ts:105-108`), but the Discord `/server-start` Lambda path cannot see that in-process registry (`:96-98`). Should the guard move somewhere both start paths can read, or is the desktop-only guard accepted?

## References

- Arrow doc: `docs/arrows/game-server.md`
- EARS specs: `docs/intent/game-server/game-server-specs.md`, prefix `GAME`
- Parent: `docs/high-level-design.md`
- Docs pages: `docs/docs/app/games.md`, `docs/docs/components/management-app.md`, `docs/docs/components/infra.md`, `docs/docs/architecture.md`
- Neighbouring leaf design docs: `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/game-runtime/health-check/health-check-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/diagnostics/diagnostics-design.md`, `docs/intent/helper-task/helper-task-design.md`
