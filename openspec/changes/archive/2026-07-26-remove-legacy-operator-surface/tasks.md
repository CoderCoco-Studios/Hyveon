# Tasks: remove-legacy-operator-surface

> **Scope note (2026-07-26):** the operator requested this land as a single PR
> instead of the two-PR split originally planned below (see design.md D5).
> Verification also surfaced that `scripts/init-parent.ts` (the private
> parent-repo submodule scaffolder) fully depends on the root `setup.sh` and
> root `Makefile` being deleted here — the operator chose a full rework of
> that scaffolder over deprecating it or keeping the legacy files. §2 and §3
> below collapse into one branch/PR; §2.5 (new) covers the scaffolder rework.

## 1. Verify baseline (pre-work, no code changes)

- [x] 1.1 Confirm CI is green on `main` (`test.yml`, `e2e.yml`, `integration.yml`, `lint.yml`) so any later failure is attributable to this change
- [x] 1.2 Re-verify no integration spec imports a `*-http.controller` module: `grep -rn "HttpController\|-http.controller" app/packages/web/e2e/integration-specs/` returns only the doc comment in `error-propagation.spec.ts`
- [x] 1.3 Confirm `app/packages/desktop-main/src/generated/` is empty and untracked (`git ls-files app/packages/desktop-main/src/generated/` is empty) — the #164 tfstate stub is already gone; remove the empty local directory

## 2. Single PR — delete HTTP shims, Docker story, and refresh docs (branch `claude/issue-293-remove-legacy-operator-surface`)

- [x] 2.1 Create worktree: `git worktree add .worktrees/claude/issue-293-remove-legacy-operator-surface -b claude/issue-293-remove-legacy-operator-surface`
- [x] 2.2 Delete all nine `*-http.controller.ts` files and their `*-http.controller.test.ts` siblings in `app/packages/desktop-main/src/controllers/` (`audit`, `config`, `costs`, `diagnostics`, `discord`, `drift`, `env`, `files`, `games`)
- [x] 2.3 Remove the nine `*HttpController` imports and `controllers` array entries from `app/packages/desktop-main/src/app.module.ts`
- [x] 2.4 Strip `api_token` plumbing from `app/packages/desktop-main/src/services/ConfigService.ts`: the `API_TOKEN` env accessor, the `api_token` field parsing from `server_config.json`, and the token-resolution method; keep the watchdog-tunable read/write paths intact
- [x] 2.5 Update `ConfigService.test.ts` — delete api_token cases, keep watchdog-config coverage; confirm the watchdog writer does not re-persist a stale `api_token` field from an existing file
- [x] 2.6 Remove `@nestjs/platform-express`, `express`, and `@types/express` from `app/packages/desktop-main/package.json`; run `npm install` to refresh the lockfile; if the build reveals a hard Nest peer requirement, restore the dep with an explanatory comment (design D4)
- [x] 2.7 Sweep desktop-main for stragglers: `grep -rn "HttpController\|platform-express\|api_token\|API_TOKEN" app/packages/desktop-main/src/` returns nothing (update the doc comment in `games.controller.ts`/`error-propagation.spec.ts` that references the deleted shim)
- [x] 2.8 Delete `Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, `setup.ps1` from the repo root
- [x] 2.9 Refresh `CLAUDE.md`: remove the Docker run block and `./setup.sh` bootstrap from Common Commands, delete the entire "API authentication" section (describes the removed `ApiTokenGuard` as current), and update the architecture summary to the Electron/IPC reality (design D6)
- [x] 2.10 Update `README.md`: remove the `setup.sh` quick-start step, the "run in Docker" option, and the `Dockerfile`/`docker-compose.yml`/`setup.sh` entries in the repo-layout tree
- [x] 2.11 Rewrite `docs/docs/setup.md`: drop the Docker prerequisite row, the `setup.sh`/`setup.ps1` bootstrap steps, and API-token configuration; describe the desktop-app-driven setup instead
- [x] 2.12 Rewrite `docs/docs/architecture.md`: present the Electron desktop app driving desktop-main over IPC as the control plane (currently describes the Nest HTTP API + browser dashboard)
- [x] 2.13 Sweep remaining docs (`docs/docs/intro.md`, `docs/docs/components/management-app.md`, `docs/docs/components/terraform.md`, `docs/docs/guides/*.md` other than `submodule.md`) for Docker/`setup.sh`/`Makefile`/bearer-token instructions
- [x] 2.14 **NEW** — Rework `scripts/init-parent.ts` so its generated wrapper Makefile is fully self-contained (no `bash .../setup.sh`, no `make -C <submodule>` delegation to the deleted root Makefile, no `.env`/`API_TOKEN`): inline the `setup.sh` bootstrap logic (S3 state bucket + DynamoDB lock table + tfvars-S3-backend bootstrap via the untouched `terraform/bootstrap` module) directly into the `setup` target's recipe; replace `plan`/`apply`/`dev`'s delegation to the root Makefile with direct `terraform -chdir=$(TF_DIR)`/`npm run app:*` calls; drop the sha256-of-setup.sh drift-detection stamp (replaced with an unconditional `terraform init` on `update`); delete `renderEnv()` and the `apiToken` prompt/field. Update `scripts/init-parent.test.ts`, `scripts/init-parent.cli.test.ts`, `scripts/README.md`, and rewrite `docs/docs/guides/submodule.md` to match.
- [x] 2.15 Exit-criterion grep across `CLAUDE.md`, `README.md`, `docs/`, `scripts/`: no remaining *instruction* referencing `docker compose`, `Dockerfile`, `setup.sh`, `setup.ps1`, root `Makefile`, `api_token`, or `ApiTokenGuard` (historical/changelog mentions and the still-valid *parent-repo wrapper* Makefile references are acceptable)
- [x] 2.16 Gate: `npm run app:build` compiles clean
- [x] 2.17 Gate: `npm run app:lint` passes
- [x] 2.18 Gate: `npm run app:test` passes (1992/1992)
- [x] 2.19 Gate: `npm run app:test:e2e` passes — both projects (83/83); the five chromium specs (`audit`, `games`, `pending-changes-banner`, `polling`, `settings`) pass unchanged, proving the retention decision (design D2)
- [x] 2.20 Gate: `npm run app:test:integration` passes (23/23, 1 skipped)
- [x] 2.21 Gate: `scripts/` workspace tests pass — `init-parent.test.ts` and `tfvars-sync.test.ts` pass; `init-parent.cli.test.ts` has 5 pre-existing failures confirmed present on `main` before this change (unrelated to this rework — not fixed, out of scope)
- [x] 2.22 Gate: docs site builds clean (`cd docs && npm run build`) — fixed one broken anchor link surfaced by the `setup.md` heading rewrite
- [x] 2.23 Open PR via `/pr`: title `refactor: remove legacy operator surface (HTTP shims, Docker, docs, submodule scaffolder)`, body first line `Closes #293` — landed as PR #336
- [x] 2.24 Work Copilot review per repo conventions; merge PR — PR #336 merged (`a9772e7`), CodeRabbit review threads fixed/resolved

## 3. Issue closeout

- [x] 3.1 Perform the one-time AWS-side orphan audit from #293 (list account resources by `Project` tag + untagged-in-region, cross-check against `terraform state list`, delete pre-pivot orphans) — operator console/CLI activity, no repo change
- [x] 3.2 Tick the completed checklist items on #293 and note the scope deltas: nine shim pairs deleted (not seven), `server_config.json` retained for watchdog tunables (only `api_token` stripped), and `scripts/init-parent.ts` fully reworked (not just doc-updated) to stay self-contained after the root Makefile/setup.sh deletion

All tasks complete. Ready to archive this OpenSpec change.
