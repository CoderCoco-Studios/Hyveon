/**
 * Generates the inline `/bin/sh -c` entrypoint wrapper injected into game
 * containers whose env values use `${hyveon.network.public-ipv4}`. The
 * wrapper discovers the task's public IPv4 at boot (the IP does not exist
 * until after RunTask), re-exports exactly the token-bearing variables with
 * the IP spliced in, then execs the operator's configured command. All
 * operator strings are embedded single-quoted so they are inert shell data.
 */
import type { GameServerEnvironmentVariable } from '@hyveon/shared';
import { HYVEON_ENV_TOKENS, valueUsesToken } from '@hyveon/shared/envTokens';

/** Arguments for {@link buildIpv4WrapperScript}. */
export interface Ipv4WrapperArgs {
  /** The game's env vars, post hostname substitution; only ipv4-token rows are re-exported. */
  environment: GameServerEnvironmentVariable[];
  /** The operator-supplied container start command; exec'd once the IP is resolved. */
  command: string[];
  /** IP-echo endpoint override for tests. Defaults to AWS's checkip service. */
  ipEchoUrl?: string;
}

const DEFAULT_IP_ECHO_URL = 'https://checkip.amazonaws.com';
const SHELL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quotes `value` for POSIX sh, escaping embedded quotes (`'` → `'\''`). */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quotes `value` for the script with every ipv4 token replaced by the discovered-IP shell variable. */
function quotedWithIpSplices(value: string): string {
  return value.split(HYVEON_ENV_TOKENS.publicIpv4).map(shellSingleQuote).join('"$HYVEON_PUBLIC_IPV4"');
}

/**
 * Builds the wrapper script: retry loop against the IP-echo endpoint (wget
 * then curl, 30 × 2s), a shape check rejecting any non-IPv4 response before
 * it's accepted, targeted `export` lines, then `exec` of the command. Exits
 * non-zero without starting the game if discovery fails.
 *
 * @param args - The environment, command, and optional IP-echo URL to build the script from.
 * @returns The full POSIX `sh` script as a string.
 * @throws Error when `command` is empty, no variable carries the ipv4
 * token, or a token-bearing name is not a shell identifier — all of which
 * the shared validator rejects before config is persisted.
 */
export function buildIpv4WrapperScript(args: Ipv4WrapperArgs): string {
  const { environment, command } = args;
  const ipEchoUrl = args.ipEchoUrl ?? DEFAULT_IP_ECHO_URL;

  if (command.length === 0) {
    throw new Error('buildIpv4WrapperScript: command must not be empty when ${hyveon.network.public-ipv4} is used.');
  }
  const tokenBearing = environment.filter((variable) => valueUsesToken(variable.value, HYVEON_ENV_TOKENS.publicIpv4));
  if (tokenBearing.length === 0) {
    throw new Error('buildIpv4WrapperScript: no environment variable carries the ${hyveon.network.public-ipv4} token.');
  }
  for (const variable of tokenBearing) {
    if (!SHELL_IDENTIFIER_PATTERN.test(variable.name)) {
      throw new Error(`buildIpv4WrapperScript: "${variable.name}" is not a valid shell identifier.`);
    }
  }

  const quotedUrl = shellSingleQuote(ipEchoUrl);
  return [
    `fetch_ip() { wget -t 1 -T 5 -qO- ${quotedUrl} 2>/dev/null || curl -fsS -m 5 ${quotedUrl} 2>/dev/null; }`,
    'attempt=0',
    'HYVEON_PUBLIC_IPV4=""',
    'while [ "$attempt" -lt 30 ]; do',
    `  HYVEON_PUBLIC_IPV4="$(fetch_ip | tr -d '[:space:]')"`,
    '  case "$HYVEON_PUBLIC_IPV4" in',
    '    ""|*[!0-9.]*) HYVEON_PUBLIC_IPV4="" ;;',
    '  esac',
    '  [ -n "$HYVEON_PUBLIC_IPV4" ] && break',
    '  attempt=$((attempt + 1))',
    '  sleep 2',
    'done',
    'if [ -z "$HYVEON_PUBLIC_IPV4" ]; then',
    '  echo "hyveon: public IPv4 discovery failed; stopping instead of starting with a broken address" >&2',
    '  exit 1',
    'fi',
    ...tokenBearing.map((variable) => `export ${variable.name}=${quotedWithIpSplices(variable.value)}`),
    `exec ${command.map(shellSingleQuote).join(' ')}`,
  ].join('\n');
}
