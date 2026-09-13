# pulumi-infra-program Delta Specification

## ADDED Requirements

### Requirement: Task definitions resolve environment variable interpolation tokens

While building each game's ECS task definition, the infra program SHALL apply the `env-token-interpolation` capability's resolution rules: `${hyveon.network.public-address}` occurrences in environment variable values SHALL be replaced with `<game>.<zone>` at deploy time (failing preview/apply with an error naming the game and token when no hosted zone is configured); when any value contains `${hyveon.network.public-ipv4}`, the program SHALL generate the injection-safe inline `/bin/sh -c` entrypoint wrapper and set the container's `command` from the entry's `command` field. Entries declaring a `command` SHALL have it passed through to the container definition regardless of token usage. Games whose environment variables contain no `${hyveon.*}` tokens SHALL produce container definitions identical to the pre-feature output.

#### Scenario: Apply-time hostname substitution

- **WHEN** the infra program builds the task definition for a game declaring `PUBLIC_HOST=${hyveon.network.public-address}` under hosted zone `example.com`
- **THEN** the container definition's environment carries the resolved hostname value and no interpolation token remains in the task definition for that variable

#### Scenario: Wrapper and command wiring for the ipv4 token

- **WHEN** the infra program builds the task definition for a game declaring `SERVER_IP=${hyveon.network.public-ipv4}` and `command: ["/start.sh"]`
- **THEN** the game container's `entryPoint` is the generated `/bin/sh -c` wrapper, its `command` is `["/start.sh"]`, and the raw token remains in the container environment for the wrapper to substitute at boot

#### Scenario: Missing hosted zone fails the deploy

- **WHEN** a game's environment variables use `${hyveon.network.public-address}` and the deployment has no hosted zone configured
- **THEN** preview/apply fails with an error identifying the game and the token

#### Scenario: Token-free games produce unchanged task definitions

- **WHEN** the infra program builds task definitions for games whose environment variables contain no `${hyveon.*}` tokens and that declare no `command`
- **THEN** the generated container definitions are identical to those produced before this capability existed
