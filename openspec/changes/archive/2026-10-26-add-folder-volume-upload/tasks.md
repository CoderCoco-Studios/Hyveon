## 1. Groundwork

- [ ] 1.1 Confirm which volume's access point the FileBrowser helper mounts and how its root maps to `container_path`; exercise `login`/`resources` POST/GET against a real helper and record request/response shapes as fixtures
- [x] 1.2 Add shared progress/event/state types and the manifest/limits helpers as a `@hyveon/shared` subpath module (not the barrel) with unit tests

- [x] 1.3 Verify the helper image can run a `sh -c` wrapper that writes cert/key and execs FileBrowser with `--cert/--key`; if not, plan the Caddy sidecar fallback

## 2. Desktop main: scan and upload engine

- [x] 2.1 Folder-pick + scan IPC (native `openDirectory`, tree of name/kind/size, symlinks skipped and counted, scan id held in main), following the controller logging and electron-bootstrap-guard rules
- [x] 2.2 FileBrowser API client module (login, mkdir, streamed upload, list) with unit tests against recorded responses
- [x] 2.3 `FileManagerService` internal start-for-upload returning the credential in-process; always-stop in `finally`; "helper already open" detection
- [x] 2.4 Upload service: build file list from include paths, enforce traversal/destination rules, 4-way concurrent streamed uploads through a counting transform, bounded retries, resume-by-size skip, cancel, size/mtime recheck
- [x] 2.5 Progress aggregator (500 ms, smoothed rate/ETA, phases) emitting over an IPC event channel; preload bridge entries
- [x] 2.6 Post-upload verification (listing vs selection) and per-game electron-store state (`localPath`, `include`, `destination`, `lastRun`)
- [x] 2.6a Tag upload helpers (`Purpose=seed-upload`, `Project=hyveon`) alongside the existing `startedBy`; orphan sweep on app start and a Diagnostics "Clean up stray helpers" action (stops un-owned `filemgr-*` tasks older than 15 min, deregisters their task definitions, reports results)
- [x] 2.6b Operator public-IP detection; authorize/revoke `<ip>/32:8080` on the helper security group at launch/stop (and in the orphan sweep); per-launch self-signed cert/key generation, delivery to the container, and certificate pinning in the API client
- [x] 2.7 Guards: not deployed, server running, helper already open
- [x] 2.8 Unit + integration tests (HTTP mock seam), including cancel, mid-run failure, resume, helper auto-stop expiry

## 2b. Infra

- [x] 2b.1 Remove the `0.0.0.0/0:8080` ingress from `${projectName}-filemgr-sg` in `securityGroups.ts` (declare no ingress); update `securityGroups.test.ts`, `docs/docs/components/infra.md`, and the dashboard docs to say the file manager is reachable only from the operator's IP

## 3. Renderer

- [x] 3.1 Storage step / game page "Seed from folder": picker, tri-state include tree, destination field with validation, size/count summary, skipped-links note
- [x] 3.2 Progress meter component (phases, percent, bytes, files, current file, rate, ETA, cancel, Resume/Retry, verification result)
- [x] 3.3 Upload offered after apply succeeds (the wizard has no post-apply step, so the offer lives on the game page it navigates to, with a hint in the creation toast); game page action; selection and last-run status persisted and shown
- [x] 3.4 jsdom component tests (incl. failed/resume/restart) and e2e per testing-conventions

## 4. Verification and docs

- [x] 4.1 Run `npm run app:lint`, `app:typecheck`, `app:test`, `app:test:integration`, `app:test:e2e`
- [ ] 4.2 Manual run against a real deployment with `/mnt/d/Desktop/gameserver_files/FoundryVTT` (`Config` + `Data` only): watch the meter, interrupt and resume, confirm counts/sizes on the volume, record total time
- [x] 4.3 Update docs via `write-docs` (`components/management-app.md`, games/dashboard app pages, `architecture.md`; note the HTTP-helper security posture)
- [x] 4.4 Sync specs (`/opsx:sync`) once implemented

## 5. Overwrite confirmation

- [x] 5.1 Shared `awaiting-confirmation` phase, `OverwriteSummary` and `confirmOverwrite` decision types in `@hyveon/shared/folderUpload`
- [x] 5.2 Engine preflight: list only touched directories before creating any, `classifyUpload` (new / identical / conflict, sample cap, unrelated files as context) with unit tests
- [x] 5.3 `FolderUploadService` confirmation wait (confirm, decline, cancel, 10-minute timeout), own-partial-run exemption, helper stopped on every non-proceed path
- [x] 5.4 `folderUpload.confirmOverwrite` controller channel, preload bridge, `api.service` wrapper and e2e in-page fake
- [x] 5.5 Renderer overwrite warning in the progress meter (counts, sample paths with sizes, Overwrite and upload / Cancel) with jsdom and e2e tests
- [x] 5.6 Extend the HTTP-seam integration test (confirm, decline, no prompt) and update `games.md`, `management-app.md` and `integration-tests.md`
