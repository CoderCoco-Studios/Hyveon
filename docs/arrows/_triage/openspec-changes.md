# OpenSpec In-Flight Change Disposition

Triage of every in-flight change under `openspec/changes/` (archive excluded) against the code on `main` at `84c1fe0a` and the LID arrow under `docs/intent/`, as input to retiring `openspec/`.
Task status was verified against code, not taken from `tasks.md` checkboxes.
Drafted EARS lines are proposals for the owning LLD's specs file; they are not yet in the arrow and need the usual inspection before they land.

Dispositions:

- **(1) Archive** — built; nothing left to build under this change beyond rationale to carry. A built change may still have shipped defects; those are tracked by open LID IDs, not by keeping the change in flight.
- **(2) Partly built** — remaining work named, with the LID IDs that carry it.
- **(3) Migrate** — not started; target LLD and drafted EARS given.
- **(4) Drop** — superseded or obsolete.

## Summary

| Change | Disposition | Tasks verified in code | LID home | Owner decision needed |
|---|---|---|---|---|
| `add-pluggable-health-checks` | (1) Archive — shipped with known defects; needs `--skip-specs` | 27/29 clean; 2 shipped broken (3.1/5.4, 5.7) | `game-runtime/health-check` (RT-HEALTH-*), `game-runtime/watchdog`, `iac/program` | — (defects already open as RT-HEALTH-PROV-003/004/005, IAC-PROGRAM-LAMBDA-011/012) |
| `add-healthcheck-auth-type` | (1) Archive (default archive works) | 27/27 | `game-runtime/health-check` (RT-HEALTH-AUTH/CRED/REDACT), `game-server` (GAME-WRITE/DRAFT) | — |
| `add-scripted-health-checks` | (3) Migrate | 0/28 | `game-runtime/health-check` + one line each in `game-server`, `iac/program` | `secret` binding shape for `basic`/`bearer`; `[ ]` vs `[D]` |
| `add-icmp-ingress` | (1) Archive; needs `--skip-specs` | 16/17; 5.3 `[~]` is a manual `pulumi preview` | `game-server` (GAME-PORT-009..015), `iac/program` | — |
| `https-explicit-web-port` | (1) Archive; needs `--skip-specs` | 15/15 | `game-server` (GAME-HTTPS-004..017), `iac/program` | Release that removes the `normalizeGameServer` shim |
| `add-pinned-hostname` | (2) Partly built — manual verification only | 20/22; 5.3, 5.4 manual | `game-server` (GAME-HOST-001..016), `iac/program` (IAC-PROGRAM-HOST-001..008) | D9 (no drift field) vs CONFIG-DRIFT-008; run 5.4 live check |
| `add-vpc-flow-logs` | (3) Migrate (candidate `[D]`) | 0/22 | `iac/program`, `deployment-config`, `operator-app/infra-logs` | `[ ]` vs `[D]`; collapse `LogsService` resolver pairs first (infra-logs Q16) |
| `add-release-automation` | (1) Archive; needs `--skip-specs` | 18/18 code tasks; 7 of 8 unchecked operational tasks evidenced live; 5.4 unverified | `operator-app/app-update-and-release` (APP-UPDATE-REL/BUMP/NOTES/DRAFT) | Record or drop task 5.4 (forced AI-failure run) |
| `add-update-feed-fallback` | (1) Archive (default archive works) | 6/6 | `operator-app/app-update-and-release` (APP-UPDATE-FALL-001..006, UI-008/009) | — |
| `add-user-initiated-update-install` | (1) Archive (default archive works; widens main only) | 11/11 | `operator-app/app-update-and-release` (APP-UPDATE-DL-*, IPC-004..008, UI-005..009) | — |

## Cross-cutting findings

1. **Nothing to drop; little to build.** 7 of 10 changes are built and can be archived (four need `--skip-specs`, see item 2). Only `add-scripted-health-checks` and `add-vpc-flow-logs` need new EARS, and both are candidates for `[D]`. `add-pinned-hostname`'s remaining work is two manual checks plus a runbook.
2. **Default archive works for some changes and needs `--skip-specs` for the rest; none can lose data.** Behaviour of `openspec archive <change> --yes` (CLI 1.7.0), run against a scratch copy of `openspec/` for every in-flight change:
   - **Archives cleanly with the default flags:** `add-healthcheck-auth-type` and `add-update-feed-fallback` ("Specs already in sync; no files changed"); `add-user-initiated-update-install` (+1 added, ~1 modified; its MODIFIED delta only widens `auto-update-scaffold/spec.md:160-172`).
   - **Default archive aborts, so pass `--skip-specs`:** `add-pluggable-health-checks`, `add-icmp-ingress` and `add-release-automation` (each ADDED requirement already exists in main); `https-explicit-web-port` (its RENAMED FROM header is gone from main, which already carries the renamed requirement at `game-port-visibility/spec.md:50` and the ADDs at `game-https-configuration/spec.md:137,161`, and its MODIFIED "Internal ports" block omits a scenario main has at `game-port-visibility/spec.md:33`).
   - **Default archive would create or extend main specs for work that is not built or is already in LID:** `add-pinned-hostname` (new `game-hostname-pinning`, +5), `add-scripted-health-checks` (new `scripted-health-checks`, +6; ~2 modified in `game-health-checks`), `add-vpc-flow-logs` (new `vpc-flow-logs`, +7). Pass `--skip-specs` for these too, since `openspec/` is being retired.
   - Every aborting path ends "Aborted. No files were changed."; a successful archive only moves the change directory. Deleting the directories is equally safe. The one regression route is the agent-driven `/opsx:sync`, whose procedure treats an ADDED requirement that already exists as an update to match (`.claude/skills/openspec-sync-specs/SKILL.md:99`) and would overwrite hand-merged or newer main text for `add-pluggable-health-checks`, `add-icmp-ingress`, `add-release-automation` and `https-explicit-web-port`.
3. **LID cites `openspec/` paths, which break on deletion.** Outside `_map-codebase/` and this file, `docs/intent/` and `docs/arrows/` carry about 240 `openspec/...` path citations across 37 files — 33 into `openspec/changes/archive/`, 45 into the 10 in-flight change dirs — plus 756 `(OpenSpec: <capability> / <Requirement>)` provenance tags on EARS lines in the `*-specs.md` files (785 lines in those files mention OpenSpec at all). Before deleting `openspec/`, each "see `<change>/design.md` Dn" citation must be inlined as self-contained rationale in the owning LLD's Decisions & Alternatives table (the per-change "Content at risk" lists below name each one). The provenance tags and "Dropped from OpenSpec" sections can stay as plain historical labels or be stripped in one mechanical pass — owner decision.
   - **Second citation form, invisible to a grep for `openspec/`.** Many citations name the change directory with no `openspec/changes/` prefix. Find them with `grep -rnE "(^|[^/a-zA-Z0-9-])[a-z0-9]+(-[a-z0-9]+)+/(design|proposal|tasks|plan|brainstorm|verify|retro|retrospective)\.md" docs/intent docs/arrows --exclude-dir=_map-codebase --exclude-dir=_triage | grep -v "openspec/"`: 82 matches on 77 lines across 15 files, 34 of them into the 10 in-flight changes. All are inside `*-design.md` files except 3 `*-specs.md` hits.
   - **In-flight bare cites by file** (the per-change "Content at risk" lists name only some of these): `game-runtime/game-runtime-design.md:165,171,173` (`add-pluggable-health-checks/design.md`); `game-runtime/health-check/health-check-design.md:149-153,157-161,168-169` (12 bare cites; with the prefixed ones the file cites `add-pluggable-health-checks/design.md` 9 times and `add-healthcheck-auth-type/design.md` 8 times); `game-runtime/watchdog/watchdog-design.md:142`; `game-server/game-server-design.md:137,152-154,166` (`https-explicit-web-port`, `add-icmp-ingress`, `add-pinned-hostname`); `operator-app/app-update-and-release/app-update-and-release-design.md:118-142` (13 cites into `add-release-automation`, `add-user-initiated-update-install` and `add-update-feed-fallback`).
   - The other 48 matches cite archived or unrelated change names (`iac/run/run-design.md`, `wizard-and-bootstrap-design.md`, `program-design.md`, `diagnostics-design.md` and others) and need the same inlining.
4. **Stale change paths already dangle in LID.** `openspec/changes/remove-cost-explorer-calls`, `embed-file-browser` and `add-diagnostics-export` are cited as active but live under `archive/` (`task-and-dns-design.md:164`, `diagnostics-design.md:224,235`, `operator-app-design.md:285`). `diagnostics-design.md:235` also lists `add-pinned-hostname` as an active change touching that leaf.
5. **Line citations in the LLDs have drifted** since the `@spec` annotation PRs (#706/#707): e.g. `health-check-design.md` cites `lambdas.ts:552` (now `:568`) and `handler.ts:39` (now `:40`); `app-update-and-release-design.md` cites `downloadUpdateNow` at `updater.ts:189` (now `:197`) and install at `:242-256` (now `:251`). Refresh them in the same pass as item 3.
6. **Owner decisions collected** (also in the Summary table): `secret` binding shape for scripted checks; `[ ]` vs `[D]` for scripted checks and flow logs; `LogsService` resolver collapse before flow logs; D9 vs CONFIG-DRIFT-008 for `pinnedHostname` drift; release that removes `normalizeGameServer`; run or drop release task 5.4; keep or strip OpenSpec provenance tags.

## Per-change detail

### `add-pluggable-health-checks` — (1) Archive — shipped with known defects

**Spec state.** All 8 delta requirements are already in `openspec/specs/game-health-checks/spec.md:12-319` (commit `cdd0cb8c`), and that main spec has since been rewritten by `add-healthcheck-auth-type`; re-applying this delta by hand would regress it.
A default `openspec archive` aborts on the first ADDED requirement that already exists and changes no file, so archive with `--skip-specs`; the order relative to `add-healthcheck-auth-type` then does not matter.
The `lambda-runtime-currency` delta is synced (`openspec/specs/lambda-runtime-currency/spec.md:22`) and carried in LID as IAC-PROGRAM-RUNTIME-001/002/005 `[x]`, -003 `[ ]`.
No archived change covers the same intent (`2026-08-11-aws-cloud-health-checks` is the unrelated AWS-account Cloud Health checklist).

**Built.**
Types `shared/src/gameServerConfig.ts:117,172-174,308`; schema `gameServerValidator.ts:249,309`; `checkHealthCheckRules` `:999` (called `:1086`); package `lambda/health-check/src/{engine,handler}.ts` with tests, listed in `build:lambdas` (`app/package.json:8`); watchdog routing `watchdog/src/handler.ts:50,133,241-246`; infra `infra/src/iam.ts:244,391,608`, `securityGroups.ts:292-317`, `lambdas.ts:343,552-571,595-596`; zero-footprint tests `lambdas.test.ts:794-855`; wizard `health-check-fields.component.tsx`; docs `docs/docs/components/lambdas.md:14,182-201`, `infra.md:151-164`.

**Shipped broken (already open in LID — no new IDs).**

- Tasks 3.1/5.4: `handler.ts:40` reads `ECS_CLUSTER` at module load, but infra sets only `AWS_REGION_` (`lambdas.ts:568`), so the function cannot start. Carried by RT-HEALTH-PROV-003 and IAC-PROGRAM-LAMBDA-011. RT-HEALTH-PROV-005 covers the test that masks it: `handler.test.ts:18` sets `ECS_CLUSTER` before importing the handler.
- Task 5.7: the test passes but its premise is false — the function sits in public subnets with no NAT or VPC endpoints and its security group allows egress only to game ports, so it cannot reach ECS or Secrets Manager. Carried by RT-HEALTH-PROV-004, IAC-PROGRAM-LAMBDA-012 and the `iac/program` arrow `next`.
- Other open gaps that finish this change: RT-HEALTH-HTTP-005, RT-HEALTH-REDACT-004, RT-WATCHDOG-HC-006.
- Task 1.5 deviation (harmless): `gamesWithHealthChecks` lives in `infra/src/iam.ts:244`, not `@hyveon/shared`.

**LID coverage.** RT-HEALTH-DECL/HTTP/EVAL/FAIL/PROV/NET/VALID/LOG/REDACT; RT-WATCHDOG-ROUTE-001..004, RT-WATCHDOG-HC-001..006; IAC-PROGRAM-SG-012, IAM-006/009, LAMBDA-001/009/011/012/014, ENV-002.
`docs/arrows/game-runtime/health-check.md:52-55,124` already records the same disposition.

**Content at risk.**

- `health-check-design.md` cites `add-pluggable-health-checks/design.md:<lines>` about 8 times (Decisions table, fail-active section); rewrite each as self-contained rationale before deletion.
- The premise of the shared-Lambda decision — one function sees every opted-in game's secrets, accepted only because it runs no operator code — is missing from the LLD's "Where the check runs" row. Add it; `add-scripted-health-checks` removes that premise.
- Program LLD: the risk that `build:lambdas` lists every Lambda package by hand, so a missing `handler.cjs` surfaces only at apply time.
- Rollback path (remove the field and re-apply, which de-provisions the function) is stated nowhere. Low value.

### `add-healthcheck-auth-type` — (1) Archive

**Spec state.** Synced into `openspec/specs/game-health-checks/spec.md` (`:40-150`, `:253-290`, `:319-339`, `:341-389`, `:389+`).

**Built (27/27).**
`type?` field `gameServerConfig.ts:129`; redacted `secretSet`/`authType` `:338,347`; zod enums `gameServerValidator.ts:120,137`; handler type branches `lambda/health-check/src/handler.ts:98-105`; secret naming/restore/delete `secretsStore.ts:97,158,191`; write path `GamesWriteService.ts` `resolveHealthCheckAuthSecret`; IAM regression test `IamCheckService.test.ts:472-486`; wizard tests `networking-step.component.test.tsx`, `wizard-form.utils.test.ts`.
Deviation: task 3.5's standalone IPC channel was not added — the secret lifecycle runs inside `games.create`/`update`/`delete`, which `game-server-design.md:77-80` already describes.

**LID coverage.** RT-HEALTH-AUTH-001..006, RT-HEALTH-VALID-008, RT-HEALTH-REDACT-001..003, RT-HEALTH-CRED-001..008; GAME-MODEL-002, GAME-WRITE-003/007, GAME-DRAFT-011.
Open defects already in LID: GAME-WRITE-004 (secret mutated before the config write, never rolled back) and game-server open question 15 (basic/bearer credentials in plaintext in the on-disk draft).

**Content at risk.**

- `design.md` D4 rejected "never auto-delete" because bot-token secrets are few and infra-created while health-check secrets are per-game and per-edit. The LLD's "Secret deletion" row lists only the ForceDelete alternative; add this one.
- `health-check-design.md` cites `add-healthcheck-auth-type/design.md:<lines>` about 6 times; rewrite.
- `verify.md` records two critical review findings: AWS write before validation (now GAME-WRITE-003) and `auth: null` disabling Submit (history only).
- `plan.md` (1965 lines) and `brainstorm.md` Q1–Q5 are already summarised in the LLD Decisions table; nothing to keep.

### `add-scripted-health-checks` — (3) Migrate

**State.** Not started: `gameServerValidator.ts:250` is still `kind: z.literal('http')`; no `quickjs`/`isolated-vm` dependency anywhere; no `openspec/specs/scripted-health-checks`.
Depends on `add-pluggable-health-checks` (kind discriminator, Lambda, fail-active, host-from-ECS) and is blocked in practice by RT-HEALTH-PROV-003/004 — the Lambda cannot run on `main`.

**Reconcile before migrating.**

1. Its `game-health-checks` delta restates "AWS calls travel the normal public-subnet route, no new network provisioning". LID dropped that as false (`health-check-specs.md`, "Dropped"); do not migrate it.
2. It predates auth types. It must say what the `secret` binding holds for `basic` (raw JSON string or parsed object) and for `bearer`. **Owner decision.**
3. RT-HEALTH-DECL-001 ("whose only accepted value is `http`") must be amended alongside RT-HEALTH-DECL-007, to read "whose accepted values are `http` and `script`", so the two lines do not contradict each other.
4. Audit is mostly covered: GAME-WRITE-013 already records redacted before/after for every game write; only "script source appears in the entry" is new.

**Target.** `docs/intent/game-runtime/health-check/health-check-design.md` and `health-check-specs.md`, plus one line in `game-server-specs.md` and two in `iac/program/program-specs.md`.
Given the blocker, the owner may land these as `[D]` instead of `[ ]`.

**Drafted EARS** (next free numbers):

```
- [ ] **RT-HEALTH-DECL-007**: The `healthCheck` declaration shall accept `kind: 'script'` carrying `source`, `port`, optional `auth` and `timeoutMs`, alongside the unchanged `http` kind.
- [ ] **RT-HEALTH-VALID-009**: When an operator saves a `script` health check whose `source` exceeds the fixed length bound or whose `port` is not a declared TCP port or `webPort`, the game-server validator shall reject the save.
- [ ] **RT-HEALTH-VALID-010**: When an operator saves a health check with a `kind` other than `http` or `script`, the game-server validator shall reject the save.
- [ ] **RT-HEALTH-SCRIPT-001**: When the health-check Lambda runs a `script`-kind check, it shall evaluate the source in a fresh QuickJS-WASM context and dispose that context after the execution, on success and failure paths alike.
- [ ] **RT-HEALTH-SCRIPT-002**: When a script's `export default` is a function, the health-check Lambda shall call it with `{ game, task: { host, port }, secret, request }` and await a thenable result by draining pending jobs.
- [ ] **RT-HEALTH-SCRIPT-003**: The script request capability shall take the scheme, host and port only from the declaration and the ECS-resolved task address, and accept from the script only path, method, headers and body.
- [ ] **RT-HEALTH-SCRIPT-004**: If a script passes an absolute URL or authority as the path, or sets a `Host` header, then the request capability shall still address only the bound task or reject the request.
- [ ] **RT-HEALTH-SCRIPT-005**: The script context shall expose no environment variables, execution-role credentials, filesystem, module loader or network primitive other than the request capability.
- [ ] **RT-HEALTH-SCRIPT-006**: The health-check Lambda shall pass into the sandbox only the secret referenced by the checked game's `auth`, and no other secret.
- [ ] **RT-HEALTH-SCRIPT-007**: If a script exceeds its `timeoutMs`, then the host shall terminate it via the interrupt handler and cancel any in-flight request it started.
- [ ] **RT-HEALTH-SCRIPT-008**: If a script exceeds the guest memory ceiling or the outbound-request cap, then the host shall terminate the execution, the cap being checked before each request.
- [ ] **RT-HEALTH-SCRIPT-009**: If an outbound script request body or an inbound response body exceeds the fixed byte limit, then the host shall reject the outbound request or truncate the inbound body before it crosses the sandbox boundary.
- [ ] **RT-HEALTH-SCRIPT-010**: If a script's returned value exceeds the host's depth or size marshalling bound, then the host shall stop marshalling and return a failure-derived active verdict.
- [ ] **RT-HEALTH-SCRIPT-011**: If script source fails to evaluate, throws, rejects, exceeds any limit, has no `export default`, or settles to a value not shaped `{ active: boolean, reason: string }`, then the Lambda shall return a failure-derived active verdict whose reason identifies the failure (and its source location for a thrown error).
- [ ] **RT-HEALTH-SCRIPT-012**: When a script's reason crosses out of the sandbox, the host shall redact the resolved credential value and secret-shaped substrings, then truncate it to the fixed bound, before logging.
- [ ] **RT-HEALTH-SCRIPT-013**: The health-check Lambda shall never log script source, script responses or script diagnostic output.
- [ ] **RT-HEALTH-SCRIPT-014**: State written by one script execution shall not be observable by a later execution in the same warm container.
- [ ] **RT-HEALTH-REDACT-005**: While the wizard edits a `script` health check, it shall show a statement that the script can issue arbitrary requests (including destructive ones) to the checked task, and shall show only `secretSet` for its credential.
- [ ] **GAME-WRITE-014**: When a game save changes a `script` health check's source, the audit entry recorded per GAME-WRITE-013 shall include the game, the time and the changed source.
- [ ] **IAC-PROGRAM-RUNTIME-007**: The health-check bundle shall embed or resolve the QuickJS WASM artifact so that the built `dist/handler.cjs` evaluates a script, verified against the built bundle.
- [ ] **IAC-PROGRAM-LAMBDA-017**: Where any game declares a `script` health check, the health-check Lambda's memory and timeout shall cover a measured per-execution runtime cost.
```

**Content at risk** (exists only in `add-scripted-health-checks/design.md`; move into the health-check LLD's Decisions & Alternatives table and Open Questions):

- Runtime: QuickJS-WASM over `isolated-vm` (native addon esbuild cannot bundle; ABI rebuild per Node major); `ses` rejected (no execution boundary).
- Host owns the destination; the script supplies only path/method/headers/body. Fetch-plus-URL-validation rejected for parser-disagreement bypasses. The boundary does not stop a script mutating the game it checks.
- Limits enforced host-side; the marshalling bound is separate from the guest memory limit. Contract is `export default` only.
- Script source lives in `DeploymentConfig` (inherits S3 version history); a separate store was rejected.
- Risks: a sandbox escape reaches every opted-in game's secrets because the Lambda is shared (mitigations: STS per-secret scoping, or per-game Lambdas for the script kind); a slow script delays the watchdog's sequential loop (RT-WATCHDOG-HC-006); QuickJS is not Node, so missing built-ins need documenting; WASM bundling is a new pattern and should be built first.
- Open question: Lambda memory/timeout sizing (becomes IAC-PROGRAM-LAMBDA-017).
- Docs obligations at ship time: guest environment, security posture and "prefer the declarative kind" in `docs/docs/components/lambdas.md` and the wizard page.

### `add-icmp-ingress` — (1) Archive, `--skip-specs`

**Spec state.** All 4 ADDED requirements are hand-merged into `openspec/specs/game-port-visibility/spec.md:114-165`; a default archive aborts on the first ADDED requirement ("Connect-port surfaces exclude ICMP entries") that already exists and changes no file, so archive with `--skip-specs` (`docs/arrows/game-server.md:98`). Shipped in PR #599 (`f81b09b7`).

**Built (16/17: 16 `[x]` plus 5.3 `[~]`).**
`isIcmpProtocol` `shared/src/gameServerConfig.ts:61`; ICMP range and cross-game visibility rule `gameServerValidator.ts:637-683,792`; rule shape `toPort: -1` `infra/src/securityGroups.ts:222-223`; `portMappings` filter `ecs.ts:279-283`; `firstPortByGame` skips ICMP `lambdas.ts:321`; wizard `networking-step.component.tsx`, `wizard-form.utils.ts` with tests; docs `docs/docs/components/infra.md:316-318`, `app/games.md:148-161`, `setup.md:373-378`, `README.md:92-105`.
Remaining: task 5.3 `[~]`, a manual `pulumi preview` showing the ICMP rule and a zero diff on a non-ICMP config. Nothing to build.

**LID coverage.** GAME-PORT-009..015; IAC-PROGRAM-SG-004, IAC-PROGRAM-ECS-006, IAC-PROGRAM-ENV-003; DISCORD-MSG-004.
Related existing gap (not from this change): GAME-VALID-010 `[ ]` — protocol not limited to `tcp|udp|icmp` for non-HTTPS games.

**Content at risk.**

- D2: ICMP types 0–255 chosen over type-8-only and over `-1` all-types. `game-server-design.md:138` cites only D1/D4 and lists only the `allow_ping`/always-on alternatives; add D2.
- D5 (visibility applies) and D6 (Discord skips ICMP) are carried by EARS; just drop the citations.
- `brainstorm.md` incident evidence (2026-08-31 flow-log proof: browser join = 2 ICMP echo REJECT, then no UDP; manual rule on `sg-0e37b362ca57210bf`). `setup.md:378` and `infra.md:318` keep the gist; optionally one rationale line in the game-server LLD.
- `plan.md`: implementation script, nothing to keep.

### `https-explicit-web-port` — (1) Archive, `--skip-specs`

**Spec state.** Synced into `game-https-configuration/spec.md:137,161`, `in-task-tls-termination/spec.md:11,72`, `game-port-visibility/spec.md:34,51,166`, except the MODIFIED constraint 5 (cross-game `webPort`, delta `spec.md:63,87`). That gap is moot: LID GAME-HTTPS-009/010 carry it. A default archive aborts and changes no file (the delta's RENAMED FROM header is gone from main, whose renamed requirement is at `game-port-visibility/spec.md:50`, and its MODIFIED "Internal ports" block omits a scenario main has at `:33`), so archive with `--skip-specs`. Proposal PR #685; implementation #688/#689/#691.

**Built (15/15).**
`webPort` and the `@deprecated` `normalizeGameServer` with its removal condition `shared/src/gameServerPorts.ts:33-66`; `checkWebPortCollisionsAcrossDeployment` `gameServerValidator.ts:844,1109`; Caddy `--to webPort` and port mappings in `ecs.ts`; no `webPort` ingress (`securityGroups.ts`, `ingressPorts`); `HTTPS_CONNECT_PORT` in `lambdas.ts` and `formatStatus.ts`; normaliser applied in `DeploymentConfigService`, `GameWizardDraftService`, `DriftService`; wizard field in `networking-step.component.tsx`.

**LID coverage.** GAME-HTTPS-004..017, GAME-PORT-004; IAC-PROGRAM-SG-007, IAC-PROGRAM-ECS-006/008, IAC-PROGRAM-TLS-001/005; CONFIG-READ-007, CONFIG-DRIFT-005; RT-HEALTH-VALID-001; DISCORD-MSG-005.
Leftovers already in LID: GAME-IPC-005 `[ ]` (preload `GameServer`/`GameWizardDraft` mirrors lack `webPort`, `desktop-preload/src/hyveon-api.ts:418,650`); game-server Deferred Q9 (design D2 says `checkPortCollisions` covers `webPort`; code splits it across two functions).

**Content at risk.**

- D3: `webPort` gets no ingress so Caddy stays the only public entry; extra ports get ingress. Rationale → game-server or `iac/program` Decisions table.
- D5: `healthCheck.port` may equal `webPort`. D6: helpers live in pure `gameServerPorts.ts` because of the barrel rule.
- Risk: normalising `ports.slice(1)` newly exposes old HTTPS extra ports on the next apply.
- Rollback: after a save, rollback needs `restoreRawConfig` (S3 version restore).
- Open question: which release removes the normaliser. **Owner decision**; record as a deferred decision in `game-server-design.md`.
- The LLD table cites D1 and D4 by path; inline them.

### `add-pinned-hostname` — (2) Partly built (manual verification only)

**Spec state.** Never synced — there is no `openspec/specs/game-hostname-pinning` and no archive. LID already holds the full behaviour, so archive with `--skip-specs` (a default archive would create a new `game-hostname-pinning` main spec, +5 added); archive once the manual checks are done (or close without them).
Proposal PR #687; implementation #692 (`5b984bbe`) plus `27bf7cec`, `104b5fac`, `8f7d8986`, `9eabf288`, `8cb01e9e`.

**Built (tasks 1–4).**
`pinnedHostname` and `checkPinnedHostname` `gameServerValidator.ts:62-72,944`; `infra/src/hostnameShim.ts` (busybox `1.38.0` at `:15`) with test, wired into `ecs.ts`; wizard `environment-step`/`review-step`, `wizard-form.utils.ts`; type mirrors in preload `hyveon-api.ts`, `api.service.ts`, `ElectronStoreService.ts`, `GameWizardDraftService.ts`; `diagnosticsBundleAllowlist.ts`; docs `docs/docs/app/games.md:340-386,721`, `components/infra.md:154,407-435`. 45 `@spec GAME-HOST|IAC-PROGRAM-HOST` annotations.

**Remaining.**

- 5.3 (manual): Pulumi preview against a stack with no opted-in game shows zero task-definition diff. Already pinned by IAC-PROGRAM-HOST-005 and GAME-HOST-008; no new intent.
- 5.4 (manual): live Foundry run — enable, apply, start, accept the EULA once, stop, start, confirm `Software license verification succeeded` with no prompt. The planned `verify.md` was never written. This tests Foundry's behaviour, not Hyveon's; it belongs in a runbook, not EARS. Optional deferred marker: `- [D] **GAME-HOST-017**: When a Node.js game whose license is bound to os.hostname() starts with pinnedHostname set after one EULA acceptance, the game shall verify its license without prompting on later starts.`
- Existing LID gap: GAME-HOST-016 `[ ]` (review step shows env and pinned hostname in the Storage card).

**The "EFS shim upload + `NODE_OPTIONS`" blocker is the pre-feature workaround, not a step of this change.** The shipped design writes the shim from an init container into task-ephemeral storage and needs neither. Design Migration step 4 says to remove the manual `NODE_OPTIONS --require` when enabling the field; if both stay, the operator's shim loads second and wins, harmless only if the hostnames match. `docs/docs/app/games.md:350` currently says to keep `NODE_OPTIONS` and says nothing about removing the manual shim.

**Conflict to settle (owner decision).** Design D9 says `pinnedHostname` gets no drift field (deliberately closed set); LID CONFIG-DRIFT-008 `[ ]` asks for drift on `pinnedHostname` or for the banner to state the narrowed scope. Pick one and record it in `deployment-config-design.md`.

**Content at risk (largest of the set).**

- D3 delivery alternatives rejected: `file_seeds` onto EFS, inline `--import=data:` ESM, custom image. D4: busybox on ECR Public (size, pull-rate limits, no new egress, exact pin). D5: shim in infra not shared; base64 to avoid quoting; no `process.env.HOSTNAME` rewrite. D6: merge `NODE_OPTIONS` shim-first rather than reject or append. D7: reserved-path rationale. D8: wizard placement. D9: no drift.
  → D3–D6 into `program-design.md` Decisions; D7–D9 into `game-server-design.md` Decisions.
- Risks: a future Foundry stops using `os.hostname()`; an image strips `NODE_OPTIONS`; an init-container failure means the game never starts (reason in the stopped reason and the `hostname-shim` log stream).
- Open questions → `game-server-design.md` Deferred: does entering the old signing host skip the EULA (unverified); `--import=data:` follow-up spike.
- `brainstorm.md` evidence: felddy v14.369 four-run matrix; Fargate `awsvpc` ignores `hostname`.
- Runbook (live check; removing the manual EFS shim and `NODE_OPTIONS`; enter the same hostname to avoid a re-sign) → `docs/docs/app/games.md` "Pin hostname" or a new `docs/docs/guides/` Foundry page.

### `add-vpc-flow-logs` — (3) Migrate (candidate `[D]`)

**State.** Not started: no `flowLog`/`FlowLog`/`vpcFlowLogs` in `app/packages` or `docs/docs`; 0/22 tasks; proposal PR #595 only. LID already records it as not started (`docs/arrows/operator-app/infra-logs.md:71`, `docs/arrows/deployment-config.md:67`, `infra-logs-design.md:50`). No `openspec/specs/vpc-flow-logs` exists.

**Raise before building (owner decision).**

- The motivating Palworld case was solved by ICMP (#599); this is now general diagnostics. Landing the EARS as `[D]` rather than `[ ]` is reasonable.
- Design D5 adds four more resolver wrappers to `LogsService`, which violates `.claude/rules/duplication.md`; `infra-logs-design.md` Q16 asks to collapse the existing game/Lambda pairs first. The drafted APP-LOGS lines below assume the shared resolver path.

**Target LLDs.** `docs/intent/iac/program/program-design.md` (Network, IAM, Stack Outputs), `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/operator-app/infra-logs/infra-logs-design.md`.

**Drafted EARS** (next free numbers):

```
- [ ] **IAC-PROGRAM-NET-003**: While `DeploymentConfig.vpcFlowLogsEnabled` is true, the infrastructure program shall declare one `aws.ec2.FlowLog` on the Hyveon VPC with `trafficType: 'ALL'`, publishing to a CloudWatch Logs log group named `/vpc/${projectName}-flow-logs` tagged `Project=hyveon`.
- [ ] **IAC-PROGRAM-NET-004**: While `DeploymentConfig.vpcFlowLogsEnabled` is false, the infrastructure program shall declare no flow log, flow-log IAM role or flow-log log group, and shall change no other network or game resource.
- [ ] **IAC-PROGRAM-IAM-011**: Where VPC flow logs are enabled, the infrastructure program shall declare an IAM role assumable only by `vpc-flow-logs.amazonaws.com` whose policy grants `logs:CreateLogStream` and `logs:PutLogEvents` on exactly the flow-log log group's ARN and nothing broader.
- [ ] **IAC-PROGRAM-OUT-009**: Where VPC flow logs are enabled, the infrastructure program shall export the flow-log log group name as a stack output.
- [ ] **CONFIG-MODEL-009**: When `withDeploymentConfigDefaults` fills a document lacking `vpcFlowLogsEnabled`, it shall resolve the field to `true`.
- [ ] **CONFIG-FORM-008**: The Settings page shall expose `vpcFlowLogsEnabled` as a toggle whose copy states that CloudWatch Logs bills flow-log ingestion per GB regardless of accept/reject outcome.
- [ ] **APP-LOGS-GROUP-008**: When the log viewer resolves the flow-log log group, it shall read the stack output, falling back to `/vpc/${projectName}-flow-logs`, through the same resolver path as game and Lambda groups.
- [ ] **APP-LOGS-SNAP-007**: When the operator requests recent flow-log records with a limit, the log viewer shall return up to that many records from the group's newest stream, oldest-first, or a single informational line if the group has no streams.
- [ ] **APP-LOGS-SNAP-008**: If a CloudWatch call for flow-log records fails, then the system shall log a `warn` naming the log group and return a single failure line instead of a raw SDK error.
- [ ] **APP-LOGS-PAGE-009**: When the operator pages flow-log records older or newer than a timestamp, the log viewer shall scan every stream in the flow-log group and exclude already-delivered event identities.
- [ ] **APP-LOGS-TAIL-012**: While a flow-log tail is active, the log viewer shall yield newly written records without a new fetch and shall end without further records once the abort signal fires.
- [ ] **APP-LOGS-IPC-009**: Each flow-log IPC handler shall begin with a `logger.debug` entry naming its pattern.
- [ ] **APP-LOGS-UI-010**: The `/logs/infrastructure` page shall offer a flow-log view that parses each pipe-delimited record into fields including `action`, and shall state the roughly one-minute AWS capture lag.
- [ ] **APP-LOGS-UI-011**: When the operator enables "rejected only" on the flow-log view, the page shall display only records whose `action` is `REJECT`.
```

**Content at risk** → `program-design.md` and `infra-logs-design.md` Decisions tables:

- D1: VPC-level, not per-subnet. D2: `ALL` traffic so ACCEPT serves as a control case. D3: CloudWatch, not S3, to reuse the existing read path. D4: log-group naming namespace. D6: boolean only; retention never-expire, matching the other groups.
- Risks: ingestion cost; ~1-minute capture lag; disabling orphans the log group, which must be deleted by hand. The cost and orphan-cleanup notes go into `docs/docs/components/infra.md` when it ships.

### `add-release-automation` — (1) Archive, `--skip-specs`

**Spec state.** `openspec/specs/release-automation/spec.md` is ahead of this change's delta: main says the build pipeline runs in the same workflow run and adds the "No release exists while builds are running" scenario, while the delta still routes publishing through `package.yml`'s tag trigger. A default archive aborts on the first ADDED requirement that already exists and changes no file, so archive with `--skip-specs`; the agent-driven `/opsx:sync` would overwrite main with the stale delta (`docs/arrows/operator-app/app-update-and-release.md` Finding 14).
The change's `design.md` is also stale (model `claude-opus-5` vs `claude-sonnet-5-5` in code; `package.yml` publishing; softprops upsert for replay); `app-update-and-release-design.md` Deferred Q6 already flags this.

**Built.** `.github/workflows/release.yml`, `cliff.toml`, `.github/actions/publish-release/action.yml`, `.github/actions/build-package`, carrying `@spec APP-UPDATE-REL-001` (`release.yml:3`), REL-006 (`:50`), BUMP-008 (`:68`), DRAFT-001 (`publish-release:24`), DRAFT-003 (`:38`). PRs #664–#667, #673, #677, #681, #706.
Real releases v0.7.0 → v0.10.0 have run through `release.yml` (15 tags v0.1.0–v0.10.0; v0.9.1 Latest, v0.10.0 Draft created 2026-10-31).

**The 8 unchecked tasks are operational, not code.**

| Task | State | Evidence |
|---|---|---|
| 4.1, 4.2, 4.4 — GitHub App, credentials, ruleset bypass | Done | `chore(release): vX` commits and annotated tags authored by `hyveon-release-bot[bot]` (e.g. `1954e4f5` v0.10.0) on protected `main` |
| 4.3 — `CLAUDE_CODE_OAUTH_TOKEN` | Done | "Generate AI release summary" step succeeds; v0.10.0 and v0.9.1 bodies are AI prose |
| 4.5, 5.2 — App-token push; end-to-end bump run | Done | Run 41254568937: release, 3-OS package and publish all green; v0.10.0 carries all 10 assets |
| 5.3 — replay run | Done | Runs 31770134203, 31564773964 skip bump/tag while the AI step runs; 31563060146 rejects replay-without-tag at Validate inputs |
| 5.4 — forced AI-failure fallback | Unverified | No forced-failure run found. APP-UPDATE-NOTES-004 is `[x]` from code review. **Owner decision:** run it once, or drop it |

**LID coverage.** APP-UPDATE-REL-001..006, BUMP-001..010, NOTES-001..004, DRAFT-001..006. Open gap: APP-UPDATE-DRAFT-004 (incomplete draft left behind when asset verification fails).
`app-update-and-release-specs.md` "Dropped from OpenSpec" (`:137+`) records the three deliberate divergences (bump-mode `to` is main's tip; AI-failure body shape; lockfile staged in the bump commit).

**Content at risk** → `app-update-and-release-design.md` Decisions & Alternatives (`:113-131`):

- Bypass-actor mitigations: App limited to Contents read/write; `workflow_dispatch` itself requires repo write; App pushes attributable to the bot in the audit log. `docs/docs/guides/maintainer.md:470` says only "Contents: read & write". Add to the push-identity row.
- Replay trusts the operator-supplied `tag` without re-validating its range. New "Replay tag trust" row.
- `required_approving_review_count` is 0, part of why the auto-merge-PR approach was rejected.
- The one-time setup runbook already lives at `docs/docs/guides/maintainer.md:466-480`; the rollout migration plan is obsolete.

### `add-update-feed-fallback` — (1) Archive

**Spec state.** Delta matches `openspec/specs/auto-update-scaffold/spec.md:141-175` exactly (synced).

**Built (6/6).** `updater-fallback.ts:49` `pickFallbackRelease`, `:67` `resolveFallbackFeedUrl`; `updater.ts:42` `checkWithFallback` (`@spec APP-UPDATE-FALL-001/003/004/005` at `:32`); `updater-fallback.test.ts` (12), `updater.test.ts` (31); `settings.page.tsx:80` `RELEASES_URL`, "Download manually" link `:352`, 15 cases in `settings.page.test.tsx`; docs `docs/docs/app/settings.md:168,209`. Commit `1e30ebe7` (#668), first released in v0.7.3.

**LID coverage.** APP-UPDATE-FALL-001..006, APP-UPDATE-UI-008/009. Later-found gap, not a task of this change: APP-UPDATE-FALL-007 `[ ]` (paginate past `per_page=10`).

**Content at risk.** The motivating incident (v0.7.0 shipped with zero assets) and the fact that clients older than v0.7.3 cannot self-heal and need one manual update → one line in the "Recovering from a release without a feed" row (`app-update-and-release-design.md:127`).

### `add-user-initiated-update-install` — (1) Archive

**Spec state.** Unsynced: `openspec/specs/auto-update-scaffold/spec.md` has no download/install requirement, and its "Failed manual checks link to the releases page" requirement (`:160-172`) is the narrower pre-change text. The delta only adds the ADDED requirement and widens that MODIFIED one, and a default archive applies it cleanly (+1 added, ~1 modified), so syncing is safe if `openspec/` stays longer. Since `openspec/` is being retired, either archive or skip the apply (`--skip-specs`) — APP-UPDATE-DL-*, IPC-004..008 and UI-005..009 hold both requirements in full.

**Built (11/11).** `updater.ts:197` `downloadUpdateNow` (`@spec DL-001..004/006/007`), `:251` `installDownloadedUpdate` (DL-008); controller `iac-settings.controller.ts:301,327`, self-bridged `:119-120`, in `ipc-main-bridge.ts:37` `SELF_BRIDGED_PATTERNS`; shared types `autoUpdateSetting.ts:68-84`; preload `preload.ts:654-655`; e2e stub `hyveon-http-bridge.ts:298,306`; Settings buttons `settings.page.tsx:65-67,89`; docs `settings.md:212,226-233`. Commit `47499ed7` (#675), first released in v0.9.0.

**Open LID gaps in the area (not this change's tasks).** APP-UPDATE-DL-005 (retry matches the literal "Please check update first" text, not updater state); DL-009 (install proceeds when nothing was downloaded); IPC-009 (stream channel names declared twice).

**Content at risk.** Two risks from the change's `design.md`: closing Settings mid-download does not cancel the download; an install-failure retry re-downloads, with electron-updater serving the cached file → a sentence under the LLD's "Updater Runtime / Entry points" section or `docs/docs/app/settings.md:230`.

**Archive overlap.** `archive/2026-09-09-add-manual-update-check` (synced at `auto-update-scaffold/spec.md:86`, carried by APP-UPDATE-CHECK-001..007) is extended by this change without conflict. `2026-08-10-add-distribution-updater` and `2026-08-14-add-autoupdate-settings-toggle` are carried by APP-UPDATE-BOOT-*, FLAG-*, PKG-001..003, DOCS-*.

## `openspec/specs/` capabilities without a full LID counterpart

Method: every leaf `*-specs.md` tags its EARS lines with `(OpenSpec: <capability> / <Requirement>)`; those tags (excluding each file's "Dropped from OpenSpec" section) were matched against every `### Requirement` title in the 37 capabilities (219 requirements), and each untagged requirement was then checked by grepping its key nouns.
Result: 32 capabilities are fully carried (apart from the deliberate drops each leaf's "Dropped from OpenSpec" section explains), 2 are partial, 3 have no counterpart. The `discord-bot` leaf has no OpenSpec source; its EARS are native.

| Capability | Reqs | LID counterpart | Coverage | Gap and recommendation |
|---|---|---|---|---|
| `cost-visibility` | 6 | `game-runtime/task-and-dns` (RT-TASK-LAUNCH-003/004, dashboard), `game-server` GAME-RES-006 | PARTIAL | "Per-game AWS resources carry a Game cost allocation tag": `task-and-dns-specs.md:106-109` hands its 4 scenarios to `iac/program`, but `program-specs.md` has no Game-tag EARS. Code exists (`infra/src/ecs.ts:199,212,354`, `lambdas.ts:741,766`; tested `ecs.test.ts:101,123,167`). Add the drafted IAC-PROGRAM-TAG lines below. |
| `desktop-only-operator-surface` | 11 | `operator-app/ipc-bridge` (XPORT/STREAM/HARN/SEAM), `operator-app/desktop-shell` (NAV/UI) | PARTIAL (6/11) | (a) "No container/shell deployment artifacts at repo root" — repo hygiene; drop or make a CI check. (b) "ConfigService carries no API-token plumbing" — removal history, implied by APP-IPC-XPORT-006; drop or fold into XPORT. (c) "Documentation describes only the desktop workflow" — a `write-docs` concern; drop. (d) "Navigating to logs from a game preselects that game" — carried by APP-LOGS-UI-001 but untagged; add the tag. (e) "No operator-editable configuration files" and (f) "Nothing but the app runs in a terminal" — real product principles only partly carried (HLD Non-Goals, CONFIG-READ-001, IAC-RUN-PLAN-010); **add both as explicit HLD non-goals**. |
| `docs-screenshot-capture` | 6 | none (`index.yaml` `unmapped.docs.openspec`) | NONE | Not runtime intent. 5/6 already prose in `docs/docs/guides/maintainer.md:382-413` and `.claude/skills/write-docs/SKILL.md:139`; "re-run produces stable images" is stated nowhere — add one line to `maintainer.md`, then drop. |
| `node-toolchain-version` | 5 | none | NONE | Not runtime intent. Already enforced by `package.json` `engines >=24` and `node-version: '24'` in workflows, and stated in `maintainer.md`/`setup.md`. Fold the policy (Node major; Lambda runtime governed separately by IAC-PROGRAM-RUNTIME; Docusaurus currency) into a short `.claude/rules` note, or drop. |
| `operator-documentation` | 7 | only RT-WATCHDOG-DOC-001/002, incidentally | NONE | Not runtime intent. Broken links already fail the build (`onBrokenLinks: 'throw'`); "every routed screen has a page and screenshots", "orphaned assets removed" and "counts match the codebase" belong in the `write-docs` skill and `docs-coverage-auditor`. Drop. |

Fully carried, with notes worth acting on:

- `cloud-bootstrap` "Buckets block public access" is carried by APP-WIZARD-BOOT-005/008/009 but untagged; add the tag.
- `env-token-interpolation` is carried by `game-server` and `iac/program`, but the archived design's D2/D3/D6 rationale (two resolution seams; inline `entryPoint` boot wrapper needing no IAM; fail the start on an unresolved token) is in no Decisions table; add rows to `game-server-design.md` and `program-design.md`.
- `lambda-runtime-currency` dropped its process clauses (merge rule; verify against the deployed SDK); move them to `.claude/rules/dependencies.md` if still wanted.
- `install-and-signing-docs` (APP-UPDATE-DOCS), `orchestrator-integration-coverage` (`iac/run` "Integration coverage"), `preload-bridge-naming` (APP-IPC-NAME), `app-icon` and `release-automation` are build, test or convention requirements rather than runtime behaviour; they are already carried and can stay.

Drafted EARS for `program-specs.md` (new `TAG` group):

```
- [x] **IAC-PROGRAM-TAG-001**: The infrastructure program shall tag each game's `{game}-server` ECS task definition with `Game: <game>`.
- [x] **IAC-PROGRAM-TAG-002**: The infrastructure program shall tag each game's per-game CloudWatch log groups (game server and file browser) with `Game: <game>`.
- [x] **IAC-PROGRAM-TAG-003**: Where a game declares EFS seed files, the infrastructure program shall tag that game's EFS-seeder Lambda and its log group with `Game: <game>`.
- [ ] **IAC-PROGRAM-TAG-004**: The infrastructure program shall not apply a `Game` tag to shared resources (cluster, VPC, shared Lambdas, shared log groups).
```

TAG-004 has no test yet, so it lands `[ ]` and needs a test asserting no `Game` tag on the shared resources before it is marked `[x]`. The other three are tested: TAG-001 by `ecs.test.ts:167` (`alpha-server` carries `Game: 'alpha'`), TAG-002 by `ecs.test.ts:101,123` (game and file-browser log groups) and TAG-003 by `infra/src/lambdas.test.ts:712,726` (the EFS-seeder log group and function assert `Game: 'echo'`; seeder code at `lambdas.ts:741,766`).

## Content lost if `openspec/` were deleted today

Beyond the per-change "Content at risk" lists above:

| Path | What it holds | Destination |
|---|---|---|
| `openspec/config.yaml` | `schema: spec-driven` plus template comments | Nothing to keep; delete. |
| `openspec/schemas/superpowers-bridge/**` (12 files, vendored in #364) | Schema, README, artifact templates incl. a retrospective template | No CI, `package.json` or `bin/` reference. Live dependents: `.claude/hooks/guard-superpowers-paths.ts:7-26` redirects brainstorm/plan output into `openspec/changes/<name>/` and must be rewritten or removed; `.claude/rules/spec-driven-development.md` is entirely OpenSpec routing. Port the retrospective template to `.claude/rules` only if retros continue. |
| `openspec/changes/archive/**` (35 changes) | Delta specs (already folded into main specs), designs, 18 with brainstorm/plan/verify/retro | Delta specs: drop. LLD References cite 19 of 35 archive designs; of the 16 cited nowhere, these carry rationale not in any LLD: `add-env-var-token-interpolation`, `add-internal-game-ports` (VPC-CIDR ingress choice), `add-https-toggle-to-game-form`, `add-game-wizard-draft-persistence`, `add-per-game-cost-tags`, `game-server-resource-sliders`, `add-distribution-updater`, `add-autoupdate-settings-toggle`, `add-manual-update-check`, `add-game-env-vars-ui`. Inline their decisions into the owning LLDs, then delete — git history keeps the files, and LLD References can cite a commit SHA instead of a path. |
| Archive retrospectives | 15 retros with ~45 "Promote candidates", all unchecked, none in `.claude/rules` (e.g. a widened renderer type must check its `desktop-main` persisted twin; `desktop-main` tsconfig excludes `*.test.ts` so typecheck misses test type errors; diff user-facing action strings against existing controls) | Triage each into `.claude/rules/*` or drop. |
| OpenSpec-only tooling | `.claude/commands/opsx/*` (12), `.claude/commands/openspec-review-{proposal,implementation}.md`, `.claude/skills/openspec-*`, `.github/prompts/opsx-*.prompt.md` (12), `.github/skills/*` (12), `.claude/workflows/openspec-review-{proposal,implementation}.js` | Retire with `openspec/`. |
| `docs/superpowers/{plans,specs}/` (outside `openspec/`) | 9 plans, 1 spec, 9 OpenSpec refs | Same retirement decision. |

## Inbound references to repoint at retirement

- `docs/high-level-design.md:238` cites `desktop-only-operator-surface`; `:300-303` "Legacy requirement source" says `openspec/specs/` (miscounted as 36; there are 37) "remains authoritative for anything not yet carried over" — rewrite once the partial/none capabilities above are settled.
- `CLAUDE.md`: `:4`, `:12-13` (routing table), `:30-33` (opsx workflow), `:111`, `:138-139` (pre-PR OpenSpec sync step); invariants `:91` (`openspec/specs/in-task-tls-termination` → `docs/intent/iac/program` TLS-*) and `:102` (`openspec/specs/desktop-only-operator-surface` → `docs/intent/operator-app/ipc-bridge` XPORT).
- `.claude/`: `agents/docs-accuracy-auditor.md:35`, `agents/docs-writer.md:10`, `agents/docs-coverage-auditor.md:44-46` (checks OpenSpec sync), `agents/docs-style-reviewer.md:52`, `rules/pr-stacking.md:5`, `rules/spec-driven-development.md`, `hooks/guard-superpowers-paths.ts`, `skills/write-docs/SKILL.md:22,55,149` (routes `openspec/specs/**` edits to `/opsx:*` and tells the writer to read the spec first), `commands/openspec-review-{proposal,implementation}.md`.
- `.claude/settings.json:11-17`: the `PreToolUse` `Write|Edit` entry that runs `hooks/guard-superpowers-paths.ts`. Remove the registration in the same change that removes the hook file, or every `Write`/`Edit` runs a hook whose script is missing.
- `app/` code comments (20 files, 23 lines, plus `app/eslint.config.js:149`), most already dangling: `remove-cost-explorer-calls` ×11 (e.g. `CostService.ts:23`, `costs.controller.ts:13`, `shared/src/cloud.ts:35`), `add-first-run-wizard` ×6 (e.g. `wizard.controller.ts:104`, `IamCheckService.ts:98`), single refs to `migrate-iac-to-pulumi`, `add-diagnostics-export`, `add-infra-log-viewer`, `add-one-click-aws-bootstrap` ×2. Live spec refs `preload.ts:8,15`, `DeploymentConfigService.ts:7`, `infra/src/ecs.ts:311` should become `@spec` IDs.
- `docs/docs/`: `app/costs.md:24`, `components/management-app.md:291,328,526`, `components/integration-tests.md:178`, `guides/maintainer.md:26` and `intro.md:107` (repo trees), `components/infra.md:251` and `components/lambdas.md:209` (cite `game-health-checks` by name).
- `docs/arrows/index.yaml:268-277` (`unmapped.docs.openspec`) and `docs/arrows/_map-codebase/*` (bootstrap artefacts, 300+ refs; delete with the directory).
- No reference from `bin/coherence-check.mjs`, `package.json`, `.github/workflows/*` or test runtime logic.
