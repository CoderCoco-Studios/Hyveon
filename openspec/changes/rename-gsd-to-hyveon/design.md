## Context

`Gsd`/`gsd`/`GSD` appears across ~50 files in three unrelated tiers:

1. **The desktop-preload IPC surface** — `GsdApi`, `GsdTestApi`, `GsdMockNamespaces`, and eleven per-domain `Gsd*Api` interfaces in `app/packages/desktop-preload/src/gsd-api.ts`, exposed at runtime via `contextBridge.exposeInMainWorld('gsd', ...)` in `preload.ts` and consumed everywhere as `window.gsd`.
2. **Test infrastructure** — `applyGsdMocks()`, `installGsdHttpBridge()`, and the `gsd-http-bridge.ts`/`gsd-api.ts` filenames in the e2e fixtures/specs/page-objects.
3. **An unrelated local dev-tooling marker** — `.gsd/tfvars-bucket` (a gitignored local marker file) and the `GSD_TFVARS_BACKEND` env var, used by `setup.sh`, `scripts/tfvars-sync.ts`, `scripts/init-parent.ts`, and `ConfigService.ts` to track the S3 tfvars-backend bootstrap state. This has no relationship to the preload API — it predates it — but carries the same stale name.

The repo already completed a `project_name` rebrand to `hyveon` for AWS-provisioned resources (#213, see `docs/docs/guides/project-name-migration.md`). This change is the same rebrand applied to the parts of the codebase Terraform doesn't touch.

Two matches found during research are **not** real occurrences and must not be touched:

- `package-lock.json` / `docs/package-lock.json`: `gsd` appears only as a substring inside base64 `integrity` hashes (e.g. `...CGsdzS7d...`) — coincidental, not the acronym.
- `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md`: a dated, already-implemented architecture design doc. It documents what was decided on 2026-05-10 under the name in effect at the time.

## Goals / Non-Goals

**Goals:**
- Every live identifier, runtime global, filename, directory, env var, and doc reference that means "Gsd"/"gsd"/"GSD" reads as "Hyveon"/"hyveon"/"HYVEON" instead, with zero behavior change.
- The workspace builds, lints, and passes its full test suite (unit, e2e electron, e2e chromium, integration) after the rename, with no `Gsd`/`gsd`/`GSD` residue outside the two excluded cases above.
- Git history is preserved for renamed files (`git mv`, not delete+recreate).

**Non-Goals:**
- Not touching AWS-provisioned resource names or `terraform/variables.tf`'s `project_name` — that rebrand is already done (#213) and out of scope here.
- Not rewriting the dated historical design doc (`docs/superpowers/specs/2026-05-10-*`) — it's a historical record, not live documentation.
- Not adding a backwards-compatibility shim for the renamed `window.gsd` global or `.gsd/` marker path — per repo convention, this is a clean rename, not a versioned migration.

## Decisions

**Case-tier mapping.** Apply three parallel substitutions, chosen by the casing already in use at each site — never mix tiers:
- `Gsd` → `Hyveon` (PascalCase: interface/type names like `GsdApi`)
- `gsd` → `hyveon` (camelCase/lowercase: `window.gsd`, `applyGsdMocks`, `.gsd/`, filenames)
- `GSD` → `HYVEON` (all-caps: `GSD_TFVARS_BACKEND`, the `# GSD bootstrap metadata` comment in `.gitignore`)

**Sequencing follows the npm workspace dependency order**, so each stage leaves a compilable state and TypeScript errors surface immediately at their source rather than cascading:
1. `@hyveon/desktop-preload` (`gsd-api.ts` → `hyveon-api.ts` via `git mv`, then `index.ts`, `preload.ts`, their `.test.ts` files)
2. `@hyveon/web` (`api.service.ts`, `globals.d.ts`, `window.d.ts`, every component/page importing `Gsd*` types or reading `window.gsd`)
3. `app/packages/web/e2e/**` (fixtures, page-objects, specs — including the `gsd-http-bridge.ts` → `hyveon-http-bridge.ts` file rename)
4. `@hyveon/desktop-main` (`ConfigService.ts`, `TerraformService.ts`, controllers referencing `.gsd/`) + `scripts/**` + `setup.sh` + `.gitignore` + `electron-builder.yml`
5. Docs (`CLAUDE.md`, `docs/docs/**` except the historical design doc, `scripts/README.md`)
6. Final repo-wide verification grep to confirm zero residual matches outside the two excluded files.

**`window.gsd` → `window.hyveon` lands as one atomic change**, not a dual-exposed transition period. This is an internal renderer↔main IPC bridge shipped as a single Electron app version — there's no external consumer or older-client compatibility concern the way there would be for a public API, so exposing both names temporarily would just be dead code.

**`.gsd/tfvars-bucket` gets a clean rename, not a fallback read path.** Per repo convention (no compatibility shims for internal tooling), `ConfigService`/`tfvars-sync.ts` will only look for `.hyveon/tfvars-bucket` after this change. Developers with an existing local `.gsd/tfvars-bucket` marker need a one-time manual `mv .gsd .hyveon`. `setup.sh` gets a short one-time check: if `.gsd/` exists and `.hyveon/` doesn't, print a hint to rename it manually before continuing (a warning, not an automatic migration, so we don't silently move files a developer might not expect touched).

**`electron-builder.yml`'s `appId: dev.gsd.desktop` → `dev.hyveon.desktop` is included**, per explicit scope confirmation, but is called out separately in Risks below — it's the one change in this set with a real (if small) external-facing consequence rather than being purely cosmetic.

## Risks / Trade-offs

- **[Risk]** Changing `appId` affects OS-level app identity for anyone with an already-packaged install (macOS keychain-linked entries, Windows uninstall registry keys are keyed by `appId`) → **Mitigation**: this app has no broad external distribution yet (internal/early-stage per CLAUDE.md); no auto-migration is provided, but this is worth a one-line release note if/when a build goes out to existing testers.
- **[Risk]** A case-tier mismatch (e.g. a mid-word match like `desktopGsdBridge` needing `Hyveon` even though it's not a standalone identifier) causes a partial rename that still compiles but reads inconsistently → **Mitigation**: tasks.md's final step is a repo-wide case-insensitive `gsd` grep (excluding the two known-excluded files) that must return zero hits before the change is considered done.
- **[Risk]** `.gsd/tfvars-bucket` silently "disappears" for an existing developer, making `tfvars-sync.ts` behave as if no backend has been bootstrapped yet → **Mitigation**: `setup.sh`'s new one-time hint (see Decisions) surfaces this before it causes confusing downstream errors.
- **[Trade-off]** Doing this as one larger PR (vs. one PR per workspace) means a bigger diff to review, but avoids an intermediate state where `@hyveon/web` still imports `Gsd*` types from a `@hyveon/desktop-preload` that has already renamed them — splitting by workspace would break the build between PRs.

## Migration Plan

Single PR with sequenced, working-tree-clean commits following the order in Decisions. No deploy-time migration: this is dev-tooling and desktop-app source, not provisioned infrastructure. Rollback is a plain revert of the PR; the only irreversible-feeling artifact is a developer's local `.gsd/` → `.hyveon/` manual rename, which is trivially reversible (`mv .hyveon .gsd`) if the PR is reverted.

## Open Questions

- Confirmed with the user: the historical design doc (`docs/superpowers/specs/2026-05-10-*`) is left untouched as a historical record — flagged explicitly in tasks.md so it isn't mistaken for a missed occurrence during the final verification grep.
- `electron-builder.yml` appId change is in scope per explicit user confirmation (all four scope tiers selected, including "remove all GSD references") — no further sign-off is being sought here, but it's called out above so it isn't buried in an otherwise-cosmetic diff.
