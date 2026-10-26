<!--
Raw capture of superpowers:brainstorming output.

This file captures the brainstorming skill's output as-is, without enforcing
structure. The skill's natural output is usually a decision-log format
(context → decision chain Q1-Qn → design trade-offs), but the actual
organization may vary depending on the conversation.

design.md extracts from this file and reorganizes it into a structured
design document.

Do not copy this file's content into design.md — design.md is an
independently reorganized artifact; the two are complementary, not
overlapping.
-->

# Brainstorm — embed the file browser in the app

Run mode: the operator handed this over as an autonomous design task ("list open questions needing the operator's decision at the top of design.md"), so the brainstorm ran without an interactive Q&A. Every decision below is the designer's call unless marked otherwise, and the ones that genuinely need the operator are carried into design.md's Open Questions.

## Trigger

Operator report: clicking "Open file browser" in the desktop app does not launch the file browser. Today the dashboard's **Files** button opens `FileManagerModal`; **Launch** starts the per-game FileBrowser helper task (`FileManagerService.start`), and once the task is RUNNING the modal renders `<a href="http://<task-ip>:8080" target="_blank">Open FileBrowser at …</a>` plus a one-time username/password to copy. The anchor relies on `setDefaultBrowserOpener` (`electron-entry.ts:44-51`) turning `window.open` into `shell.openExternal`.

## Investigation notes (what was actually checked)

- **Operator's own log** (`%APPDATA%/hyveon/logs/main-2026-10-26.log`, session 13:19–13:24 local): `files.start` → operator-IP `/32` ingress authorized on the file-manager SG for port 8080 → task definition `filebrowser-foundryvtt:5` registered → `RunTask` → auto-stop schedule created → status polled every 5 s → at 13:20:04 `File manager status` reports `state: running` with a resolved public IP and `url: http://<ip>:8080`. The operator then reopened the modal at 13:24 and stopped the helper at 13:24:29. Nothing in the log records the link click — the window-open handler writes nothing to the winston log on success, and on failure writes only `console.error`, which a packaged build discards.
- **Helper's CloudWatch log** (`/ecs/filebrowser-foundryvtt`, stream for that task): `Using config file: /config/settings.json` → quick setup with the user-provided password → `Listening on [::]:8080` at 17:19:44 UTC → `Got signal: terminated` at 17:24:14. FileBrowser was up and healthy for the whole window. FileBrowser logs only ≥400 responses, so the absence of request lines neither proves nor disproves that a browser reached it.
- The same log stream also prints: **"File Browser is being wound down. The project is archived on 2026-09-01, after which there will be no further releases and no security fixes."** Research confirmed the repo is archived; v2.63.23 (2026-07-27) is the final release, so `filebrowser/filebrowser:latest` is frozen with known-unfixed advisories (non-revocable JWTs among them).
- **Security group** `sg-0b77e5f21347be585` (file-manager SG) now has no standing ingress — the `0.0.0.0/0:8080` rule is gone (the #672 infra edit is applied), and the app-added `/32` was correctly revoked on stop. The machine's current egress IPv4 matches the `/32` the app opened.
- The operator's default OS browser is Opera GX (Chromium 155 era). Its VPN/proxy switcher is not enabled, and Chromium's HTTPS upgrades do not apply to non-default ports, so neither explains a failure for `http://<ip>:8080`.
- Code path traced: `game-card.component.tsx:266` (Files) → `useFileManager.open` → `FileManagerModal` → Launch → `api.filesMgrStart` → preload `files.start` → `FilesController.start` → `FileManagerService.start/launch`. The link itself is a plain `<a target="_blank">` (`file-manager-modal.component.tsx:51`), with no IPC call behind it.

### Root-cause conclusion

Every step the app controls up to rendering the link is confirmed working from logs. The only unverified hop is the one the app hands to the OS: renderer link → `setWindowOpenHandler` → `shell.openExternal` → default browser → `http://<ip>:8080`. That hop has three properties that together make "click does nothing" both possible and undiagnosable:

1. `setDefaultBrowserOpener` (`electron-entry.ts:45-50`) swallows `openExternal` rejections into `console.error`, which goes nowhere in a packaged app. A failed launch looks exactly like "nothing happened", and there is no log line either way.
2. Reachability is gated on the browser's egress IP matching the `/32` the **main process** detected via `checkip.amazonaws.com`. Since #672/#680 removed the world-open rule, any divergence between the app's egress and the browser's (browser VPN/proxy, corporate proxy, dual-WAN, the IP changing during the session) turns the page into a silent connect timeout. Before #672's infra apply, the world-open rule hid this.
3. Browse sessions are plain HTTP to a raw IP, with a password the operator copies by hand out of the modal.

There is also a latent renderer bug found on the way: `useFileManager`'s reactive poller only stays registered while `state === 'starting'` or a pending flag is set (`use-file-manager.hook.ts:122-136`). `fetchOnce` clears `pendingStart` on the first `running` read, so if that read arrives before the ENI's public IP resolves (`url` undefined), polling stops and the modal never shows a link until the operator closes and reopens it. It did not fire in today's session (the URL resolved on the first RUNNING read), but it produces exactly the same "nothing to click / nothing happens" symptom.

Which of (1)/(2) bit the operator today needs one observation they can make: whether a browser tab opens at all when the link is clicked. Both are removed by design if the browser lives in the app and the main process does all helper traffic itself.

Minimal stop-gap, independent of this change (a direct-PR bug fix, not part of this change): log `openExternal` success/failure through `logger` and surface a failure toast; keep polling while `running && !url`; show "Copy URL" next to the link so the operator can paste it into any browser.

## Decision chain

**Q1. Embed FileBrowser's own web UI, or build a native file browser in the renderer?**
Options weighed: (a) a `WebContentsView` (BrowserView is deprecated; `<webview>` is discouraged) showing FileBrowser's SPA; (b) a native renderer page backed by IPC, with desktop-main talking to the helper's REST API; (c) hybrid — native for core operations, embedded SPA as an "advanced" escape hatch.
→ **Chose (b).** Deciding factors:
- FileBrowser is archived with unfixed advisories. Option (a) puts unpatched, remotely served web content inside the operator console and makes its UI the product surface; (b) uses only a handful of REST endpoints we already speak (`FileBrowserClient`) and keeps the helper swappable.
- Secrets: (a) needs the SPA authenticated, which means either a JWT in the view's localStorage/cookie (seeded by main) or FileBrowser proxy auth via an injected header (anyone else reaching the port with that header is in). (b) keeps the credential in main and never needs to show it to anyone, which is stricter than today, where the plaintext password is rendered in the modal.
- A `WebContentsView` floats above the renderer DOM: app dialogs, toasts and dropdowns cannot draw over it, bounds must be synced from the renderer by IPC (DIP vs CSS px at non-1 zoom), and theme/keyboard/accessibility don't match the app.
- (b) is testable with the repo's existing seams: jsdom component/hook tests, the IPC `__test.mock` seam for Playwright, and the existing `fake-filebrowser-server`/`fake-filebrowser-client` for desktop-main.
- Cost of (b): it has to build the UI (listing, breadcrumbs, upload, download, new folder, rename, delete, and probably a small text editor). FileBrowser extras — image previews, search, share links, archive extraction — are dropped unless added later.
(c) was rejected for v1: it carries all of (a)'s security and z-order costs to serve a long tail. It can be revisited if operators miss a specific FileBrowser feature.

**Q2. How does traffic reach the helper?**
Options: the existing public IP plus app-managed operator `/32` and per-launch pinned TLS (built by #672 for uploads); a Caddy sidecar with a real cert; an SSM/ECS Exec port-forward tunnel (no public IP); a Lambda mounted on EFS as the file API (no helper task at all).
→ **Chose the existing public-IP + `/32` + pinned-TLS path, for browse sessions too.** Since the main process is now the only client, the "browser egress ≠ app egress" mismatch disappears: the IP checkip sees is the IP the requests come from. Browse sessions switch from plain HTTP to the TLS launch the upload path already uses (`buildTlsContainerSettings`), and the app verifies the pinned fingerprint on every request.
- Rejected tunnel: it needs the host `session-manager-plugin` binary, and the app deliberately avoids host-installed tools (it even ships its own Pulumi engine).
- Rejected Caddy/real cert: it needs DNS and ACME issuance per helper launch for a client that is only ever our own process, so pinning is strictly simpler and stronger.
- Lambda-on-EFS: genuinely attractive long-term (no public exposure, no 30–60 s cold start, no archived image, IAM-authenticated). But it is a VPC-attached Lambda per region with EFS mounts, IAM and an S3 hop for files over the 6 MB invoke payload — a separate infra change. Recorded as the follow-up target behind the backend interface (Q5), and raised as an open question.

**Q3. Helper lifecycle and cost.**
Keep on-demand `RunTask` per session (no ECS Service — invariant). Session starts when the operator opens the game's Files page and clicks **Start session**. Designer's default is an explicit click rather than auto-starting on page entry, because entering a page shouldn't silently bill or open a firewall hole; this is an open question. The 2 h EventBridge auto-stop stays as the hard backstop. New: the app stops the helper when the operator clicks **Stop**, when the Files page has been left and no upload holds the session (after a short grace period so quick navigation doesn't churn tasks), and on app quit (best-effort; the startup orphan sweep from #672 covers crashes). Cost is unchanged per hour (0.25 vCPU / 0.5 GB Fargate, roughly a cent an hour) and likely lower in practice because sessions end with the page instead of idling until someone remembers Stop.

**Q4. Upload interplay with #672.**
Today one helper per game is enforced, and upload refuses with `helper-open` when a browse session exists, "because the credential of that session is unknown here". Once browse sessions are also main-owned, that reason is gone. → Introduce a main-process **helper session registry** keyed by game, holding `{taskArn, ip, credentials, cert, client, holders}`. Browse and upload acquire and release it, and the helper stops when the last holder releases. Upload reuses an open browse session instead of refusing, and the Files page can launch the existing folder-upload flow into the current directory. A helper that exists in ECS but has no registry entry (app restarted, or left by an older build) is "orphaned": the app can't authenticate to it, so the UI offers **Restart session** (stop + start).

**Q5. Where does the FileBrowser dependency live?**
→ Behind a `VolumeFileBackend` interface in desktop-main (list, stat, read stream, write stream, mkdir, rename/move, delete, plus optional archive download). `FileBrowserClient` becomes its first implementation. The renderer and IPC contract never mention FileBrowser. This also bounds the work of moving off the archived image: pin the image to the final `v2.63.23` digest now, and swap the backend later (maintained fork, a minimal purpose-built helper, or Lambda-on-EFS) without touching UI or IPC.

**Q6. UI shape.**
→ A routed page `/games/:name/files` (not a modal — file browsing needs room), reachable from the dashboard card's Files button and the game detail page. It has a session bar (state, start/stop, auto-stop countdown), breadcrumb path, a sortable table (name, size, modified), and actions: Upload files, Upload folder (reuses #672's engine and progress meter), New folder, Download (native save dialog, streamed by main), Rename, Delete (confirm dialog, recursive for folders, with a count). There is a text view/edit for small UTF-8 files (designer's cap: 1 MiB) with a write-conflict check on modified time. Drag-and-drop from the OS uses the preload's `webUtils.getPathForFile` (Electron ≥ 32 removed `File.path`).

**Q7. Running game server.**
EFS allows concurrent access, so browsing (read) while the server runs is safe. Writes underneath a live server can corrupt saves. → Read-only while the game server is RUNNING/STARTING: mutating actions are disabled with an explanation. Upload already requires the server stopped (#672). Open question whether the operator wants an override.

**Q8. Security posture.**
- No remote content in any WebContents. `webviewTag` stays off, and the renderer gets only typed IPC results (names, sizes, mtimes), never URLs, tokens or credentials.
- Remove `credentials` from `FileMgrResult` / the IPC surface entirely.
- desktop-main normalizes and validates every path (POSIX, rooted at the volume, rejects `..` segments and NUL bytes) before it reaches the backend.
- The pinned-cert check covers every request, and the client refuses to send the credential on fingerprint mismatch (already true of `FileBrowserClient`).
- Hardening on the side: add a `will-navigate` deny on the main window, and give `setDefaultBrowserOpener` an allowlist of known external hosts (AWS console, GitHub releases, Discord docs) so it can't be used to open arbitrary URLs. This lands in the stop-gap PR, not this change.

**Q9. Downloads.**
Main streams `GET /api/raw/<path>` to the path chosen in `dialog.showSaveDialog`, with progress events. Folders download as a zip via FileBrowser's `?algo=zip`, exposed as an optional backend capability so a future backend can omit it. A download is cancellable, and a partial file is deleted on cancel/failure.

**Q10. Rollout / migration.**
The external-browser path is removed once the in-app page ships. There's no data migration: there is no persisted browse state, and folder-upload state keys stay as they are. No infra or IAM change is needed — the same ECS/EC2/Scheduler calls are made, and TLS for browse is container args only. `add-folder-volume-upload` should be archived first so its spec exists in `openspec/specs/` for this change's delta to modify.

## Trade-offs accepted

- More renderer code than an embed, in exchange for no unpatched remote UI inside the app, no secrets in the renderer, a consistent UI and testability.
- Losing FileBrowser niceties (previews, search, shares) in v1.
- The ~30–60 s helper cold start remains. Only the Lambda backend would remove it.
- An orphaned helper (after an app restart) must be restarted rather than resumed, because credentials are never persisted.
