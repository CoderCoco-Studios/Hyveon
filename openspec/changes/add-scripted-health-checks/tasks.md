## 1. Prove the runtime bundles before building on it

- [ ] 1.1 Add `quickjs-emscripten` to `@hyveon/lambda-health-check` at the version the registry currently reports, and confirm the existing esbuild configuration produces a working `dist/handler.cjs` with the WASM artifact embedded or resolvable
- [ ] 1.2 Write a spike test that evaluates a trivial script inside the bundled runtime and asserts the returned value, run against the built bundle rather than the source, so a bundling regression fails here rather than at apply time
- [ ] 1.3 Measure the memory and cold-start cost of instantiating the runtime, and record whether the function's configured memory and timeout need raising (the design's open question)

## 2. Configuration shape

- [ ] 2.1 Convert `GameServerHealthCheck` in `@hyveon/shared` into a discriminated union over `kind`, preserving the existing `http` member unchanged, and add the `script` member — source, port, optional `auth`, timeout
- [ ] 2.2 Extend the zod schema to a discriminated union and add the `script` member's structural rules, including a bound on source length
- [ ] 2.3 Extend `checkHealthCheckRules` so the port rule applies to both kinds, and add any `script`-only business rules
- [ ] 2.4 Test that an existing `http` declaration still validates unchanged, that a `script` declaration validates, and that a declaration with an unknown `kind` is rejected

## 3. Sandbox host

- [ ] 3.1 Implement context construction: a fresh QuickJS context per execution with no ambient globals beyond what the contract defines, disposed after every execution including on the failure paths
- [ ] 3.2 Implement the request capability — the host supplies scheme, host, and port from the ECS attachment and the declaration; the script supplies path, method, headers, and body, and has no parameter through which a destination can be expressed
- [ ] 3.3 Enforce wall-clock termination via the runtime's interrupt handler, asserting in test that a non-terminating script is terminated by the host
- [ ] 3.4 Enforce the memory ceiling via the runtime's allocation limit, and the outbound-request cap via a host-side counter checked before each request
- [ ] 3.5 Marshal the returned verdict across the boundary, validating its shape, and truncate the reason to a fixed bound before it can reach the logger

## 4. Isolation tests

- [ ] 4.1 Assert a script cannot read the host's environment variables, obtain the execution role's credentials, or touch a filesystem
- [ ] 4.2 Assert a script cannot reach any destination other than the task being checked, including via a destination it supplies to the request capability
- [ ] 4.3 Assert a script cannot load modules or code the host did not provide
- [ ] 4.4 Assert per-execution isolation: state written by one execution is not observable by the next in the same warm container
- [ ] 4.5 Assert fail-active for every script failure — unevaluable source, a raised error, each limit exceeded, an invalid verdict shape, and no return value — with a reason that identifies the failure

## 5. Wiring into the check path

- [ ] 5.1 Dispatch on `kind` in the health-check handler, routing `http` to the existing declarative engine and `script` to the sandbox host, so both produce the same verdict shape
- [ ] 5.2 Fetch the referenced credential once in the handler and pass only that value into the sandbox, asserting in test that no other secret is reachable
- [ ] 5.3 Confirm the handler's logging contract still holds for the scripted path: the verdict and bounded reason are recorded, and the credential, the script source, and any response body are not

## 6. Operator interface

- [ ] 6.1 Add script authoring to the add/edit-game wizard, presented alongside a plain statement of what a script can and cannot do
- [ ] 6.2 Record script creation and modification in the audit trail with the game and the time
- [ ] 6.3 Expose the credential as a `secretSet` boolean, never the value, and cover it with a spec asserting no secret value reaches the renderer

## 7. Documentation and gates

- [ ] 7.1 Document the guest environment explicitly — that it is QuickJS and not Node, what a script receives, what it must return, and which built-ins are absent
- [ ] 7.2 Document the security posture plainly enough for an operator to decide whether to enable scripting at all, and state that a declaratively-expressible check should stay declarative
- [ ] 7.3 Update `docs/docs/components/lambdas.md` and the wizard page under `docs/docs/app/`
- [ ] 7.4 Run `npm run app:lint`, `npm run app:typecheck`, `npm run app:test`, and `npm run app:test:integration`, and confirm each exits zero
