# Overhaul the documentation site and close the UI gaps it exposes

## Why

The docs site has drifted badly behind the codebase. Three migrations landed without a
documentation pass: the ALB/ACM removal (HTTPS now terminates in an in-task Caddy sidecar), the
HTTP-server removal (the app is Electron-IPC-only), and the `GameServerDeploy → Hyveon` rename.
The result is documentation that is not merely incomplete but actively wrong — `guides/user.md`
tells operators the watchdog cleans up DNS records (it never touches Route 53),
`guides/maintainer.md` documents a `terraform/aws/alb.tf` that does not exist, and all five
committed architecture SVGs still draw an ALB and a bearer-token arrow.

At the same time the app grew an entire operator surface that is documented nowhere: an
eleven-route UI with a five-step first-run wizard, an in-app Terraform plan/apply/destroy
pipeline with run history and rollback, game CRUD that rewrites `terraform.tfvars`, drift
detection, and an audit log. Docs still describe a "six-panel dashboard" and instruct operators
to hand-edit `terraform.tfvars`.

Writing that missing app documentation surfaced five UI defects that cannot be documented
honestly — the Costs page has no navigation entry and is reachable only by typing a URL, the
GameCard "Logs" button navigates to a page that ignores which game you clicked, and the top bar
shows a `⌘K` search box wired to nothing. Documenting these as-is would ship a user guide whose
main job is apologising for the product. They are fixed here so the docs can describe behaviour
worth describing.

## What Changes

### Documentation — new "Using the app" section

- Add `docs/docs/app/` with an index (guided tour + navigation map) and one page per screen:
  first-run wizard, dashboard, games, terraform, discord, logs, costs, audit, settings.
- Each page documents what the operator sees, every action available, empty/loading/error
  states, and embeds screenshots of the real app.
- Shrink `docs/docs/guides/user.md` to player-facing and Discord slash-command usage; it links
  into the new section instead of duplicating it.

### Documentation — screenshot harness

- Add a committed Playwright screenshot harness that launches the **real Electron app** with
  deterministic mocked IPC and writes PNGs into `docs/static/img/app/`.
- Screenshots become reproducible: re-running the harness refreshes every image after a UI
  change, instead of images rotting silently.
- Delete the orphaned `docs/screenshots/issue-70/` PNGs — outside `static/`, referenced by
  nothing, and stale.

### Documentation — accuracy sweep

- Fix the D2 diagram sources and regenerate the committed SVGs: remove ALB/ACM, remove the
  bearer-token arrow, remove the watchdog→Route 53/ALB cleanup arrows, drop Docker-era phrasing.
- Rewrite `docs/diagrams/README.md`, which still documents a Jekyll pipeline and a
  `jekyll-gh-pages.yml` workflow that no longer exist.
- Correct every stale count and reference found in the audit: four Lambdas → five, sixteen
  module inputs → seventeen, three CI workflows → seven, Node 20+ → 22.12+, missing repo-map
  entries, the non-existent `alb.tf`, and the ALB exception in maintainer Invariant 3.
- Document the previously-undocumented subsystems: first-run wizard, in-app Terraform pipeline,
  UI game CRUD, drift detection, audit log, the cloud-provider abstraction, the
  `@hyveon/desktop-preload` package, the `efs-seeder` Lambda, ElectronStore/SafeStorage,
  `TfvarsModule`, and the full CI workflow set.
- **BREAKING (CI)**: flip `onBrokenLinks` from `warn` to `throw` so the docs build fails on a
  dead link instead of silently shipping one. Any remaining broken link will break `docs-build`
  until fixed.

### Application — close the gaps the docs exposed

- Add **Costs** to the sidebar navigation. It is currently unreachable except by URL.
- Make the GameCard **Logs** button preselect the game it was clicked from. It already passes
  `location.state`; the Logs page never reads it.
- Remove the non-functional `Search… ⌘K` placeholder from the top bar.
- Remove the three permanently-disabled sidebar placeholders (Servers, Metrics, Alerts).
- Remove the hardcoded `Players —` stat from the GameCard. A real player count requires per-game
  server-protocol queries (Minecraft ping, Steam A2S, …); that is a feature and is explicitly
  **out of scope** here — it is tracked separately.

### Application — repair streamed IPC across the context bridge

Building the screenshot harness surfaced a production defect that had to be fixed before the
documentation could describe reality. The preload exposed its streaming helpers as `async function*`
directly through `contextBridge`. An `AsyncGenerator` is neither structured-cloneable nor proxied by
the bridge, so **every streaming call threw `An object could not be cloned` synchronously, before
any IPC was sent**. A second, independent break in the same path: an `AbortSignal` passed across the
bridge arrives with its prototype stripped, so `signal.addEventListener` throws — and all three
callers passed one.

The user-visible consequences were significant:

- The first-run wizard's `terraform init` step **never ran**, going straight to a failure state with
  a Retry button that could never succeed — a new operator could not finish setup.
- The Logs page's live tail was dead and displayed the raw clone error to the user.
- The Terraform page's live run output was silently empty, because a bare `catch {}` swallowed the
  failure.

The fix keeps the generators preload-internal and exposes a bridge-safe handle
(`{ next, cancel, [Symbol.asyncIterator] }`), moves cancellation to a `cancel()` function instead of
a bridged `AbortSignal`, and adds an Electron regression spec that drives the real, unmocked bridge —
the only tier that can catch this class of defect, since every existing test stubbed across no
serialization boundary.

## Capabilities

### New Capabilities

- `operator-documentation`: The documentation site's coverage contract — which operator-facing
  screens and workflows must be documented, what each page must contain, and the accuracy
  guarantees (no references to removed infrastructure, counts match the codebase, the build
  fails on broken links).
- `docs-screenshot-capture`: The reproducible screenshot harness — how images are captured from
  the real Electron shell with deterministic seeded data, where they are written, and the
  determinism requirements that keep re-runs from producing spurious diffs.

### Modified Capabilities

- `desktop-only-operator-surface`: Navigation requirements change — every routed page must be
  reachable from the sidebar (adds Costs), and the sidebar must not advertise controls that do
  nothing (removes the disabled Servers/Metrics/Alerts entries and the dead `⌘K` search box).

## Impact

**Documentation**

- New: `docs/docs/app/` (10 pages + `_category_.json`), `docs/static/img/app/*.png`.
- Rewritten: `docs/diagrams/README.md`, `docs/docs/guides/user.md`.
- Edited: `docs/docs/intro.md`, `setup.md`, `architecture.md`, `components/index.md`,
  `components/lambdas.md`, `components/terraform.md`, `components/management-app.md`,
  `components/integration-tests.md`, `guides/maintainer.md`, `docs/docusaurus.config.ts`.
- Regenerated: `docs/static/diagrams/*.svg` from edited `docs/diagrams/*.d2`.
- Deleted: `docs/screenshots/issue-70/`.

**Application code**

- `app/packages/web/src/components/app-layout.component.tsx` — nav items, top-bar search removal.
- `app/packages/web/src/components/game-card.component.tsx` — Players stat removal.
- `app/packages/web/src/pages/logs.page.tsx` — read `location.state` for the preselected game.
- Co-located unit tests for each of the above.

**Test tooling**

- New: `app/packages/web/playwright.screenshots.config.ts`,
  `app/packages/web/e2e/screenshots/{capture.spec.ts,demo-data.ts}`.
- Edited: e2e specs and page objects that assert on the removed sidebar entries, the removed
  search box, or the removed Players stat.

**CI**

- `docs-build.yml` and `docusaurus-gh-pages.yml` become failure-sensitive to broken links.
- The screenshot harness is deliberately **not** added to CI in this change; it is a
  maintainer-run command.

**Dependencies**

- None added. The harness reuses the existing Playwright 1.59 install, the existing Electron
  binary, and the existing `window.hyveon.__test.mock` preload seam.
