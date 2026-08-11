## Why

The declarative HTTP health check introduced by `add-pluggable-health-checks` answers one
shape of question: issue a request, compare one value in the JSON response. That covers the
management APIs of games that expose a player count or a metrics endpoint, and it covers
them without executing any operator-authored code.

It does not cover a game whose liveness answer requires more than one comparison, a
non-JSON response, a binary or line-oriented protocol such as RCON, a two-step exchange
(authenticate, then query), or arithmetic on the response. Today the only route to
supporting such a game is a code change, a release, and a redeploy — which puts the operator
of a self-hosted deployment in the position of waiting on this project to support the game
they are already running.

This change proposes closing that gap by letting an operator author the check themselves,
and it exists as a separate proposal because doing so introduces something the system has
never had: execution of operator-supplied code inside the deployment's own trust boundary.
That is a security decision that deserves its own scrutiny rather than arriving as an
extension of a shipped feature.

## What Changes

- Add a second health-check kind, `script`, alongside the existing `http` kind. The `kind`
  discriminator already exists for this purpose, so no existing configuration changes shape.
- A `script` check carries operator-authored source, the port it may reach, an optional
  credential reference, and a timeout. The script receives a constrained request capability
  and the check context, and returns the same `{ active, reason }` verdict every other kind
  returns.
- Execute that source in an isolated interpreter inside the existing health-check Lambda —
  not the Lambda's own JavaScript context. The script must not be able to reach the
  Lambda's environment variables, its execution role's credentials, the filesystem, the
  instance metadata endpoint, or any host other than the game task being checked.
- Bound execution: wall-clock timeout, memory ceiling, and a cap on outbound requests, all
  enforced by the host rather than by cooperation from the script.
- Preserve fail-active. A script that throws, times out, exceeds a limit, or returns
  something that is not a valid verdict reports the server as active, exactly as a failed
  declarative check does.
- Surface script authoring in the operator interface with the security posture stated at
  the point of authoring, and record in the audit trail who changed a script and when —
  editing a script is editing code that will run against the deployment's own network.
- **BREAKING** for no one: `script` is additive. A deployment that declares no `script`
  check is unaffected, and a deployment that declares one opts into the execution surface
  knowingly.

## Capabilities

### New Capabilities

- `scripted-health-checks`: The operator-authored health-check kind — what a script
  receives and must return, the isolation boundary it executes within, the resource limits
  the host enforces, the failure semantics, and the authoring and audit surface around it.

### Modified Capabilities

- `game-health-checks`: The capability currently admits exactly one kind and states that a
  health check executes no operator-supplied code. Admitting a second kind changes the
  requirement describing the kind discriminator, and the requirement confining what the
  health-checking component may reach must account for a caller whose destination is
  chosen at runtime by a script rather than fixed by static configuration.

## Impact

- **`@hyveon/shared`** — `GameServerHealthCheck` becomes a discriminated union over `kind`;
  the validator gains the `script` member's structural rules and its business rules.
- **`@hyveon/lambda-health-check`** — a second execution path alongside the declarative
  engine, plus the sandbox host: interpreter setup, the capability object handed to the
  script, and limit enforcement.
- **New dependency** — an isolation runtime capable of executing untrusted source with
  enforced memory and wall-clock limits and no ambient host access. Selecting it, and
  confirming it can be bundled into a Lambda, is a design decision this change must resolve
  rather than assume.
- **`app/packages/infra`** — no new resource kinds, but the health-check function's memory,
  timeout, and network posture must accommodate script execution.
- **`@hyveon/web`** — a script authoring surface in the add/edit-game wizard.
- **Documentation** — the security posture of running operator code, stated plainly enough
  that an operator can decide whether they want it.
- **Depends on** `add-pluggable-health-checks`. This change extends the framework, the
  Lambda, and the configuration shape that change introduces, and cannot be implemented
  before it lands.
