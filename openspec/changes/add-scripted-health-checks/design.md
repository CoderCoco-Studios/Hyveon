## Context

See `proposal.md` — Why. This change is only implementable on top of
`add-pluggable-health-checks`, which introduces the `healthCheck` field, its `kind`
discriminator, the conditionally provisioned health-check Lambda, its VPC placement and
security-group rules, and the fail-active contract. The constraints that shape this design
are therefore that change's decisions plus the following:

- Lambda bundles in this repo are produced by esbuild into a single CommonJS
  `dist/handler.cjs`, with only `@aws-sdk/*` marked external. Anything the handler depends on
  is bundled into that file.
- The health-check Lambda's destination host is resolved from the ECS task attachment, not
  from configuration. Preserving that property when the caller is a script is the central
  security problem this change has to solve.
- Secrets are referenced by ARN and fetched at execution time; they are never persisted in
  configuration and never sent to the renderer.
- The repo has an audit trail that operator-facing configuration changes are recorded in.

## Goals / Non-Goals

**Goals:**

- Let an operator support a game this project has no knowledge of, without a code change or
  a release.
- Contain operator-authored source so that its worst case does not extend beyond the game it
  checks: no access to the deployment's credentials, network, or other games' checks. This
  containment does not extend to the game task being checked itself — see the request-
  capability decision below, which states that boundary plainly.
- Keep every failure fail-active, identically to the declarative kind.
- Keep the isolation boundary enforced by the host, so that its correctness does not depend
  on predicting what a script might attempt.

**Non-Goals:**

- A general-purpose plugin or extension system. This is a sandbox for one function with one
  signature returning one shape.
- Letting scripts persist state, schedule work, call AWS APIs, or reach anything other than
  the task being checked.
- Sharing scripts between deployments, or any registry, marketplace, or distribution
  mechanism for them.
- Replacing the declarative kind. A check expressible declaratively should stay declarative;
  the declarative path executes no operator code and is the one to prefer.

## Decisions

### QuickJS compiled to WebAssembly, not a Node isolate

The isolation runtime is the decision this change turns on. Two families were considered.

`isolated-vm` (7.0.1) creates genuine V8 isolates with memory limits and no shared context.
It is the strongest option semantically, but it is a native addon: it cannot be bundled by
esbuild into `handler.cjs`, and shipping it into Lambda means a layer or a container image
built against the exact runtime's ABI, tracked across every Node major bump the
`lambda-runtime-currency` capability mandates. That is a permanent build-and-release burden
attached to an optional feature.

`quickjs-emscripten` (0.32.0) is QuickJS compiled to WebAssembly. It is pure WASM with a
JavaScript host API, so it bundles like any other dependency and is indifferent to the Node
version underneath. It provides exactly the primitives the requirements need: a fresh context
per execution with no ambient globals, a host-side interrupt handler for wall-clock
termination that does not depend on the guest cooperating, and a memory limit enforced by the
allocator. Its cost is that the guest is not the same JavaScript engine the rest of the
system runs, and that host-guest value marshalling is explicit and manual.

Chosen: `quickjs-emscripten`. The explicit marshalling is a feature here rather than a cost —
nothing crosses the boundary unless the host deliberately passes it, which is the property
the requirements ask for. A default-deny boundary that must be opened by hand is easier to
argue correct than a shared-realm boundary that must be closed by hand.

`ses` was rejected outright: it hardens a realm within the same engine and process, which
mitigates prototype tampering but does not provide an execution boundary against a script
that is actively hostile.

### The host owns the destination; the script owns only the request's shape

The script is not given a fetch function. It is given a capability that issues a request to
*the task being checked* — the host supplies scheme, host, and port from the ECS attachment
and the declaration; the script supplies only path, method, headers, and body. There is no
parameter through which a destination can be expressed, so the SSRF property established by
the declarative kind is preserved by construction rather than by validating what the script
asks for.

The alternative — giving the script a fetch and validating the URL it passes — was rejected.
It converts a structural guarantee into a parsing problem, and URL parsing disagreements are
a well-worn source of exactly this class of bypass.

This guarantee is about *where* a script can reach, not about *what* it can do once there.
Because the script controls path, method, headers, and body, it has exactly the same request
authority against the game task as an operator manually calling that same management API —
including any destructive endpoint or RCON-style admin command the game exposes on the
declared port. The isolation boundary constrains the destination and the host state a script
can observe; it does not constrain what a script does to the one task it is permitted to
reach. A malicious or buggy script CAN mutate game state, not merely misreport health, and the
operator-facing warning at authoring time states this plainly rather than characterizing the
worst case as limited to a wrong verdict.

### Limits are enforced from the host side of the boundary

Wall-clock termination uses QuickJS's interrupt handler, which the host installs and which
fires regardless of what the guest is doing, so a `while (true)` terminates. Memory uses the
runtime's allocation limit. Request count is a host-side counter on the capability, checked
before each request rather than reported afterward. None of the three can be satisfied by
asking the script to behave.

The guest memory limit bounds allocation *inside* QuickJS; it does not bound the cost of
marshalling the guest's returned value back into the host's JavaScript representation, which
is a host-side walk over whatever the guest produced. The host SHALL apply its own bound to
that marshalling step — a depth- and size-limited walk of the returned value — independent of
the guest memory ceiling, so a script that stays under its own memory limit but constructs a
return value that is expensive to walk (very deep or very wide) fails the check safely rather
than risking the host Lambda's own process memory.

Per-execution isolation follows from constructing a fresh context per check and disposing it
afterward, so no state survives between games or between invocations that reuse a warm Lambda
container.

### The script's contract is a returned value, not a callback or a mutation

Exactly one entrypoint is supported: the value **exported as `export default`** is the
verdict — a function, or the immediate result of evaluating the module. A script with no
`export default` has no verdict and takes the fail-active "no verdict" outcome described
below; a bare top-level expression with nothing exported is not a supported contract.

If the default export is a function, the host calls it with a single argument exposing the
bindings this change grants: `game` (the game name), `task` (the checked task's resolved
`{ host, port }`), `secret` (the referenced credential's value, or `undefined` when none is
declared), and `request` (the capability described above). If the resulting value — the
function's return value, or the default export itself when it is not a function — is a
thenable, the host awaits it by draining the job queue with `executePendingJobs` until it
settles.

The settled value MUST match `{ active: boolean, reason: string }`. The host validates its
shape before use: anything that is not that shape, including a rejection, is a failure and
therefore active. This keeps the host-guest interface to one well-defined entrypoint and a
single value crossing in each direction, and avoids handing the guest any host-side function
beyond the request capability.

### The reason string is truncated at the boundary

The reason is operator-controlled text that lands in the deployment's logs on a schedule. It
is truncated to a fixed bound as it crosses out of the sandbox, before it reaches the logger,
so an unbounded or adversarial reason cannot be used to write arbitrary volume into
CloudWatch.

### Script source lives in the deployment configuration

Scripts are small, they are per-game, and every other per-game setting already lives in
`DeploymentConfig` in the S3 configuration bucket with its conditional-write locking and
version history. Storing the source there means script edits inherit that version history —
which matters more here than for other fields, because a script is code and its history is
the record of what has been running. A separate store was considered and rejected as
unjustified for the size and cardinality involved.

## Risks / Trade-offs

**Executing operator-authored code is a genuinely new class of exposure** → Contained by
choosing a boundary that is default-deny (a WASM guest with no ambient authority and one
explicitly-passed capability) rather than default-allow-with-restrictions. The residual risk
is a defect in the isolation runtime itself, which is why the runtime must be a maintained,
widely-used one and must be tracked for updates like any other dependency. This risk is the
reason this is a separate change: it should be possible to ship the declarative kind and
decline this one.

**A sandbox escape would reach the health-check Lambda's role** → That role is scoped —
`ecs:DescribeTasks` on one cluster, `GetSecretValue` on specific ARNs, log writes, and the
ENI actions any VPC Lambda needs — but "specific ARNs" is the union of every opted-in game's
health-check secret, not just the game being checked in that invocation, because the
predecessor change (`add-pluggable-health-checks`) chose one shared Lambda over per-game
functions. That decision explicitly reasoned it was safe only because the shared function
"executes no operator-supplied code," calling that "the property that would make [per-game
credential isolation] urgent." This change removes that property: a sandbox escape while
checking Game A's `script` can reach the ambient credentials for Game B, C, and D's checks
too, not just Game A's — in tension with this change's own Goal that a script's worst case
must exclude "access to the deployment's credentials, network, or other games." Accepted here
on the same isolation-runtime argument as the escape risk above (the WASM boundary is the
actual control, not IAM), but any future move to narrow `GetSecretValue` to the single game
under check — e.g. an STS `AssumeRole` scoped to one secret ARN per invocation, or reverting
to per-game Lambdas for the `script` kind — would remove this residual gap rather than merely
document it.

**A slow script risks delaying unrelated task checks in the same watchdog run** → The
watchdog processes RUNNING tasks sequentially within one invocation and calls the
health-check Lambda synchronously per task, so a script approaching its timeout for one task
delays every other task the watchdog still has to check that cycle — the delay is not
confined to its own game. Accepted as a bounded risk rather than treated as a defect: the
wall-clock limit already caps the damage to, at most, one timeout's worth of delay per
opted-in task per cycle, and the watchdog's own invoke-failure path (including one caused by
the watchdog itself running long and being terminated) is fail-active, so the worst case is a
delayed or partially-completed cycle, never an incorrect verdict.

**The guest is not the same JavaScript as the host** → An operator's script may rely on a
built-in QuickJS lacks. Mitigation: document the guest environment explicitly rather than
implying "JavaScript", and make the failure legible — an unavailable built-in surfaces as a
script error with its location, which the fail-active reason carries back.

**Scripts are unversioned code in a configuration file** → Inherits `DeploymentConfig`'s
version history, and script edits are recorded in the audit trail. Not a substitute for
review, and the design does not pretend otherwise; the operator is the reviewer.

**Bundling WASM into a Lambda bundle is not a pattern this repo has yet** → The esbuild
configuration must embed or load the WASM artifact correctly in a CommonJS bundle. This is a
known, bounded piece of work but it is the most likely source of a late surprise, so it is
sequenced first in the task list rather than assumed.

## Migration Plan

No migration. `script` is a second member of a discriminated union that no existing
configuration uses. A deployment that declares no `script` check is unaffected — the sandbox
runtime is bundled but never instantiated. Rolling back a specific script means editing that
game's configuration, which returns it to whichever behavior its remaining declaration
implies, or to the network heuristic if the `healthCheck` field is removed entirely.

## Open Questions

- Whether the health-check Lambda's memory and timeout defaults, sized in
  `add-pluggable-health-checks` for a single HTTP request, need raising once a WASM runtime
  is instantiated per execution. This is measurable after the first working implementation
  and does not change the approach, the specs, or the task breakdown.
