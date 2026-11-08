# Game Server Specs

EARS requirements for the `GAME` prefix; design and rationale live in `docs/intent/game-server/game-server-design.md`.

## Game Server Model

- [x] **GAME-MODEL-001**: The system shall represent each declared game as one entry of the `gameServers` map in `deployment-config.json`, keyed by the game name, with the stored value carrying `image`, `cpu`, `memory`, `ports`, `volumes` and the optional `webPort`, `https`, `environment`, `command`, `file_seeds`, `connect_message`, `healthCheck` and `pinnedHostname` fields. (observed)
- [x] **GAME-MODEL-002**: Whenever a declared game crosses the IPC boundary to the renderer (`games.list`, `games.create`, `games.update`), the system shall replace its `healthCheck.auth` with a `secretSet` boolean and an `authType`, never the secret ARN or credential. (observed)
- [x] **GAME-MODEL-003**: The games list (`games.list` and the refreshed list returned by every successful game write) shall return one entry per game that is declared in `deployment-config.json` or present in the deployed stack's `gameNames` output, each flagged `declared` and `deployed`, carrying the redacted config when declared and any drift finding for that game. (observed)
- [x] **GAME-MODEL-004**: The games list shall order entries as declared games in `deployment-config.json` order, followed by deployed-only games in stack-output order. (observed)

## Shared Validation

- [x] **GAME-VALID-001**: The renderer (add-game wizard and edit-game form) and the main-process game write path shall both validate a proposed game entry with the single `validateGameServer` function exported from `@hyveon/shared`, so both report identical issue paths and messages. (observed)
- [x] **GAME-VALID-002**: When `validateGameServer` rejects a proposed game entry, it shall return every issue found, each positioned with a JSON-path-like `path` (for example `ports[1]`, `volumes[0].container_path`, `webPort`). (observed)
- [x] **GAME-VALID-003**: When a proposed game entry fails the structural parse on an unrelated field, `validateGameServer` shall still run the port-collision, HTTPS, `webPort`, ICMP and deployment-wide reserved-port rules on the raw `ports`, `https` and `webPort` values, so an incomplete wizard draft still receives networking feedback. (observed)
- [x] **GAME-VALID-004**: The game validator shall reject a `cpu`/`memory` pair that is not a valid AWS Fargate task size (cpu 256 with memory 512/1024/2048; each higher tier with its stepped memory range), with the issue at `cpu` or `memory`. (observed)
- [x] **GAME-VALID-005**: The game validator shall reject a game entry with no `volumes` entry, any volume with an empty `name` or `container_path`, any volume `container_path` that is not absolute, and any `file_seeds[].path` that is not absolute. (observed)
- [x] **GAME-VALID-006**: The game validator shall reject any `{token}` in a game's `connect_message` other than `{host}`, `{ip}`, `{port}` and `{game}`, with the issue at `connect_message`. (observed)
- [x] **GAME-VALID-007**: When a game is created, the system shall reject a name that does not match `GAME_NAME_PATTERN` (a lowercase DNS-safe label of 1-32 characters), in both the add-game wizard and `DeploymentConfigService` when it inserts the entry. (observed)
- [x] **GAME-VALID-008**: While editing an already-declared game, the system shall not re-validate its name against the create-time name pattern, and the edit-game form shall render the name read-only. (observed)
- [x] **GAME-VALID-009**: The add-game wizard shall reject an empty or whitespace-only `image`, which the shared schema alone accepts. (observed)
- [x] **GAME-VALID-010**: The game validator shall reject any `ports[N].protocol` other than the exact lowercase strings `tcp`, `udp` and `icmp` for every game, HTTPS or not, with the issue at `ports[N].protocol`. (observed)
- [x] **GAME-VALID-011**: Where the shared port helpers and the HTTPS port rules read a `protocol` that has not passed `validateGameServer` (a raw `deployment-config.json` read, or a draft whose ports failed the structural parse), they shall compare it case-insensitively, so a hand-edited `TCP` is treated as `tcp` by the legacy `webPort` backfill and the HTTPS rules instead of behaving inconsistently. (observed)

## Resource Picker

- [x] **GAME-RES-001**: The add-game wizard's Resources step and the edit-game form's Resources section shall present vCPU and memory as two slider controls, not dropdowns, rendered by the same component.
- [x] **GAME-RES-002**: The vCPU slider in the game Resources step shall stop only at the seven Fargate vCPU tiers (0.25, 0.5, 1, 2, 4, 8, 16 vCPU).
- [x] **GAME-RES-003**: The memory slider in the game Resources step shall reach exactly the valid Fargate memory values for the selected vCPU tier, including the unevenly spaced 512/1024/2048 MiB values at 0.25 vCPU and the 4 GiB and 8 GiB steps at 8 and 16 vCPU.
- [x] **GAME-RES-004**: When the operator changes the vCPU slider in the game Resources step so that the selected memory is no longer valid for the new tier, the system shall reset memory to unset rather than re-clamp it.
- [x] **GAME-RES-005**: When the edit-game form opens, its Resources sliders shall be pre-populated with the game's declared `cpu` and `memory`.
- [x] **GAME-RES-006**: While both vCPU and memory are selected in the game Resources step, the system shall show a live hourly Fargate cost estimate computed by the same formula the Costs page uses. (observed)

## Environment Variables

- [x] **GAME-ENV-001**: The add-game wizard shall expose a game's `environment` rows in a dedicated Environment step between the Storage and Review steps, and the edit-game form shall expose them in an Environment section alongside Identity, Resources, Networking and Storage.
- [x] **GAME-ENV-002**: The game environment editor shall let the operator add a blank row, edit any row's `name` or `value`, and remove any row, with no minimum row count.
- [x] **GAME-ENV-003**: When the operator adds environment rows in the add-game wizard and submits, the create payload's config shall carry those rows as `environment`; when no row was added, the payload shall carry no `environment` entries.
- [x] **GAME-ENV-004**: When the edit-game form opens for a game with declared environment variables, the Environment section shall render one pre-filled row per declared variable.
- [x] **GAME-ENV-005**: When the operator saves the edit-game form, the update payload's `environment` shall reflect rows added or removed in the form and shall carry the declared rows unchanged when only an unrelated field was edited.
- [x] **GAME-ENV-006**: The game validator shall reject any `environment[N]` row with an empty `name`, and any row whose `name` duplicates an earlier row's `name` in the same game, with the issue at `environment[N].name`, on every game write path.
- [x] **GAME-ENV-007**: The game validator shall place no constraint on an environment row's `name` character set or casing beyond non-emptiness, except for rows whose value uses `${hyveon.network.public-ipv4}` (see GAME-TOKEN-009).
- [x] **GAME-ENV-008**: When a game environment row has a name or value issue, the add-game wizard and edit-game form shall block submission and display the issue next to that row's name or value input.
- [x] **GAME-ENV-009**: The game environment editor (add-game wizard Environment step and edit-game form Environment section) shall show a hint listing `${hyveon.network.public-address}` and `${hyveon.network.public-ipv4}` with a short description of each.
- [x] **GAME-ENV-010**: The game Environment step shall let the operator edit an optional `command` list of container start-command arguments, and the game validator shall reject an empty `command` argument. (observed)

## Env Token Interpolation

- [x] **GAME-TOKEN-001**: The system shall support the `${hyveon.<namespace>.<name>}` token grammar in game environment values against a fixed allow-list exported from `@hyveon/shared`, which is exactly `${hyveon.network.public-address}` and `${hyveon.network.public-ipv4}`.
- [x] **GAME-TOKEN-002**: The game validator shall accept an allow-listed token embedded anywhere in a longer environment value and shall accept several tokens in one value.
- [x] **GAME-TOKEN-003**: If a game environment value contains a `${hyveon.`-prefixed sequence (closed or unclosed) that is not on the allow-list, then the game validator shall reject it with an issue at that row's `environment[N].value` path naming the unknown token and listing the allowed tokens.
- [x] **GAME-TOKEN-004**: The system shall treat all game environment value content other than `${hyveon.*}` sequences, including `${OTHER_VAR}` shell syntax and brace text, as opaque data that passes validation and reaches the container definition byte-for-byte.
- [x] **GAME-TOKEN-005**: When the infra program builds a game's task definition, it shall replace every `${hyveon.network.public-address}` in that game's environment values with `<game>.<zone>`, baked into the task definition with no runtime component.
- [x] **GAME-TOKEN-006**: If no hosted zone is configured when the infra program runs, then the preview/apply shall fail before any task definition carrying an unresolved `${hyveon.network.public-address}` is created. Note: `defineAll` rejects any empty zone first with a generic message (`infra/src/program.ts:163-167`); the error naming the game and token (`infra/src/ecs.ts:129`) is defense in depth.
- [x] **GAME-TOKEN-007**: Where a game's environment values use `${hyveon.network.public-ipv4}`, the infra program shall leave the raw token in the task definition and set the game container's `entryPoint` to a generated `/bin/sh -c` wrapper that discovers the public IPv4 from `https://checkip.amazonaws.com` (wget, falling back to curl), re-exports exactly the token-bearing variables with the IP substituted, and then `exec`s the game's `command`.
- [x] **GAME-TOKEN-008**: The ipv4 entrypoint wrapper shall bound its public-IPv4 discovery retries by a total budget of approximately 60 seconds.
- [x] **GAME-TOKEN-009**: If a game environment row's value uses `${hyveon.network.public-ipv4}` and its `name` is not a shell identifier (`[A-Za-z_][A-Za-z0-9_]*`), then the game validator shall reject it with an issue at `environment[N].name`.
- [x] **GAME-TOKEN-010**: Where a game's environment values do not use `${hyveon.network.public-ipv4}`, the infra program shall set no `entryPoint` on that game's container.
- [x] **GAME-TOKEN-011**: If the ipv4 entrypoint wrapper cannot obtain a well-formed IPv4 address within its retry loop, then it shall exit non-zero without starting the game process, so the task stops and surfaces through stopped-task visibility.
- [x] **GAME-TOKEN-012**: The ipv4 wrapper generator shall embed every operator-supplied environment value and command argument only inside single-quoted shell strings with embedded quotes escaped as `'\''`, and shall splice the discovered IP through a shell variable, so operator content cannot inject shell syntax.
- [x] **GAME-TOKEN-013**: The game model shall support an optional `command` string array that the infra program passes through verbatim as the game container's `command`, whether or not any token is used.
- [x] **GAME-TOKEN-014**: If a game's environment values use `${hyveon.network.public-ipv4}` while `command` is absent or empty, then the game validator shall reject the entry with an issue at `command` explaining that the boot wrapper replaces the image's start command.

## HTTPS

- [x] **GAME-HTTPS-001**: The add-game wizard and the edit-game form shall expose a game's `https` flag as a toggle in the Networking step, defaulting to off for a new game and reflecting the declared value when editing.
- [x] **GAME-HTTPS-002**: When the operator submits the add-game wizard or the edit-game form, the payload shall always carry `https` as an explicit boolean: `true` when the toggle is on, `false` when it is off or was never touched, and the declared value unchanged when only another field was edited.
- [x] **GAME-HTTPS-003**: When a game is written through the game write path, its `https` value shall persist to `deployment-config.json` as written (an explicit `false` stays `false` rather than being omitted) and shall be read back into the edit-game form, with no other field disturbed.
- [x] **GAME-HTTPS-004**: The game model shall carry an optional `webPort` naming the container port the Caddy sidecar proxies to, never implied by the order of `ports`.
- [x] **GAME-HTTPS-005**: While a game has `https: true`, the game validator shall require `webPort` to be present, an integer from 1 to 65535, and neither 80 nor 443, reporting each violation at `webPort` with a message explaining the rule.
- [x] **GAME-HTTPS-006**: If a game with `https` false or omitted declares `webPort`, then the game validator shall reject it with an issue at `webPort` stating it is only valid when HTTPS is enabled.
- [x] **GAME-HTTPS-007**: While a game has `https: true`, the game validator shall reject any `ports[N]` entry whose protocol is not `tcp` or `udp`, any entry on container port 80 or 443, and any `tcp` entry equal to `webPort`, each pathed at `ports[N]`, and shall accept an empty `ports` list or a first entry using `udp`.
- [x] **GAME-HTTPS-008**: While a game has `https` false or omitted, the game validator shall apply none of the HTTPS port constraints to that game's own `ports`.
- [x] **GAME-HTTPS-009**: The game validator shall reject a `tcp` `ports` entry on one game that equals another game's `webPort`, and a `webPort` that equals another game's `tcp` `ports` entry, in either edit order, with the issue at the offending `ports[N]` or `webPort` naming the other game.
- [x] **GAME-HTTPS-010**: When the Pulumi preview/apply reads `deployment-config.json` directly, the system shall re-check the cross-game `webPort` collision of GAME-HTTPS-009 and refuse the run with an error naming both games if one exists. (observed)
- [x] **GAME-HTTPS-011**: While the HTTPS toggle is on, the game Networking step shall render a dedicated web-port field, separate from the port list, labelled as the port the game's web server listens on and stating that Caddy serves it publicly on 443, and shall label the port list as optional additional ports.
- [x] **GAME-HTTPS-012**: While the HTTPS toggle is off, the game Networking step shall render no web-port field and the submitted payload shall carry no `webPort`.
- [x] **GAME-HTTPS-013**: While an HTTPS constraint violation remains, the add-game wizard and edit-game form shall disable advancing or saving, and shall attribute issues pathed at `webPort` or `ports[N]` to the Networking step, clearing them once the input is corrected.
- [x] **GAME-HTTPS-014**: While the HTTPS toggle is on, the game Networking step shall show an inline warning callout beside it stating that ports 443 and 80 open to the internet for the whole stack, that the web port is no longer directly reachable and is reached through the sidecar (additional ports following their own visibility), and that first boot performs a Let's Encrypt (ACME) issuance requiring the game's hostname to resolve to the running task; while the toggle is off, no callout shall render.
- [x] **GAME-HTTPS-015**: When `DeploymentConfigService` reads a legacy game with `https: true` and no `webPort`, it shall return `webPort` equal to the first `ports` entry's `container` and `ports` equal to the remaining entries, idempotently, without operator action, persisting the new shape only on the next ordinary save; configs that already declare `webPort` shall pass through unchanged.
- [x] **GAME-HTTPS-016**: When the add-game wizard draft is read back from storage, the system shall apply the same legacy HTTPS normalisation as GAME-HTTPS-015.
- [x] **GAME-HTTPS-017**: If a legacy HTTPS game's first `ports` entry is not `tcp` or has no container yet, then the legacy normaliser shall leave the game unchanged so validation reports the missing `webPort` rather than guessing. (observed; refines GAME-HTTPS-015, which states the normalisation unconditionally)

## Ports, Visibility and ICMP

- [x] **GAME-PORT-001**: The game model shall accept an optional per-port `visibility` of exactly `'public'` or `'internal'`, and every consumer (security-group ingress, wizard display, validation) shall treat an omitted `visibility` as `'public'`, so configs written before the field existed behave unchanged.
- [x] **GAME-PORT-002**: If a game port declares a `visibility` other than `'public'` or `'internal'`, then the game validator shall reject the configuration with an issue identifying the offending port.
- [x] **GAME-PORT-003**: The infra program shall ingress every game port with effective visibility `'public'` on the `game_servers` security group from `0.0.0.0/0`, and every `'internal'` port from the VPC CIDR block only, with no `0.0.0.0/0` rule for it, for HTTPS games' additional ports exactly as for non-HTTPS games.
- [x] **GAME-PORT-004**: The infra program shall give an HTTPS game's `webPort` no security-group ingress of its own, so it is reachable only through the Caddy sidecar's public 443/80 ingress.
- [x] **GAME-PORT-005**: The game validator shall reject a `container/protocol` pair (protocol compared case-insensitively) that repeats within one game's `ports`, and a `tcp` or `udp` pair that another declared game already uses, excluding the game being edited from the sibling scan.
- [x] **GAME-PORT-006**: While any game in the deployment has `https: true`, the game validator shall reject container port 443 or 80 with protocol `tcp` on every other game regardless of its visibility, identifying the HTTPS game that reserves it, in both edit orders (declaring the port first or enabling HTTPS first).
- [x] **GAME-PORT-007**: While no game in the deployment has `https: true`, the game validator shall accept container port 443 or 80 on `tcp`, and it shall accept 443 or 80 on `udp` regardless of HTTPS.
- [x] **GAME-PORT-008**: The add-game wizard and edit-game form shall let the operator set each port's visibility to Public or VPC-only, defaulting new ports to Public, persisting VPC-only as `visibility: 'internal'` and Public by omitting `visibility`.
- [x] **GAME-PORT-009**: The game model shall accept `protocol: 'icmp'` on a port entry, with `container` read as the ICMP type, and while a game is not HTTPS the game validator shall reject an ICMP type outside the integers 0 to 255, identifying the entry and stating the range.
- [x] **GAME-PORT-010**: If a game with `https: true` declares an `icmp` port, then the game validator shall reject it through the HTTPS tcp/udp-only rule.
- [x] **GAME-PORT-011**: For each game `icmp` port, the infra program shall declare a `game_servers` ingress rule with protocol `icmp`, `fromPort` equal to the type and `toPort` `-1`, sourced from `0.0.0.0/0` or the VPC CIDR by visibility, and shall add no ECS `portMappings` entry for it.
- [x] **GAME-PORT-012**: The game validator shall permit the same `icmp` type on several games when every declaration has the same effective visibility, and the infra program shall emit one deduplicated rule for it; if two games declare the same `icmp` type with different effective visibility, then validation shall reject it naming both games.
- [x] **GAME-PORT-013**: The game Networking step shall offer `tcp`, `udp` and `icmp` in each port row's protocol dropdown and, when `icmp` is selected on a blank row, shall prefill the field with 8, label it as the ICMP type with an "8 = echo request (ping)" hint, and block the step with "ICMP type must be an integer between 0 and 255" for an out-of-range value.
- [x] **GAME-PORT-014**: When the infra program builds the Discord `GAME_PORTS` connect-port map, it shall skip `icmp` entries and use the first public non-`icmp` port for a non-HTTPS game, and shall map an HTTPS game to the public 443 URL form rather than `webPort` or any additional port.
- [x] **GAME-PORT-015**: If a non-HTTPS game has non-`icmp` ports but none with public visibility, then the Discord `GAME_PORTS` map shall fall back to its first non-`icmp` port, internal or not. (observed: `infra/src/lambdas.ts:317-318`)

## Pinned Hostname

- [x] **GAME-HOST-001**: The game model shall accept an optional `pinnedHostname` string, the exact value `os.hostname()` returns inside that game's Node process, which carries no secret and round-trips unchanged through `deployment-config.json` and the redacted game shape.
- [x] **GAME-HOST-002**: When a game without `pinnedHostname` is saved and read back, the system shall not synthesise a `pinnedHostname` key.
- [x] **GAME-HOST-003**: If a game's `pinnedHostname` does not match `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`, then the game validator shall reject it with an issue at `pinnedHostname`, using the same pattern and message text in the wizard and the main process.
- [x] **GAME-HOST-004**: While a game declares `pinnedHostname`, the game validator shall reject a volume whose `container_path` is `/hyveon/hostname-shim` or under it (issue at that volume's `container_path`), a game named `hostname-shim` (issue at `name`), and a volume named `hostname-shim` (issue at that volume's `name`).
- [x] **GAME-HOST-005**: While a game declares no `pinnedHostname`, the game validator shall apply no hostname-shim name or path reservation to it.
- [x] **GAME-HOST-006**: Where a game declares `pinnedHostname`, the infra program shall add to that game's task definition only: a `<game>-hostname-shim` volume with no EFS configuration; a non-essential `hostname-shim` container on a pinned public busybox image that mounts the volume read-write at `/hyveon/hostname-shim` and writes `hostname-shim.js`, a CommonJS module replacing `require('node:os').hostname` with a function returning the configured value; and, on the game container, `dependsOn` `{ containerName: "hostname-shim", condition: "SUCCESS" }` plus a read-only mount of the volume at `/hyveon/hostname-shim`.
- [x] **GAME-HOST-007**: The pinned-hostname feature shall declare no resource outside the task definition, no ECS Service, and shall leave the Caddy sidecar definition identical to that of the same game without `pinnedHostname`.
- [x] **GAME-HOST-008**: Where a game declares no `pinnedHostname`, the infra program shall emit no `hostname-shim` container, volume, mount or `NODE_OPTIONS` entry for it, even when another game pins one.
- [x] **GAME-HOST-009**: Where a game declares `pinnedHostname`, the infra program shall give the game container exactly one `NODE_OPTIONS` entry: `--require=/hyveon/hostname-shim/hostname-shim.js` alone when the operator set none, or that flag, a space, then the operator's token-resolved value when they did.
- [x] **GAME-HOST-010**: Where a game declares `pinnedHostname`, a `command` and a `${hyveon.network.public-ipv4}` value, the infra program shall keep the ipv4 `/bin/sh -c` wrapper entrypoint and the merged `NODE_OPTIONS` entry together.
- [x] **GAME-HOST-011**: The game Environment step (add-game wizard and edit-game form) shall offer a "Pin hostname" switch whose helper text states it works only for Node.js game servers, names the hostname-bound-license use case (Foundry VTT), and states that enabling it on an existing game requires accepting the EULA once more.
- [x] **GAME-HOST-012**: When the operator turns "Pin hostname" on, the game Environment step shall set the pinned hostname to the trimmed game name and reveal an editable field bound to it; when turned off, the value shall be cleared so the submitted entry has no `pinnedHostname` key.
- [x] **GAME-HOST-013**: When the edit-game form opens for a game with `pinnedHostname`, the switch shall be on and the field shall show the declared value.
- [x] **GAME-HOST-014**: If the pinned hostname field holds an invalid value, then the game Environment step shall show the shared validation message and block advancing.
- [x] **GAME-HOST-015**: While the add-game draft has a pinned hostname, the review step shall list it.
- [x] **GAME-HOST-016**: The add-game review step shall group environment variables and the pinned hostname under an Environment summary, matching the step that owns those fields. (observed)

## Write Path

- [x] **GAME-WRITE-001**: When a game create or update is submitted, the main process shall validate it with `validateGameServer` against every currently declared game before writing, regardless of what the renderer already checked. (observed)
- [x] **GAME-WRITE-002**: When a game create names a game that is already declared, the game write path shall return a `validation` result at path `name` before any Secrets Manager call. (observed)
- [x] **GAME-WRITE-003**: When a game create or update carries a `basic` or `bearer` health-check credential, the game write path shall first validate a preview carrying an inert placeholder secret ARN, and shall touch Secrets Manager only after that structural pass succeeds. (observed)
- [x] **GAME-WRITE-004**: If the `deployment-config.json` write for a game create or update fails (conflict, not found, setup incomplete or any other error), then the system shall leave the game's app-owned `hyveon-{game}-healthcheck-auth` secret as it was before the request. (observed)
- [x] **GAME-WRITE-005**: If a Secrets Manager upsert fails during a game create or update, then the game write path shall return a modeled `GameWriteResult` failure rather than reject. (observed)
- [x] **GAME-WRITE-006**: If the sibling read of `deployment-config.json` fails at the start of a game create or update, then the game write path shall fail the request rather than validate cross-game rules against an empty list. (observed)
- [x] **GAME-WRITE-007**: When a game delete is submitted, the game write path shall remove the entry without validation and only afterwards delete an app-owned health-check secret, logging and swallowing a secret-delete failure. (observed)
- [x] **GAME-WRITE-008**: Where a game write payload carries `expectedVersionId` and the stored `deployment-config.json` has a different version, the game write path shall return a `conflict` result carrying both version identifiers. (observed) Note: no games write in `@hyveon/web` sends `expectedVersionId`, so UI game writes are last-writer-wins.
- [x] **GAME-WRITE-009**: When a game create's config write throws `GameServerEntryError` with reason `invalid-name` or `duplicate-name`, the game write path shall return a `validation` result at path `name`. (observed)
- [x] **GAME-WRITE-010**: When a game update or delete's config write throws `GameServerEntryError`, the game write path shall return `not_found` only when the game is missing and a distinct failure for a structurally broken `gameServers` map. (observed)
- [x] **GAME-WRITE-011**: If any game write finds no configuration bucket configured, then the game write path shall return `setup_incomplete`, and for any other unexpected config-write error it shall return `error` with a generic message. (observed)
- [x] **GAME-WRITE-012**: When the game write path logs an unexpected config-write error, it shall log the normalised error message, not the raw error object. (observed; `.claude/rules/logging.md`)
- [x] **GAME-WRITE-013**: When a game create, update or delete succeeds, the system shall invalidate the deployment-config and stack-outputs caches, record an audit entry with the redacted before/after game and `versionId`, and return the redacted game (omitted for delete) with a freshly merged games list. (observed)

## IPC Surface and Games Pages

- [x] **GAME-IPC-001**: The desktop main process shall expose the game surface over IPC only, as `games.list`, `games.create`, `games.update`, `games.delete`, `games.draft.get`, `games.draft.save`, `games.draft.updateStepIndex` and `games.draft.clear`, with `games.status`, `games.getStatus`, `games.start` and `games.stop` delegated to `EcsService`. (observed)
- [x] **GAME-IPC-002**: Each game IPC handler shall log a debug line on entry naming the channel and only non-secret identifiers such as the game name. (observed; `.claude/rules/logging.md`)
- [x] **GAME-IPC-003**: The `games.create`, `games.update` and `games.delete` handlers shall return the `GameWriteResult` union verbatim rather than throw, because IPC serialisation strips custom error properties. (observed; see GAME-WRITE-005 for the one path that still rejects)
- [x] **GAME-IPC-004**: When `games.list` is called, the system shall invalidate only the deployment-config cache, read declared games and stack outputs in parallel, compute drift locally, and leave the stack-outputs cache to be invalidated by writes and applies. (observed)
- [x] **GAME-IPC-005**: The preload bridge's renderer-facing `GameServer` and `GameWizardDraft` types shall carry every field of the `@hyveon/shared` model, including `webPort` and `command`. (observed)
- [x] **GAME-IPC-006**: The games page shall render every merged games-list entry with a status chip of "In sync", "Config drift", "Pending deploy" or "Undeclared" derived from `declared`, `deployed` and drift. (observed)
- [x] **GAME-IPC-007**: If the games list cannot be loaded, then the add-game wizard and the game detail page shall surface the failure rather than treat it as an empty list. (observed)
- [x] **GAME-IPC-008**: When the operator removes a declared game, the system shall require typing the exact game name to enable the confirm action, state that AWS resources stay live until the next plan/apply, and on success navigate back to the games list. (observed)
- [x] **GAME-IPC-009**: If an upload into a game's volumes is in progress (`HelperSessionRegistry.hasUploadHolders`), then the `games.start` handler shall return `success: false` with a message naming the game and telling the operator to wait for or cancel the upload, without calling `EcsService.start`. (observed: `games.controller.ts:102-110`)
- [x] **GAME-IPC-010**: While the game detail page has resolved its games-list entry, it shall show a Files link to that game's file-browser route `/games/{name}/files` beside the polling indicator. (observed: `game-detail.page.tsx:140-148`)

## Add-Game Wizard Flow

- [x] **GAME-WIZ-001**: The add-game wizard shall present the six steps of `ADD_GAME_WIZARD_STEPS` in order: identity, resources, networking, storage, environment, review. (observed)
- [x] **GAME-WIZ-002**: While the current add-game wizard step has validation issues for its own fields, the wizard shall disable advancing; the review step and the edit-game form shall gate on the whole-draft issue list. (observed)
- [x] **GAME-WIZ-003**: When the add-game wizard opens, it shall refresh the list of declared games for cross-game name and port checks. (observed)
- [x] **GAME-WIZ-004**: When a game create returns `validation`, the add-game wizard shall show the server's issues in place of live ones until the next edit; when it returns any other failure, the wizard shall show the message on the review step. (observed)
- [x] **GAME-WIZ-005**: When a game create returns `validation` issues spanning several steps, the add-game wizard shall direct the operator to every affected step, not only the first issue's step. (observed)
- [x] **GAME-WIZ-006**: When a game create succeeds, the add-game wizard shall clear the saved draft, wait for the clear to land, close, and navigate to the new game's page. (observed)

## Draft Persistence

- [x] **GAME-DRAFT-001**: While the operator edits the add-game wizard, the system shall persist the current draft and step index to durable storage about 1 second after edits settle, with no explicit save action.
- [x] **GAME-DRAFT-002**: While no field of the add-game wizard has been edited and no stored draft is being resumed, the system shall write no draft.
- [x] **GAME-DRAFT-003**: While the add-game wizard is submitting, the system shall suppress debounced draft saves, re-checking the submitting state when the debounced save fires.
- [x] **GAME-DRAFT-004**: When the add-game wizard dialog closes or the wizard unmounts, the system shall immediately write any pending draft change, bypassing the debounce.
- [x] **GAME-DRAFT-005**: The system shall store the add-game wizard draft in the desktop main process's electron-store `addGameWizardDraft` slot so it survives quitting and relaunching the app.
- [x] **GAME-DRAFT-006**: When the games page loads and a saved add-game draft exists, it shall show a banner with Resume and Discard actions without opening the wizard; when none exists, it shall show no banner.
- [x] **GAME-DRAFT-007**: When the operator clicks Resume on the add-game draft banner, the system shall open the wizard with the saved field values and step index, and after that wizard closes the games page shall re-fetch the draft rather than reuse its mount-time copy.
- [x] **GAME-DRAFT-008**: When the operator clicks Discard on the add-game draft banner, the system shall delete the saved draft, hide the banner and not open the wizard, and if the delete fails it shall tell the operator.
- [x] **GAME-DRAFT-009**: When the add-game wizard creates a game successfully, the system shall delete the saved draft so the banner no longer appears.
- [x] **GAME-DRAFT-010**: If the saved add-game draft is missing, malformed or unreadable, then the system shall treat it as no draft, log a warning, and let the games page load with no banner and no error.
- [x] **GAME-DRAFT-011**: When the add-game draft is read for the renderer, the system shall blank environment values, file-seed contents and health-check credentials, and shall backfill fields added since the draft was saved (legacy `webPort`, port `visibility`, health check, `command`). (observed)
- [x] **GAME-DRAFT-012**: While a resumed add-game draft has had no field edit, the system shall persist step-only navigation through `games.draft.updateStepIndex`, which rewrites only the stored step index and never the redacted fields. (observed)
- [x] **GAME-DRAFT-013**: If a draft save, step-index update or clear fails in the main process, then the system shall log a warning and not interrupt the wizard. (observed)
