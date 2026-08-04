---
title: Guides
sidebar_position: 1
---

# Guides

Role-oriented walkthroughs for the three people most likely to open this site:

- **[User guide](/guides/user)** — day-to-day operation
  of a provisioned stack: starting/stopping servers from the dashboard or
  Discord, reading the cost panel, tailing logs.
- **[Maintainer guide](/guides/maintainer)** — working
  on the code: monorepo layout, tests, lint, CI, release/deploy mechanics,
  load-bearing invariants not to break.
- **[Submodule guide](/guides/submodule)** — running
  the stack from source with a pinned upstream version: wrap this repo as a
  git submodule inside a private parent repo. Not a secrets-storage pattern
  any more — AWS credentials, Discord secrets, and your game configuration
  all live outside the repo. Includes an interactive scaffolder that
  generates the wrapper Makefile for you.

The [Setup guide](/setup) is still the first stop if
none of the above has happened yet.
