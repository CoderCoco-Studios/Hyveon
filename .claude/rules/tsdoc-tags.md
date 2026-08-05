# TSDoc Tag Structure

## All TypeScript doc comments must follow the TSDoc tag spec, not ad hoc JSDoc

Every `/** ... */` comment on TypeScript code — functions, classes, interfaces,
notable constants, test-file helpers (per `CLAUDE.md`'s TSDoc convention) —
must use only tags and structure defined by the
[TSDoc specification](https://tsdoc.org/), not free-form JSDoc conventions
that happen to look similar.

**Why:** this repo enforces TSDoc syntax at lint time within `app/`
(`app/eslint.config.js`'s `tsdoc/syntax: 'error'`, backed by
`eslint-plugin-tsdoc` in `app/package.json`) precisely because malformed or
non-standard tags silently produce garbage in generated docs and editor
tooltips instead of failing loudly. A comment that passes casual review but
uses invalid tag names or ordering still fails `npm run app:lint`.

**How to apply:**

- **Structure, in order (this repo's convention — TSDoc itself doesn't
  mandate an order):** summary paragraph, then `@remarks`, then `@example`
  block(s), then one `@typeParam` per type parameter, then one `@param` per
  parameter (in declaration order), then `@returns`, then `@throws`. Don't
  interleave — e.g. a `@param` after `@returns`. Modifier tags (below) go
  last, on their own line(s) at the bottom of the comment.
- **Block tags** — `@param`, `@returns`, `@throws`, `@typeParam`,
  `@remarks`, `@example`, `@defaultValue`, `@see`, `@privateRemarks`.
  **Modifier tags** — `@deprecated`, `@override`, `@sealed`, `@virtual`,
  `@internal`, `@alpha`, `@beta`, `@public`. Do not invent project-specific
  tags (`@note`, `@warning`, etc.) — fold that content into the summary or
  `@remarks` instead.
  - **`@packageDocumentation`** marks a package's entry-point file only —
    it must be the first comment in that file. Don't use it for per-module
    summaries elsewhere; use a plain top-of-file comment instead.
  - **Never use `@fileoverview`** — it's a Closure Compiler tag, not TSDoc;
    a module-level summary outside the entry point belongs in a plain
    top-of-file comment.
- **Inline tags use the `{@tag ...}` curly-brace form** — `{@link Symbol}`,
  `{@label name}`, `{@inheritDoc Symbol}` — never the bare `@link Symbol`
  block-tag form; TSDoc treats `{@link}` as an inline tag only.
- **`@param` syntax is `@param name - description`** (hyphen separator,
  exactly as this repo's existing TSDoc comments already do) — not
  `@param {Type} name` (that's JSDoc's inline-type-annotation form, which
  TSDoc's parser rejects since TypeScript's own type already provides the
  type).
- **Run `npm run app:lint`** after writing or editing any TSDoc comment —
  `tsdoc/syntax` is the authoritative check; don't rely on the comment
  merely "looking right."
- Applies repo-wide: `app/`, `@hyveon/shared`, `@hyveon/cloud-aws`,
  `@hyveon/desktop-main`, `@hyveon/desktop-preload`, `@hyveon/infra`,
  `@hyveon/web`, and the Lambda packages.
