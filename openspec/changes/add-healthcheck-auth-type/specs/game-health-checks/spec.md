## MODIFIED Requirements

### Requirement: The HTTP check kind evaluates a declared request against a declared condition

The system SHALL support a health-check kind that issues an HTTP request to the running game
task and derives the verdict from a single condition evaluated against the response body.

The declaration SHALL specify the scheme, the port, the request path, the HTTP method, any
additional request headers, an optional credential reference for authenticating the request,
and a request timeout. The condition SHALL specify a path into the JSON response body, a
comparison operator, and — for every operator except an existence test — a value to compare
against.

A credential reference SHALL declare a `type` of `raw`, `basic`, or `bearer`. A credential
reference with no declared `type` SHALL be treated as `raw`, so every existing configuration
that predates this requirement continues to behave exactly as it did before.

When the declaration references a `raw` credential, the resolved secret value SHALL be
injected into the outbound request as a single, fixed header — `Authorization`, set to the
secret's raw value with no added prefix such as `Bearer ` — exactly as for a credential with
no declared `type`.

When the declaration references a `basic` credential, the resolved secret value SHALL be a
JSON object carrying a username and a password. The system SHALL construct the `Authorization`
header as the HTTP Basic scheme applied to that username and password. A secret value that
cannot be interpreted as such a JSON object SHALL be treated as an unavailable credential.

When the declaration references a `bearer` credential, the resolved secret value SHALL be
injected into the outbound request as the `Authorization` header using the HTTP Bearer scheme.

In every case, the constructed `Authorization` header value SHALL NOT be interpolated into the
path, the query string, or any operator-supplied header. If the declaration's own `headers`
map also sets `Authorization`, the constructed credential SHALL take precedence and the
operator-supplied value SHALL be discarded, so a working credential cannot silently be
overridden by a stray header. Configuration validation SHALL reject any operator-supplied
header value that resembles an inline credential (for example, a bearer token, a basic-auth
pair, or an API-key shape embedded directly in the value) — declared headers are for
non-sensitive values only; a credential MUST be expressed through `auth`.

The condition SHALL be a single comparison rather than a composite expression. A game whose
liveness cannot be expressed as one comparison is out of scope for this kind.

The scheme SHALL be `http` or `https`. The method SHALL be one of `GET`, `POST`, `PUT`,
`PATCH`, or `HEAD`. The comparison operator SHALL be one of six: `equals`, `notEquals`,
`greaterThan`, `lessThan`, `contains`, and `exists`. Every operator except `exists` requires a
value to compare against; `exists` requires none.

The path SHALL be a JSONPath expression restricted to plain field access and numeric array
indices — no wildcards, filters, slices, or recursive descent — and SHALL resolve to exactly
one scalar value (a JSON string, number, boolean, or null) in the response body. Resolving to
zero matches, more than one match, or a non-scalar (object or array) is treated as no value at
the declared path, which is a failure condition under the requirement below — except for
`exists`, which tests only whether the path resolves to anything at all, at any cardinality.

`equals` and `notEquals` compare the resolved value against the declared value by strict JSON
type and value equality; a resolved value of a different type than the declared value is a
value the operator cannot compare. `greaterThan` and `lessThan` compare numerically; a
resolved or declared value that does not parse as a number is a value the operator cannot
compare. `contains` requires the resolved value to be a string and tests for a substring
match; a resolved value that is not a string is a value the operator cannot compare.

`timeoutMs` SHALL be an integer between 100 and 10000 inclusive, and bounds the entire
request — connection, request transmission, and response receipt — as a single wall-clock
budget measured from the health-check Lambda's side.

The client SHALL NOT follow HTTP redirects. A response with a 3xx status is not evaluated
against the condition; it is treated as a failed check under the requirement below, exactly
like any other non-2xx status.

The verdict SHALL be active when the condition holds and idle when it does not.

#### Scenario: The condition holds

- **WHEN** the game task returns a successful JSON response whose value at the declared path
  satisfies the declared comparison
- **THEN** the verdict is active

#### Scenario: The condition does not hold

- **WHEN** the game task returns a successful JSON response whose value at the declared path
  does not satisfy the declared comparison
- **THEN** the verdict is idle

#### Scenario: An existence condition is declared

- **WHEN** the condition declares an existence test and no comparison value
- **THEN** the verdict is active if the declared path resolves to a value in the response,
  and idle if it does not

#### Scenario: A raw credential is declared

- **WHEN** the declaration references a credential with `type: 'raw'`, or a credential with no
  declared `type`
- **THEN** the resolved secret's raw value is injected as `Authorization` with no added prefix

#### Scenario: A basic credential is declared

- **WHEN** the declaration references a credential with `type: 'basic'` whose resolved secret
  is a JSON object carrying a username and password
- **THEN** the outbound request carries an `Authorization` header using the HTTP Basic scheme
  encoding that username and password

#### Scenario: A bearer credential is declared

- **WHEN** the declaration references a credential with `type: 'bearer'`
- **THEN** the outbound request carries an `Authorization` header using the HTTP Bearer scheme
  set to the resolved secret's raw value

#### Scenario: A basic credential's secret is not the expected shape

- **WHEN** the declaration references a credential with `type: 'basic'` whose resolved secret
  cannot be interpreted as a JSON object carrying a username and password
- **THEN** the credential is treated as unavailable

### Requirement: Health-check configuration is validated before it is saved

A health-check declaration SHALL be validated when the operator saves the configuration, and
an invalid declaration SHALL be rejected at that point rather than failing later during an
idle decision.

Validation SHALL reject, at minimum: a port that is not among the ports the game declares, a
request path that is not rooted, a timeout outside the supported range (100–10000
milliseconds inclusive), a comparison operator given without a value where one is required,
and a malformed credential reference.

A credential reference declaring `type: 'basic'` SHALL be rejected unless both a username and
a password are supplied. A credential reference declaring `type: 'bearer'` SHALL be rejected
unless a token is supplied. A credential reference declaring `type: 'raw'`, or no `type`,
SHALL be rejected unless a Secrets Manager ARN is supplied, unchanged from prior behavior.

#### Scenario: A port that the game does not expose

- **WHEN** an operator saves a game whose health check declares a port absent from that
  game's declared ports
- **THEN** the configuration is rejected with an explanation, and is not persisted

#### Scenario: A comparison without a value

- **WHEN** an operator saves a health check declaring a comparison operator but no value to
  compare against
- **THEN** the configuration is rejected with an explanation

#### Scenario: A basic credential missing a password

- **WHEN** an operator saves a health check declaring `auth.type: 'basic'` with a username but
  no password
- **THEN** the configuration is rejected with an explanation, and is not persisted

#### Scenario: A bearer credential missing a token

- **WHEN** an operator saves a health check declaring `auth.type: 'bearer'` with no token
- **THEN** the configuration is rejected with an explanation, and is not persisted

### Requirement: Health-check credentials never reach the operator interface

Where the operator interface presents a health-check declaration, it SHALL indicate whether
a credential is configured without exposing the credential itself, consistent with how the
system treats every other secret it holds. This SHALL apply uniformly across `raw`, `basic`,
and `bearer` credentials — no part of a `basic` credential's username, nor a `bearer`
credential's token, is exempt from this rule merely because it is not, by itself, the whole
secret.

#### Scenario: An operator edits a game with an authenticated check

- **WHEN** the operator opens a game whose health check references a credential
- **THEN** the interface shows that a credential is set
- **AND** the credential value is not present in anything sent to the interface

#### Scenario: An operator edits a game with a basic-auth check

- **WHEN** the operator opens a game whose health check references a `type: 'basic'`
  credential
- **THEN** the interface shows that a credential is set
- **AND** neither the username nor the password is present in anything sent to the interface

## ADDED Requirements

### Requirement: App-owned health-check credentials are provisioned and retired by the app

A credential reference declaring `type: 'basic'` or `type: 'bearer'` SHALL be backed by a
Secrets Manager secret that the system itself creates and manages, so the operator supplies
only the credential's plaintext parts (username/password, or token) and never a Secrets
Manager ARN. A credential reference declaring `type: 'raw'`, or no `type`, SHALL continue to
reference a secret the operator provisions and owns outside the system, unchanged.

When an operator changes a `basic` or `bearer` credential's plaintext value, the system SHALL
update the existing app-owned secret in place rather than creating a new one.

When an operator removes a `basic` or `bearer` credential from a game's health check, or
deletes the game, the system SHALL delete the app-owned secret backing that credential. A
`raw`-type credential's secret SHALL NOT be deleted by either action, since the system does
not own it.

#### Scenario: An operator adds a basic credential

- **WHEN** an operator saves a health check declaring `auth.type: 'basic'` with a username and
  password, for a game with no prior app-owned health-check secret
- **THEN** the system creates a new Secrets Manager secret holding that credential
- **AND** the persisted configuration references that secret

#### Scenario: An operator changes a bearer credential's token

- **WHEN** an operator saves a new token for a health check that already declares
  `auth.type: 'bearer'` backed by an app-owned secret
- **THEN** the system updates the existing secret's value
- **AND** does not create an additional secret

#### Scenario: An operator removes a basic credential

- **WHEN** an operator saves a game removing a `basic`-type credential that was backed by an
  app-owned secret
- **THEN** the system deletes that secret

#### Scenario: A game with an app-owned credential is deleted

- **WHEN** an operator deletes a game whose health check declares an app-owned `basic` or
  `bearer` credential
- **THEN** the system deletes the secret backing that credential

#### Scenario: A raw credential is never deleted by the system

- **WHEN** an operator removes a `raw`-type credential from a health check, or deletes a game
  whose health check declares one
- **THEN** the system does not delete the referenced Secrets Manager secret

### Requirement: App-owned credential lifecycle requires no additional account permission

The permissions an AWS account must grant for the system to operate — evaluated by the
Settings page's account health check — SHALL already cover creating, updating, and deleting
app-owned health-check credentials, so an account that passes that check today continues to
pass it after this capability is enabled.

#### Scenario: An already-deployed account remains compliant

- **WHEN** the Settings page evaluates account permissions for an account granted the
  system's standard deploy policy
- **THEN** the evaluation does not report the ability to create, update, or delete an
  app-owned health-check secret as a missing permission
