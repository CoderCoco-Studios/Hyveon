# TSDoc Tag Structure

## All TypeScript doc comments must follow the TSDoc tag spec, not ad hoc JSDoc

Every `/** ... */` comment on TypeScript code — functions, classes, interfaces,
notable constants, test-file helpers (per `CLAUDE.md`'s TSDoc convention) —
must use only tags and structure defined by the
[TSDoc specification](https://tsdoc.org/), not free-form JSDoc conventions
that happen to look similar.

**Why:** this repo already enforces TSDoc syntax at lint time
(`app/eslint.config.js`'s `tsdoc/syntax: 'error'`, backed by
`eslint-plugin-tsdoc` in `app/package.json`) precisely because malformed or
non-standard tags silently produce garbage in generated docs and editor
tooltips instead of failing loudly. A comment that passes casual review but
uses invalid tag names or ordering still fails `npm run app:lint`.

**How to apply:**

- **Structure, in order:** summary paragraph, then `@remarks`, then
  `@example` block(s), then one `@param` per parameter (in declaration
  order), then `@returns`, then `@throws`. Don't interleave — e.g. a
  `@param` after `@returns`.
- **Only standard TSDoc block tags** — `@param`, `@returns`, `@throws`,
  `@typeParam`, `@remarks`, `@example`, `@defaultValue`, `@deprecated`,
  `@see`, `@privateRemarks`, `@override`, `@sealed`, `@virtual`,
  `@internal`, `@alpha`, `@beta`, `@public`, `@packageDocumentation`. Do not
  invent project-specific tags (`@note`, `@warning`, etc.) — fold that
  content into the summary or `@remarks` instead.
  - **Never use `@fileoverview`** — it's a Closure Compiler tag, not TSDoc;
    the module-level summary belongs in `@packageDocumentation` or a plain
    top-of-file comment instead.
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
  `@hyveon/web`, the Lambda packages, and `@hyveon/scripts`.
