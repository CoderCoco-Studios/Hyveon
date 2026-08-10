# TSDoc Tags

## TypeScript doc comments follow the TSDoc spec, not ad hoc JSDoc

Applies to: functions, classes, interfaces, notable constants, test-helper comments; repo-wide (`app/`, all `@hyveon/*` packages, Lambda packages).

1. **Order:** summary → `@remarks` → `@example` → `@typeParam` (one per type param) → `@param` (one per param, declaration order) → `@returns` → `@throws` → modifier tags last. Don't interleave.
2. **Block tags:** `@param`, `@returns`, `@throws`, `@typeParam`, `@remarks`, `@example`, `@defaultValue`, `@see`, `@privateRemarks`. **Modifiers:** `@deprecated`, `@override`, `@sealed`, `@virtual`, `@internal`, `@alpha`, `@beta`, `@public`. No invented tags (`@note`, `@warning`) — fold into the summary or `@remarks`.
3. `@packageDocumentation` only on a package's entry-point file, as the first comment. Never `@fileoverview` (that's Closure Compiler, not TSDoc) — use a plain top-of-file comment for module summaries elsewhere.
4. Inline tags use `{@tag ...}` — `{@link Symbol}`, never bare `@link Symbol`.
5. `@param name - description` (hyphen separator), never `@param {Type} name` (JSDoc's inline-type form — TS already types it).
6. Run `npm run app:lint` after any TSDoc edit — `tsdoc/syntax` catches malformed tags, but nothing lint-enforces tag ordering, modifier placement, or `@param` style; those are review-enforced, don't eyeball them either.

**Why:** `tsdoc/syntax: 'error'` is enforced at lint time — a plausible-looking but invalid tag fails `npm run app:lint` and silently corrupts generated docs/tooltips otherwise.
