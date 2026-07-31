---
title: Components
sidebar_position: 1
---

# Components

Deep-dives on each piece of the stack, for when the guides hand-wave past
something:

- **[Infra program](/components/infra)** — the Pulumi
  Automation API program: every file, resource, and AWS service touched.
- **[Management app](/components/management-app)** —
  the Nest.js API, React dashboard, and `@hyveon/shared` library.
- **[Lambdas](/components/lambdas)** — five Node.js
  Lambda packages: four always-on (interactions, followup, update-dns,
  watchdog) plus a conditional, per-game `efs-seeder`.
- **[Integration tests](/components/integration-tests)** —
  the tier-2 Playwright suite that dispatches directly into the Nest.js DI
  container.

For the big picture, start at the
[architecture overview](/architecture).
