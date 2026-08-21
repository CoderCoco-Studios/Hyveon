---
globs: "**/*.ts,**/*.tsx"
---

# TypeScript Coding Conventions

## Doc coverage and env access are non-negotiable, not code-review nits

1. **TSDoc on every non-trivial function, class, interface, and notable
   constant.** Format and tag rules live in `tsdoc-tags.md` — this rule is the
   "must have one," that rule is the "must be shaped correctly." Trivial
   getters/setters/wrappers still need a one-line summary; see
   `comment-conciseness.md` for how much detail scales with what the function
   actually does.
2. **No raw `process.env` in business logic.** Wrap env access behind a
   service method so tests can stub it with `vi.spyOn` instead of mutating
   `process.env` directly.

**Why:** wrapping env access is what makes rule 2 testable without global
mutation — a service method is stubbable per test, `process.env` is shared
global state that leaks between tests and hides which config a piece of logic
actually depends on.
