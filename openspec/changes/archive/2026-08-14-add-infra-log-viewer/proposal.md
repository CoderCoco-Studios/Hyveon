## Why

The operator app's `/logs` page only tails ECS game-server CloudWatch logs; the 5
Lambda packages (watchdog, health-check, dns-updater, interactions, followup) have no
in-app log viewer at all, despite `docs/docs/app/logs.md` already documenting this gap.
Debugging a watchdog idle-shutdown decision or a Discord interaction failure currently
requires leaving the app for the AWS CloudWatch console. Since every Lambda's log group
is already deterministically named and provisioned by `app/packages/infra/src/lambdas.ts`,
this is a pure read/display addition with no infra changes.

## What Changes

**Sidebar navigation**
- From: a single flat `Logs` entry in the Monitoring section, linking to `/logs`.
- To: a `Logs` group (always expanded, no collapse interaction) with two children:
  `Game Logs` (`/logs`, unchanged) and `Infra Logs` (`/logs/infrastructure`, new).
- Reason: separates the two log domains (per-game workload tail vs. infra/Lambda tail)
  without adding generic collapsible-nav plumbing for a two-item case.
- Impact: non-breaking. `/logs` URL and behavior unchanged.

**Lambda log viewing**
- From: no way to view Lambda logs in-app.
- To: a new `/logs/infrastructure` page with a function-picker (watchdog, health-check,
  dns-updater, interactions, followup) and the same live-tail UX as the existing game
  logs page, backed by two new `LogsService` methods and two new IPC channels.
- Reason: closes the documented gap; reuses the existing CloudWatch Logs
  polling/streaming pattern instead of inventing a new one.
- Impact: non-breaking addition. No changes to `CloudProvider`'s cloud-agnostic
  interface or to Pulumi-provisioned resources.

## Capabilities

### New Capabilities
- `infra-log-viewer`: viewing recent and live-tailed CloudWatch logs for the app's 5
  Lambda functions (watchdog, health-check, dns-updater, interactions, followup) from a
  dedicated `/logs/infrastructure` page, reached via a nested `Logs` sidebar group.

### Modified Capabilities
(none — the existing game-server logs behavior is unchanged; only the sidebar's visual
grouping changes, which is a navigation/UI structure change, not a requirement change to
an existing spec'd capability)

## Impact

- **Affected code**: `app/packages/desktop-main/src/services/LogsService.ts` (new
  methods), its controller (new `@MessagePattern`s), `desktop-preload` bridge (new
  exposed channels), `app/packages/web/src/components/app-layout.component.tsx` (nav),
  a new routed page + page object under `app/packages/web/src`.
- **Affected docs**: `docs/docs/app/logs.md` (currently states Lambda logs are *not*
  shown in-app — must be updated), `docs/docs/components/management-app.md` if it
  enumerates routes/IPC channels.
- **No infra/Pulumi changes**: all 5 log groups already exist and are deterministically
  named; this change only reads from them.
- **No new dependencies**: reuses the existing `@aws-sdk/client-cloudwatch-logs` client
  already in `LogsService`.
