---
title: Components
sidebar_position: 1
---

# Components

Deep-dives on each piece of the stack, for when the guides hand-wave past
something:

- **[Terraform](/components/terraform)** — every
  `.tf` file, variables, outputs, and AWS services touched.
- **[Management app](/components/management-app)** —
  the Nest.js API, React dashboard, and `@hyveon/shared` library.
- **[Lambdas](/components/lambdas)** — the five
  Node.js Lambdas (interactions, followup, update-dns, watchdog, efs-seeder).
- **[Integration tests](/components/integration-tests)** —
  the tier-2 Playwright suite that dispatches directly into the Nest.js DI
  container.

For the big picture, start at the
[architecture overview](/architecture).
