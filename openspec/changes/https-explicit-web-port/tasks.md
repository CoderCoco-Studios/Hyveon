## 1. PR 1 — shared type, validator, normaliser

- [x] 1.1 Add `webPort?: number` to `GameServerConfig` with TSDoc, and mark the implicit `ports[0]`-is-upstream interpretation deprecated in the `ports`/`https` field docs; update `connect_message`/`https` docs in `gameServerConfig.ts`
- [x] 1.2 Add `shared/src/gameServerPorts.ts` (pure, no AWS imports): `normalizeGameServer` (TSDoc `@deprecated` + comment marking the legacy `ports[0]`-as-upstream shape and its removal condition), helper listing a game's ingress-eligible ports, web-port reserved-port check
- [x] 1.3 Update `gameServerValidator.ts`: `webPort` rules, drop non-empty/`ports[0]`-tcp rules, collisions include `webPort`, `healthCheck.port` accepts `webPort` or tcp extra
- [x] 1.4 Apply `normalizeGameServer` in `DeploymentConfigService` read paths and `GameWizardDraftService` backfill; diff `DriftService` on normalised shape
- [x] 1.5 Update diagnostics allowlist, `ElectronStoreService` draft type, shared unit tests with legacy fixtures
- [x] 1.6 Run `app:lint`, `app:typecheck`, `app:test`, `app:test:integration`

## 2. PR 2 — infra and lambdas (stacked on PR 1)

- [ ] 2.1 `ecs.ts`: Caddy `--to localhost:<webPort>`; port mappings for `webPort` + extras
- [ ] 2.2 `securityGroups.ts`: ingress for https extras honoring `visibility`; none for `webPort`; health-check ingress follows target
- [ ] 2.3 `lambdas.ts` `firstPortByGame` / `shared/src/formatStatus.ts`: https games render the 443 URL
- [ ] 2.4 Update infra fixtures (`delta`) and tests (`ecs`, `securityGroups`, `efs`, lambdas)
- [ ] 2.5 Run `app:lint`, `app:typecheck`, `app:test`, `app:test:integration`

## 3. PR 3 — wizard, docs, specs (stacked on PR 2)

- [ ] 3.1 `networking-step.component.tsx`: dedicated web-port field, optional extras list, updated warning callout; wire through `wizard-form.utils.ts`, add/edit flows, review step, games/game-detail pages
- [ ] 3.2 Update web tests, e2e specs, and `demo-data.ts` (palworld becomes valid https with `webPort` + UDP extras)
- [ ] 3.3 Docs via `write-docs`: `docs/docs/app/games.md`, `components/infra.md`, `architecture.md`, `setup.md`, `guides/user.md`
- [ ] 3.4 Run deployment-config-field-auditor; `/opsx:sync` delta specs; run full gate incl. `app:test:e2e`
