# Authoritative Health Check Specs

EARS requirements for prefix `RT-HEALTH`; design in `health-check-design.md` (same folder).

## Declaration and routing

- [x] **RT-HEALTH-DECL-001**: The `GameServerConfig` entry for a game in `deployment-config.json` shall accept an optional `healthCheck` declaration carrying a `kind` discriminator, whose only accepted value is `http`.
- [x] **RT-HEALTH-DECL-006**: The health-check Lambda shall return a verdict of shape `{ active: boolean, reason: string, failureDerived: boolean }` for every invocation it completes. (observed)

## HTTP request

- [x] **RT-HEALTH-HTTP-001**: When the health-check Lambda runs an `http`-kind check, it shall issue one HTTP request to `http://{taskPrivateIp}:{port}{path}` using the declared method, the declared headers, and the declared `timeoutMs` as a single wall-clock budget for the whole request.
- [x] **RT-HEALTH-HTTP-002**: When the health-check Lambda runs an `http`-kind check, it shall take the destination host only from the `privateIp` field of its invoke payload.
- [x] **RT-HEALTH-HTTP-003**: The health-check Lambda shall not follow HTTP redirects when issuing an `http`-kind check, so a 3xx response is evaluated as a non-successful status.
- [x] **RT-HEALTH-HTTP-005**: The health-check Lambda shall issue an `http`-kind check only over plain `http`, addressing the container directly by private IP so the request bypasses the Caddy sidecar. (TLS to a private IP is a non-goal; see Decisions & Alternatives, Health-check scheme)
- [x] **RT-HEALTH-HTTP-006**: No `healthCheck` declaration field shall be capable of supplying or overriding the destination host of a health-check request, where the destination host is the connect address in the authority of the request URL.
- [x] **RT-HEALTH-HTTP-007**: If the `privateIp` field of the health-check Lambda's invoke payload is absent (`undefined` or `null`), then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`, without issuing an HTTP request.
- [x] **RT-HEALTH-HTTP-008**: If the `privateIp` field of the health-check Lambda's invoke payload is present and is a value that Node's `net.isIPv4` does not accept when applied to the value as received, without trimming, then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`, without issuing an HTTP request.
- [x] **RT-HEALTH-HTTP-010**: If the `privateIp` field of the health-check Lambda's invoke payload is a well-formed IPv4 literal that lies outside the RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), including loopback, `0.0.0.0/8`, link-local, multicast, broadcast and public addresses, then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`, without issuing an HTTP request.
- [x] **RT-HEALTH-HTTP-012**: If the `privateIp` field of the health-check Lambda's invoke payload is an RFC 1918 IPv4 literal that lies outside the VPC CIDR block carried in the Lambda's `VPC_CIDR` environment variable, or if `VPC_CIDR` is absent or is not a well-formed IPv4 CIDR, then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`, without issuing an HTTP request.
- [x] **RT-HEALTH-HTTP-009**: The health-check Lambda shall make no ECS API call.
- [x] **RT-HEALTH-HTTP-011**: The health-check Lambda shall build the request URL so that the declared `path` cannot change the URL's authority.

## Credential injection

- [x] **RT-HEALTH-AUTH-001**: When a health check's `auth` declares `type: 'raw'` or no `type`, the health-check Lambda shall set the `Authorization` header to the resolved secret string verbatim with no added prefix.
- [x] **RT-HEALTH-AUTH-002**: When a health check's `auth` declares `type: 'bearer'`, the health-check Lambda shall set the `Authorization` header to `Bearer ` followed by the resolved secret string.
- [x] **RT-HEALTH-AUTH-003**: When a health check's `auth` declares `type: 'basic'`, the health-check Lambda shall parse the resolved secret as a JSON object with string `username` and `password` and set the `Authorization` header to `Basic ` followed by the base64 encoding of `username:password`.
- [x] **RT-HEALTH-AUTH-004**: If a `type: 'basic'` health-check secret is not valid JSON or lacks string `username` and `password` fields, then the health-check Lambda shall treat the credential as unavailable and return a failure-derived active verdict.
- [x] **RT-HEALTH-AUTH-005**: When a health check declares `auth` and its declared `headers` also contain a key equal to `authorization` case-insensitively, the health-check Lambda shall discard the declared header and send only the constructed `Authorization` header.
- [x] **RT-HEALTH-AUTH-006**: The health-check Lambda shall place the constructed `Authorization` value only in the `Authorization` request header, never in the request path, query string, or any other header.

## Verdict evaluation

- [x] **RT-HEALTH-EVAL-001**: The health-check verdict engine (`evaluateHealthCheck`) shall be a pure function of the declaration, the HTTP status and the raw response body, with no I/O. (observed)
- [x] **RT-HEALTH-EVAL-002**: When a health-check response has a 2xx status and a JSON body whose scalar value at the declared `jsonPath` satisfies the declared operator, the verdict engine shall return `active: true` with `failureDerived: false`.
- [x] **RT-HEALTH-EVAL-003**: When a health-check response has a 2xx status and a JSON body whose scalar value at the declared `jsonPath` does not satisfy the declared operator, the verdict engine shall return `active: false` with `failureDerived: false`.
- [x] **RT-HEALTH-EVAL-004**: When a health check declares the `exists` operator and the response is a 2xx JSON body, the verdict engine shall return active if the declared `jsonPath` resolves to any value and idle (not failure-derived) if it does not.
- [x] **RT-HEALTH-EVAL-005**: The verdict engine shall resolve `jsonPath` as a restricted dialect of dotted field names and numeric array indices only, where any other syntax resolves no value.
- [x] **RT-HEALTH-EVAL-006**: When the verdict engine applies `equals` or `notEquals`, it shall treat a resolved and declared value of different JSON types as incomparable, except that a `null` on either side compares by identity without a type check.
- [x] **RT-HEALTH-EVAL-007**: When the verdict engine applies `greaterThan` or `lessThan`, it shall compare numerically, accepting numeric strings, and treat a value that does not parse to a finite number as incomparable.
- [x] **RT-HEALTH-EVAL-008**: When the verdict engine applies `contains`, it shall test substring containment and treat a non-string resolved or declared value as incomparable.
- [x] **RT-HEALTH-EVAL-009**: The verdict engine's `reason` text shall name only the declared `jsonPath`, the operator, or the HTTP status, and shall never include the resolved response value or any part of the response body.

## Fail-active

- [x] **RT-HEALTH-FAIL-001**: If a health-check response status is outside 200-299, then the verdict engine shall return a failure-derived active verdict.
- [x] **RT-HEALTH-FAIL-002**: If a health-check response body is not valid JSON, then the verdict engine shall return a failure-derived active verdict.
- [x] **RT-HEALTH-FAIL-003**: If, for any operator other than `exists`, the declared `jsonPath` resolves no value, resolves an object or array, or resolves a value the operator cannot compare, then the verdict engine shall return a failure-derived active verdict.
- [x] **RT-HEALTH-FAIL-004**: If the health-check Lambda's payload-host validation, secret fetch, credential construction, connection, or request timeout fails, then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`.
- [x] **RT-HEALTH-FAIL-005**: The health-check Lambda shall bound each Secrets Manager `GetSecretValue` call, including all SDK retry attempts, with one overall deadline shorter than the health-check Lambda's function timeout.
- [x] **RT-HEALTH-FAIL-006**: The overall deadline on the health-check Lambda's `GetSecretValue` call plus the check's declared `timeoutMs` shall fit within the per-run total time budget for health-check invokes that the watchdog applies under `RT-WATCHDOG-HC-006`.
- [x] **RT-HEALTH-FAIL-007**: If the health-check Lambda's `GetSecretValue` call exceeds its overall deadline, then the Lambda shall return `active: true`, `failureDerived: true`, and a reason prefixed `health check failed:`, without issuing an HTTP request.

## Provisioning and runtime environment

- [x] **RT-HEALTH-PROV-001**: While no game in `deployment-config.json` declares `healthCheck`, infra shall declare no health-check Lambda, log group, IAM role, IAM policy, or security group, and shall grant the watchdog no `lambda:InvokeFunction` statement.
- [x] **RT-HEALTH-PROV-002**: While at least one game declares `healthCheck`, infra shall declare exactly one `{projectName}-health-check` Lambda, one role, and one security group serving every opted-in game.
- [x] **RT-HEALTH-PROV-003**: While at least one game declares `healthCheck`, infra shall provide the health-check Lambda with every environment variable its handler requires at module load or reads at invoke time. (observed)
- [x] **RT-HEALTH-PROV-004**: While at least one game declares `healthCheck.auth.secretArn`, the deployed health-check Lambda shall have a network path to the Secrets Manager API through the Secrets Manager interface VPC endpoint.
- [x] **RT-HEALTH-PROV-005**: The health-check package's tests shall fail when the handler requires an env var that infra does not provision. (observed)
- [x] **RT-HEALTH-PROV-006**: The health-check Lambda shall read its region from `AWS_REGION_` (trailing underscore), falling back to `AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`. (observed; CLAUDE.md invariant)

## Network and permission confinement

- [x] **RT-HEALTH-NET-001**: While at least one game declares `healthCheck`, the health-check security group shall carry one TCP egress rule toward `gameServersSg` for each distinct declared health-check port.
- [x] **RT-HEALTH-NET-002**: The health-check Lambda's IAM policy shall grant `secretsmanager:GetSecretValue` only on the `auth.secretArn` values persisted by opted-in games.
- [x] **RT-HEALTH-NET-003**: The health-check Lambda shall have no Function URL, and the only `lambda:InvokeFunction` grant on it shall be in the watchdog's role policy.
- [x] **RT-HEALTH-NET-004**: The watchdog Lambda shall have no VPC attachment and no Secrets Manager permission for health-check credentials.
- [x] **RT-HEALTH-NET-005**: The persisted `healthCheck.auth` in `deployment-config.json` shall carry only a `type` and a Secrets Manager `secretArn`, never a credential value.
- [x] **RT-HEALTH-NET-006**: While at least one game declares `healthCheck`, `gameServersSg` shall carry one TCP ingress rule from the health-check security group for each distinct declared health-check port.
- [x] **RT-HEALTH-NET-007**: The health-check security group shall carry no egress rule other than its per-port TCP rules toward `gameServersSg` and, while at least one game declares `healthCheck.auth.secretArn`, one TCP 443 rule toward the Secrets Manager endpoint security group.
- [x] **RT-HEALTH-NET-008**: The health-check Lambda's IAM policy shall grant no action in the `ecs:` namespace.
- [x] **RT-HEALTH-NET-009**: While no game declares `healthCheck.auth.secretArn`, the health-check Lambda's IAM policy shall contain no statement granting a `secretsmanager:` action.

## Save-time validation

- [x] **RT-HEALTH-VALID-001**: When an operator saves a game whose `healthCheck.port` is neither one of the game's declared TCP container ports nor its `webPort`, the game-server validator shall reject the save with an issue at `healthCheck.port`.
- [x] **RT-HEALTH-VALID-002**: When an operator saves a health check whose `path` is empty or does not start with `/`, the game-server validator shall reject the save.
- [x] **RT-HEALTH-VALID-003**: When an operator saves a health check whose `timeoutMs` is not an integer between 100 and 10000 inclusive, the game-server validator shall reject the save.
- [x] **RT-HEALTH-VALID-004**: When an operator saves a health check with an operator other than `exists` and no `activeWhen.value`, or with `exists` and a `value`, the game-server validator shall reject the save.
- [x] **RT-HEALTH-VALID-005**: When an operator saves a health check using `greaterThan` or `lessThan` with a non-number `value`, or `contains` with a non-string `value`, the game-server validator shall reject the save. (observed)
- [x] **RT-HEALTH-VALID-006**: When an operator saves a health check whose `activeWhen.jsonPath` does not match `^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[\d+\])*$` (which excludes a leading `$`), the game-server validator shall reject the save.
- [x] **RT-HEALTH-VALID-007**: When an operator saves a health check whose declared `headers` contain an `authorization` key or a value resembling a bearer token, basic-auth pair, or long API-key string, the game-server validator shall reject the save.
- [x] **RT-HEALTH-VALID-008**: When an operator saves a health-check credential with `type: 'basic'` lacking a username or password, `type: 'bearer'` lacking a token, or `type: 'raw'` (or no type) lacking a Secrets Manager ARN matching `arn:aws:secretsmanager:<region>:<account>:secret:<name>`, the write-input validator shall reject the save.
- [x] **RT-HEALTH-VALID-009**: When an operator saves, or the validator reads, a health check whose `scheme` is anything other than `http` (including `https`), the game-server validator shall reject it with an issue at `healthCheck.scheme` stating that only `http` is supported because the check runs inside the VPC against the task's private IP.

## Logging

- [x] **RT-HEALTH-LOG-001**: When the health-check Lambda produces a verdict, it shall log one structured line carrying `game`, `kind`, `active` and `reason`, at `warn` when the verdict is failure-derived and at `debug` otherwise.
- [x] **RT-HEALTH-LOG-002**: When the watchdog receives a failure-derived health-check verdict, it shall log a `warn` line naming the game and the reason.
- [x] **RT-HEALTH-LOG-003**: When the watchdog counts a health-checked task as idle, it shall log the idle count together with the health-check verdict's reason, so a later shutdown is attributable to the sequence of check outcomes.
- [x] **RT-HEALTH-LOG-004**: The health-check Lambda's and the watchdog's health-check log lines shall never contain a credential value or any part of a response body.

## Operator interface redaction

- [x] **RT-HEALTH-REDACT-001**: When a game with a `healthCheck` is sent to the renderer, `redactGameServer` shall replace `healthCheck.auth` with `secretSet` (whether a credential is configured) and `authType` (the credential type, `raw` when absent), and shall send no ARN, username, password, or token.
- [x] **RT-HEALTH-REDACT-002**: While the add/edit-game wizard shows a game whose health check has `secretSet: true`, the wizard's health-check fields shall indicate that a credential is set and leave the credential inputs empty, so a blank input keeps the existing credential.
- [x] **RT-HEALTH-REDACT-003**: The wizard's health-check fields shall offer auth types `none`, `raw`, `basic` and `bearer`, render the password and token inputs as masked fields, and offer the game's `webPort` as a selectable target port ahead of its extra TCP ports. (observed)
- [x] **RT-HEALTH-REDACT-004**: When a save is rejected with an issue at `healthCheck.timeoutMs`, the wizard's health-check fields shall display that issue's message beside the timeout input. (observed)

## App-owned credential lifecycle

- [x] **RT-HEALTH-CRED-001**: When an operator saves a `type: 'basic'` or `type: 'bearer'` health-check credential, the game write path shall store the credential (`{ username, password }` JSON for basic, the raw token for bearer) in an app-owned Secrets Manager secret named `hyveon-{gameId}-healthcheck-auth` and persist only that secret's ARN.
- [x] **RT-HEALTH-CRED-002**: When the app-owned health-check secret for a game already exists, `upsertHealthCheckAuthSecret` shall update its value in place with `PutSecretValue` and shall not create another secret.
- [x] **RT-HEALTH-CRED-003**: If `PutSecretValue` on the app-owned health-check secret fails because the secret is scheduled for deletion (confirmed by `DescribeSecret.DeletedDate`), then `upsertHealthCheckAuthSecret` shall restore the secret and retry the put once. (observed)
- [x] **RT-HEALTH-CRED-004**: If `PutSecretValue` on the app-owned health-check secret fails with `ResourceNotFoundException`, then `upsertHealthCheckAuthSecret` shall create the secret. (observed)
- [x] **RT-HEALTH-CRED-005**: When an operator clears a `basic` or `bearer` health-check credential, switches it to `raw`, removes the `healthCheck`, or deletes the game, the game write path shall delete the app-owned secret using the default recovery window.
- [x] **RT-HEALTH-CRED-006**: When an operator removes a `type: 'raw'` (or untyped) health-check credential or deletes a game that declares one, the game write path shall not delete the referenced Secrets Manager secret.
- [x] **RT-HEALTH-CRED-007**: If deleting an app-owned health-check secret fails, then the game write path shall log a `warn` and still complete the config write, and if creating or updating it fails, then the write path shall log an `error` and reject the save with a plain `Error`. (observed)
- [x] **RT-HEALTH-CRED-008**: The `HyveonDeployAll` deploy policy evaluated by the Settings account check shall grant `secretsmanager:*`, covering creation, update, restore, and deletion of app-owned health-check secrets.
