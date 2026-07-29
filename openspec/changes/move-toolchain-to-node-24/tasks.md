## 1. Docusaurus upgrade

- [x] 1.1 Upgrade `@docusaurus/core`, `@docusaurus/preset-classic`, and `@docusaurus/theme-mermaid` to latest via `npm install <pkg>@latest` in `docs/`
- [x] 1.2 Upgrade `@docusaurus/module-type-aliases`, `@docusaurus/tsconfig`, and `@docusaurus/types` to latest as dev dependencies
- [x] 1.3 Restore exact version pins (`3.10.2`, no caret) with `npm pkg set` and re-run `npm install` so `docs/package-lock.json` matches

## 2. Node 24 pins

- [x] 2.1 Change `node-version: 20` to `'24'` in `.github/workflows/docs-build.yml`
- [x] 2.2 Change `node-version: 20` to `'24'` in `.github/workflows/docusaurus-gh-pages.yml`
- [x] 2.3 Raise `engines.node` to `>=24.0.0` in the root `package.json` (was `>=22.12.0`)
- [x] 2.4 Raise `engines.node` to `>=24.0.0` in `docs/package.json` (was `>=18.0`)
- [x] 2.5 Raise `engines.node` to `>=24.0.0` in `scripts/package.json` (was `>=20`)

## 3. Documentation

- [x] 3.1 Update the Node.js row of the prerequisites table in `docs/docs/setup.md` to require 24+, and rewrite the note so it no longer contrasts the `engines` floor with what CI runs; check the adjacent npm row while there
- [x] 3.2 Change both docs-workflow entries in `docs/docs/guides/maintainer.md` from "Node 20" to "Node 24"
- [x] 3.3 Update `docs/docs/guides/submodule.md`: the prose stating Node.js 22.12+, and the example workflow's `node-version: 22`
- [x] 3.4 Grep the repo for any remaining statement of a toolchain Node version that still disagrees (excluding Lambda runtimes and esbuild targets, which stay on node20 by design)

## 4. Verification

- [x] 4.1 On Node 24, run `rm -rf node_modules .docusaurus build && npm ci && npm run build` in `docs/` and confirm `[SUCCESS] Generated static files`
- [x] 4.2 Serve the built site and confirm the navbar logo renders and the architecture SVG diagrams keep `max-width: 100%` plus the dark-mode invert filter
- [x] 4.3 Spot-check a mermaid-rendering page and a screenshot page in the running site — `@docusaurus/theme-mermaid` moved four minors and is the most likely regression
- [x] 4.4 Run `npm install --dry-run` at the repo root on Node 24 and confirm no `EBADENGINE` warnings from the new floor
- [x] 4.5 Confirm `terraform/aws/*.tf` still declare `runtime = "nodejs20.x"` and the five `app/packages/lambda/*/esbuild.config.mjs` still target `node20` — this change must not touch them

## 5. Ship

- [x] 5.1 Commit and push `chore/node-24-toolchain`, open a PR titled `chore: move the toolchain to Node 24 and Docusaurus 3.10.2`
- [x] 5.2 Confirm `docs-build.yml` passes on the PR, now running Node 24 against the regenerated lockfile
- [x] 5.3 After merge, confirm `docusaurus-gh-pages.yml` publishes the live site successfully
