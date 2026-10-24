# env-token-interpolation Specification

## Purpose
TBD - created by archiving change add-env-var-token-interpolation. Update Purpose after archive.
## Requirements
### Requirement: Environment variable values support an allow-listed ${hyveon.*} token grammar

Game server environment variable values SHALL support embedded tokens of the form `${hyveon.<namespace>.<name>}`. The set of legal tokens SHALL be a fixed allow-list exported from `@hyveon/shared`; for this capability's initial version the allow-list SHALL be exactly `${hyveon.network.public-address}` and `${hyveon.network.public-ipv4}`. A value SHALL be able to embed a token inside a longer string (e.g. `host=${hyveon.network.public-ipv4}:8211`) and SHALL be able to contain multiple tokens. Any `${hyveon.`-prefixed sequence that does not match an allow-listed token SHALL be rejected by the shared game-server validator with an issue positioned at that row's `value` path. All other value content — including `${OTHER_VAR}` shell-style expansion and `{brace}` text — SHALL pass through byte-for-byte untouched and SHALL NOT be treated as a token.

#### Scenario: Accepting an allow-listed token embedded in a longer value

- **WHEN** a proposed game-server entry includes an `environment` row whose value is `host=${hyveon.network.public-ipv4}:8211` (and the entry satisfies the token's other prerequisites)
- **THEN** validation for that row's `value` succeeds

#### Scenario: Rejecting an unknown ${hyveon.*} token

- **WHEN** a proposed game-server entry includes an `environment` row whose value contains `${hyveon.network.public-adress}` (not on the allow-list)
- **THEN** validation fails with an issue positioned at that row's `value` path naming the unknown token and listing the allowed tokens

#### Scenario: Non-hyveon placeholder syntax passes through untouched

- **WHEN** a proposed game-server entry includes an `environment` row whose value is `${JAVA_OPTS} -Dmotd={"name":"srv"}`
- **THEN** validation for that row's `value` succeeds and the value reaches the container definition byte-for-byte unchanged

### Requirement: The public-address token resolves to the game's hostname at deploy time

The infra program SHALL replace every occurrence of `${hyveon.network.public-address}` in a game's environment variable values with that game's DNS name `<game>.<zone>` (the same hostname the DNS-update Lambda maintains) while building the game's ECS task definition. The resolved value SHALL be baked into the task definition; no runtime component SHALL be involved. If any game's environment variables use this token while no Route53 hosted zone is configured for the deployment, the infra program SHALL fail the preview/apply with an error identifying the game and the token, rather than deploying an unresolved or empty value.

#### Scenario: Hostname substituted into the task definition

- **WHEN** the deployment has hosted zone `example.com` and game `palworld` declares an environment row `PUBLIC_HOST=${hyveon.network.public-address}`
- **THEN** the generated task definition's container environment carries `PUBLIC_HOST=palworld.example.com`

#### Scenario: Deploy fails when no hosted zone is configured

- **WHEN** a game's environment variables use `${hyveon.network.public-address}` and the deployment configures no hosted zone
- **THEN** Pulumi preview/apply fails with an error naming the game and the token, and no task definition with an unresolved token is created

### Requirement: The public-ipv4 token resolves at container boot via an injected entrypoint wrapper

When any of a game's environment variable values contain `${hyveon.network.public-ipv4}`, the infra program SHALL leave the raw token in the task definition and SHALL set the game container's `entryPoint` to an inline `/bin/sh -c` wrapper script generated at deploy time. The wrapper SHALL discover the task's public IPv4 by querying `https://checkip.amazonaws.com` (using `wget`, falling back to `curl`) with retries bounded by a total budget of approximately 60 seconds, SHALL substitute the discovered IP into exactly the environment variables whose configured values contain the token, and SHALL then `exec` the game's configured `command`. Games with no ipv4 token SHALL receive no entrypoint wrapper and their task definitions SHALL be byte-identical to today's output.

#### Scenario: Wrapper resolves the IP and starts the server

- **WHEN** a game declares `SERVER_IP=${hyveon.network.public-ipv4}` and its task starts with public IP `3.16.51.26`
- **THEN** the game process starts via the configured `command` with `SERVER_IP=3.16.51.26` in its environment

#### Scenario: Only token-bearing variables are rewritten at boot

- **WHEN** a game declares `SERVER_IP=${hyveon.network.public-ipv4}` and `EULA=TRUE`
- **THEN** the wrapper rewrites only `SERVER_IP`; `EULA` and all other environment variables reach the game process exactly as the task definition set them

#### Scenario: Games without the ipv4 token are unaffected

- **WHEN** a game's environment variables contain no `${hyveon.network.public-ipv4}` token
- **THEN** its container definition sets no `entryPoint` wrapper and is unchanged from the pre-feature output

### Requirement: Boot-time discovery failure fails the server start visibly

If the entrypoint wrapper cannot discover the public IPv4 within its retry budget, it SHALL exit with a non-zero status without starting the game process, so the ECS task stops and the failure surfaces through the existing stopped-task visibility (dashboard state, logs, Discord status). The wrapper SHALL NOT start the game with the token unresolved or with an empty value.

#### Scenario: Discovery timeout stops the task

- **WHEN** the wrapper's queries to the IP-echo endpoint all fail for the full retry budget
- **THEN** the container exits non-zero, the task reaches STOPPED, and the game process is never started

### Requirement: Wrapper script generation is injection-safe

The wrapper script generator SHALL treat operator-supplied environment variable values and command arguments as data, embedding them in the generated script only inside single-quoted shell strings with embedded single quotes escaped (`'\''`), and SHALL substitute the discovered IP via a shell variable rather than re-parsing any operator content. Because a token-bearing variable's name becomes an `export` statement in the script, the shared validator SHALL reject any `environment` row whose value uses `${hyveon.network.public-ipv4}` and whose `name` is not a valid shell identifier (`[A-Za-z_][A-Za-z0-9_]*`); names of rows without that token remain unconstrained. Operator values SHALL NOT be able to inject shell syntax into the generated script.

#### Scenario: Token-bearing variable name must be a valid shell identifier

- **WHEN** a proposed game-server entry declares an `environment` row named `BAD NAME;` whose value uses `${hyveon.network.public-ipv4}`
- **THEN** validation fails with an issue positioned at that row's `name` path requiring a valid shell identifier

#### Scenario: Adversarial env value cannot escape quoting

- **WHEN** a game declares an environment row whose value is `'; rm -rf / #${hyveon.network.public-ipv4}`
- **THEN** the generated script treats the entire value as literal data, the substituted variable contains the literal prefix followed by the discovered IP, and no injected command executes

### Requirement: Games gain an optional container start command, required with the ipv4 token

`GameServerConfig` entries SHALL support an optional `command` field (array of strings) that the infra program passes through as the game container's `command`. The shared game-server validator SHALL reject any entry whose environment variable values use `${hyveon.network.public-ipv4}` while `command` is absent or empty, with an issue explaining that the entrypoint wrapper replaces the image's built-in start command. Entries whose values do not use the ipv4 token SHALL NOT be required to set `command`, and a `command` set without any token SHALL still be passed through to the container definition.

#### Scenario: ipv4 token without a command is rejected at save time

- **WHEN** a proposed game-server entry declares `SERVER_IP=${hyveon.network.public-ipv4}` and no `command`
- **THEN** validation fails with an issue stating that `command` is required when `${hyveon.network.public-ipv4}` is used

#### Scenario: Command passes through without tokens

- **WHEN** a game declares `command: ["/opt/server/start.sh", "--port", "8211"]` and no `${hyveon.*}` tokens
- **THEN** the generated container definition carries that `command` verbatim and no `entryPoint` wrapper

