## Why

The desktop preload API, its TypeScript types, the renderer's runtime global, e2e test helpers, and an unrelated Terraform tfvars-bucket marker all carry the name `Gsd`/`gsd`/`GSD` — a leftover from the project's pre-rebrand name. The app and repo are now called Hyveon (see the `project_name` rebrand tracked in #213), but the code, the `window.gsd` bridge, test fixtures, scripts, and docs still say `gsd` in various cases. This is confusing for anyone reading the code fresh: `GsdApi`, `window.gsd`, `.gsd/tfvars-bucket`, and `GSD_TFVARS_BACKEND` don't explain what they are the way `HyveonApi`, `window.hyveon`, `.hyveon/tfvars-bucket`, and `HYVEON_TFVARS_BACKEND` would.

## What Changes

- Rename every `Gsd*` TypeScript interface/type in `@hyveon/desktop-preload` (`GsdApi`, `GsdTestApi`, `GsdMockNamespaces`, `GsdGamesApi`, `GsdCostsApi`, `GsdLogsApi`, `GsdFilesApi`, `GsdDiscordApi`, `GsdEnvApi`, `GsdConfigApi`, `GsdDriftApi`, `GsdDiagnosticsApi`, `GsdAuditApi`, `GsdTerraformRunsApi`, `GsdTerraformApi`, `GsdTerraformRollbackApi`) to their `Hyveon*` equivalents.
- Rename e2e test helper functions and fixtures: `applyGsdMocks()` → `applyHyveonMocks()`, `installGsdHttpBridge()` → `installHyveonHttpBridge()`, and the `gsd-http-bridge.ts`/`gsd-api.ts` filenames.
- **BREAKING**: rename the renderer's runtime IPC bridge global from `window.gsd` to `window.hyveon` — the `contextBridge.exposeInMainWorld('gsd', ...)` call in `preload.ts` becomes `exposeInMainWorld('hyveon', ...)`. Every consumer of `window.gsd` (production `api.service.ts`, all e2e specs/page-objects/fixtures, `globals.d.ts`/`window.d.ts` augmentations, and this repo's `CLAUDE.md` documentation of the `window.gsd.__test.mock()` test seam) moves in the same change so nothing is left calling a global that no longer exists.
- **BREAKING**: rename the unrelated local tfvars-bucket marker directory `.gsd/` to `.hyveon/` and the `GSD_TFVARS_BACKEND` env var to `HYVEON_TFVARS_BACKEND`, used by `setup.sh`, `scripts/tfvars-sync.ts`, `scripts/init-parent.ts`, and `ConfigService.ts`. Anyone with an existing local `.gsd/tfvars-bucket` marker file needs a one-time manual rename (or re-run of the relevant setup step) after pulling this change — see design.md for the migration note.
- Update every doc reference (`docs/docs/setup.md`, `docs/docs/guides/s3-tfvars.md`, `docs/docs/guides/submodule.md`, `docs/docs/guides/project-name-migration.md`, `scripts/README.md`, `CLAUDE.md`) so none of them still say `gsd`/`GSD`/`Gsd`.
- No behavior changes: this is a pure identifier rename. Every renamed function, type, global, directory, and env var keeps its existing signature and semantics — only the name changes.

## Capabilities

### New Capabilities

- `preload-bridge-naming`: the desktop preload IPC bridge's public name — the runtime `window.*` global the renderer talks to, and the TypeScript type names describing it — is `hyveon`/`Hyveon*`, not `gsd`/`Gsd*`. This is the one part of the rename with an externally-observable contract (the renderer must call `window.hyveon`, not `window.gsd`), so it gets a spec even though the underlying IPC behavior is unchanged.

### Modified Capabilities

None — no other spec-level requirements change. Every other renamed file, helper, directory, or env var keeps its current behavior; only its name changes, and none of those areas has an existing `openspec/specs/` capability to delta.

## Impact

- **Code**: `app/packages/desktop-preload/src/*` (gsd-api.ts, index.ts, preload.ts + their `.test.ts` files), `app/packages/web/src/*` (api.service.ts, globals.d.ts, window.d.ts, and every page/component that references `window.gsd` or imports `Gsd*` types), `app/packages/web/e2e/**` (fixtures, page-objects, specs), `app/packages/desktop-main/src/**` (ConfigService.ts, TerraformService.ts, controllers referencing `.gsd/`), `scripts/**` (init-parent.ts + tests, tfvars-sync.ts), `setup.sh`, `electron-builder.yml`.
- **Docs**: `CLAUDE.md`, `docs/docs/setup.md`, `docs/docs/guides/s3-tfvars.md`, `docs/docs/guides/submodule.md`, `docs/docs/guides/project-name-migration.md`, `scripts/README.md`, `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md`.
- **Local developer state**: anyone with an existing `.gsd/tfvars-bucket` marker file on disk needs a one-time manual migration step (documented in design.md) after this change lands — the marker path itself is renamed, it isn't backwards-compatible by default.
- **No AWS infrastructure impact**: this does not touch `terraform/variables.tf`'s `project_name` (already `hyveon` per #213) or any provisioned AWS resource name — it's local repo/dev-workflow naming only.
