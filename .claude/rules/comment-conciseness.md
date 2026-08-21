---
globs: "**/*.ts,**/*.tsx"
---

# Comment Conciseness

## Comments stay short, single-line, and at the right altitude

1. Default to no comment. Only add one when the WHY is non-obvious — a hidden
   constraint, a subtle invariant, a workaround for a specific bug, behavior
   that would surprise a reader. Well-named identifiers already say what the
   code does; don't restate that.
2. Explanatory prose about a function's purpose, contract, or behavior belongs
   in the TSDoc block above the method/function/class (see `tsdoc-tags.md`),
   not scattered as inline comments through the body. If a comment explains
   what the whole function does, move it to the doc comment and delete the
   inline version.
3. Inline comments are a single line. If an explanation needs more than one
   line, either it belongs in the TSDoc block instead, or it's a sign the code
   itself needs simplifying rather than annotating.
4. Wrap comment and TSDoc prose at ~120 characters, not ~80. Don't hand-wrap
   short lines just to hit an old 80-column habit.
5. This rule governs brevity and placement, not whether a public function gets
   documented — `tsdoc-tags.md` still requires TSDoc on every non-trivial
   function, class, interface, and notable constant, and that requirement
   isn't satisfied by a one-line summary if the function actually needs more.
   Scale the TSDoc block to what the function does:
   - A one-line setter/getter/trivial wrapper gets a one-line summary. Don't
     pad it with `@remarks`, `@example`, or restated `@param` prose it doesn't
     need.
   - A function with real logic — multiple failure modes, non-obvious
     preconditions, a non-trivial contract — gets whatever `@remarks`,
     `@example`, `@param`, `@returns`, `@throws` detail a caller actually
     needs to use it correctly without reading the body. Terseness never
     excuses cutting real documentation down to a stub.

**Why:** inline comments accumulate faster than they're pruned and drift from
the code they describe; a TSDoc block at the method signature is the one place
future readers and tooltips actually look. Confirmed 2026-08-21 after repeated
overcommenting in generated code — see `feedback-comment-verbosity.md` for the
prior PR #370 cleanup this extends.
