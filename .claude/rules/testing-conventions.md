---
globs: "**/*.spec.ts,**/*.spec.tsx,**/*.test.ts,**/*.test.tsx,**/e2e/**/*.ts"
---

# Testing Conventions

Everything in `typescript-conventions.md` still applies to test files — this
adds constraints specific to writing and structuring tests.

## Naming and typing

1. **Test names read as sentences starting with "should"** —
   `it('should return null when state file is missing')`, not
   `it('returns null…')`.
2. **No `as unknown as T` casts.** Prefer `vi.mocked(fn)` for mocked modules
   and `Partial<T>` + a single `as T` for service-shaped stubs.
3. **TSDoc on test-file helpers** (stub factories, fixtures) — same bar as
   production code, per `tsdoc-tags.md` and `typescript-conventions.md`.

**Why (2):** a double cast (`as unknown as T`) defeats the type checker
entirely — `vi.mocked`/`Partial<T> + as T` keep the compiler checking the
shape actually matches, so a refactor that changes a mocked interface fails
the build instead of failing silently at runtime.

## Test tiers

Three complementary tiers — pick based on what changed, not by default:

| Tier | Command | What runs |
|------|---------|-----------|
| Unit / component | `npm run app:test` | Vitest, split into a `node` project and a jsdom `web` project. Server logic runs under `node`; `@hyveon/web` component and routed-page specs run under `jsdom`, co-located with the component and mounted through `renderPage()`. AWS SDK mocked via `aws-sdk-client-mock`. |
| E2E (tier 1) | `npm run app:test:e2e` | Playwright, two projects: `electron` launches the packaged app via `_electron.launch()` with `HYVEON_TEST_MODE=1`; `chromium` runs the remaining stub-based specs against `vite build` + `vite preview`. Migration to `electron` is in progress. |
| Integration (tier 2) | `npm run app:test:integration` | Playwright dispatching into the real `AppModule` DI container built in-process — no HTTP server, no Vite, no `BrowserWindow`. |

## Playwright conventions

1. Specs live in `app/packages/web/e2e/specs/`, fixtures in `e2e/fixtures/`,
   page objects in `e2e/pages/`. Import `test`, `expect`, and page-object
   fixtures from `../fixtures/index.js`.
2. **Specs must reach elements through a page object**
   (`logs.pauseButton()`, `dashboard.gameCardHeading('minecraft')`), never
   `page.getByX(...)` directly. Add a page object whenever a spec needs a
   locator that isn't wrapped yet.
3. Tier-2 specs live in `e2e/integration-specs/` and import
   `{ test, expect }` from `./index.js` (not `@playwright/test`) so they get
   the `ipc` and `serverMocks` fixtures.
4. The `window.hyveon.__test.mock()` seam and the two mock surfaces are
   documented in `docs/docs/components/integration-tests.md` — read it before
   adding a spec that needs a new mock.

## jsdom conventions

The two Vitest projects, `renderPage()`, `toStreamHandleMock()`, and which API
methods a page spec must stub or it hangs, are documented in
`docs/docs/components/integration-tests.md`. Read it before adding a
`@hyveon/web` component or routed-page spec.
