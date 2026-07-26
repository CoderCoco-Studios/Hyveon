## 1. `@hyveon/desktop-preload` package

- [ ] 1.1 `git mv app/packages/desktop-preload/src/gsd-api.ts app/packages/desktop-preload/src/hyveon-api.ts` and rename every `Gsd*` interface inside it (`GsdApi` → `HyveonApi`, `GsdTestApi` → `HyveonTestApi`, `GsdMockNamespaces` → `HyveonMockNamespaces`, `GsdGamesApi`, `GsdCostsApi`, `GsdLogsApi`, `GsdFilesApi`, `GsdDiscordApi`, `GsdEnvApi`, `GsdConfigApi`, `GsdDriftApi`, `GsdDiagnosticsApi`, `GsdAuditApi`, `GsdTerraformRunsApi`, `GsdTerraformApi`, `GsdTerraformRollbackApi` → `Hyveon*` equivalents), plus doc comments referencing `GsdApi`/`window.gsd`.
- [ ] 1.2 Update `app/packages/desktop-preload/src/index.ts`: import path to `./hyveon-api.js`, `Gsd*` type imports/re-exports → `Hyveon*`, and the `Window.gsd` global augmentation → `Window.hyveon`.
- [ ] 1.3 Update `app/packages/desktop-preload/src/preload.ts`: `Gsd*` type imports, the `const api: GsdApi` → `HyveonApi` annotation, and `contextBridge.exposeInMainWorld('gsd', gsdBridge)` → `exposeInMainWorld('hyveon', hyveonBridge)` (rename the local `gsdBridge` variable too).
- [ ] 1.4 Update `app/packages/desktop-preload/src/preload.test.ts` for the renamed types/global.
- [ ] 1.5 Update `app/packages/desktop-preload/src/test-mock-registry.ts` and `test-mock-registry.test.ts` for the renamed mock-namespace type and any `gsd`-named identifiers.
- [ ] 1.6 Run `npm run app:build` (or a scoped `tsc --noEmit` for `@hyveon/desktop-preload`) to confirm this package compiles clean before moving to its consumers.

## 2. `@hyveon/web` package

- [ ] 2.1 Update `app/packages/web/src/globals.d.ts` and `app/packages/web/src/window.d.ts`: `window.gsd` → `window.hyveon`, `GsdApi` import → `HyveonApi`, doc comments.
- [ ] 2.2 Update `app/packages/web/src/api.service.ts` and `api.service.test.ts`: every `window.gsd.*` call site → `window.hyveon.*`.
- [ ] 2.3 Update `app/packages/web/src/components/rollback-action.component.tsx` and its `.test.tsx`.
- [ ] 2.4 Update the terraform page family: `terraform.page.tsx`/`.test.tsx`, `terraform-history.page.tsx`/`.test.tsx`, `terraform-run-detail.page.tsx`/`.test.tsx`.
- [ ] 2.5 Update `app/packages/web/src/pages/logs.page.tsx` and `logs.page.test.tsx`.
- [ ] 2.6 Run `npm run app:test` scoped to `@hyveon/web` (or the full suite) to confirm no `window.gsd`/`GsdApi` references remain in production or unit-test code.

## 3. E2E test infrastructure

- [ ] 3.1 `git mv app/packages/web/e2e/fixtures/gsd-http-bridge.ts app/packages/web/e2e/fixtures/hyveon-http-bridge.ts`; rename `installGsdHttpBridge()` → `installHyveonHttpBridge()` inside it.
- [ ] 3.2 Update `app/packages/web/e2e/fixtures/electron-launch.ts`: rename `applyGsdMocks()` → `applyHyveonMocks()` and any `window.gsd` references inside `win.evaluate(...)` calls.
- [ ] 3.3 Update `app/packages/web/e2e/fixtures/electron-mock.ts` and `app/packages/web/e2e/fixtures/index.ts` (import path to `./hyveon-http-bridge.js`, re-exported helper names).
- [ ] 3.4 Update page objects: `app/packages/web/e2e/pages/DashboardPage.ts`, `app/packages/web/e2e/pages/TerraformPage.ts`.
- [ ] 3.5 Update specs calling the renamed helpers: `costs.spec.ts`, `dashboard.spec.ts`, `discord.spec.ts`, `electron-ipc-roundtrip.spec.ts`, `electron-smoke.spec.ts`, `ipc-mock.spec.ts`, `logs.spec.ts`, `terraform.spec.ts`.
- [ ] 3.6 Run `npm run app:test:e2e` (electron + chromium projects) to confirm the renamed fixtures/helpers work end-to-end.

## 4. `@hyveon/desktop-main`, scripts, and local dev tooling

- [ ] 4.1 Update `app/packages/desktop-main/src/services/ConfigService.ts` and `ConfigService.test.ts`: `.gsd/tfvars-bucket` path → `.hyveon/tfvars-bucket`, any `GSD_TFVARS_BACKEND` reference → `HYVEON_TFVARS_BACKEND`.
- [ ] 4.2 Update `app/packages/desktop-main/src/services/TerraformService.ts` and controllers `diagnostics.controller.ts`, `terraform.controller.ts` for any `gsd`-named references.
- [ ] 4.3 Update `scripts/init-parent.ts` (+ `init-parent.test.ts`, `init-parent.cli.test.ts`) and `scripts/tfvars-sync.ts`: `.gsd/` path and `GSD_TFVARS_BACKEND` env var → `.hyveon/` / `HYVEON_TFVARS_BACKEND`.
- [ ] 4.4 Update `setup.sh`: env var name, `.gsd/tfvars-bucket` path, and add the one-time hint described in design.md (if `.gsd/` exists and `.hyveon/` doesn't, print a manual-rename hint before continuing).
- [ ] 4.5 Update `.gitignore`: `.gsd/` entry and its `# GSD bootstrap metadata` comment → `.hyveon/` / `# Hyveon bootstrap metadata`.
- [ ] 4.6 Update `electron-builder.yml`: `appId: dev.gsd.desktop` → `dev.hyveon.desktop` (see design.md's Risks section on `appId` impact for already-packaged installs).
- [ ] 4.7 Run `npm run app:test` (full suite) and `npm run app:lint` to confirm this group compiles, lints, and passes.

## 5. Documentation

- [ ] 5.1 Update `CLAUDE.md`: every `window.gsd`/`Gsd*` reference in the Electron e2e IPC mock seam section and elsewhere.
- [ ] 5.2 Update `docs/docs/setup.md`, `docs/docs/guides/s3-tfvars.md`, `docs/docs/guides/submodule.md`, `docs/docs/guides/project-name-migration.md` for `.gsd/`/`GSD_TFVARS_BACKEND`/`gsd` references.
- [ ] 5.3 Update `scripts/README.md`.
- [ ] 5.4 Leave `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md` untouched — it's a dated historical design record (see design.md Context/Open Questions); do not rename its `gsd` references.

## 6. Final verification

- [ ] 6.1 Run a repo-wide case-insensitive `gsd` grep excluding `node_modules`, `.git`, build output dirs, `package-lock.json`, `docs/package-lock.json` (false-positive hash substrings), and `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md` (intentionally-excluded historical doc) — confirm zero remaining hits.
- [ ] 6.2 Run `npm run app:build`, `npm run app:lint`, `npm run app:test`, and `npm run app:test:e2e` (both projects) end to end; confirm all green.
- [ ] 6.3 Manually smoke-test the packaged/dev Electron app once (`npm run app:dev`) and confirm `window.hyveon` is populated in the renderer devtools console, with `window.gsd` undefined.
