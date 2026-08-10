/**
 * Strips trailing `.` characters from a hosted-zone name.
 *
 * Route 53's console displays hosted-zone names with a trailing dot
 * (`example.com.`), which operators commonly copy-paste into the Settings
 * form verbatim. ACM's `domain_name` and Caddy's `--from` domain both reject
 * a value ending in a period, so every FQDN built from
 * `DeploymentConfig.hostedZoneName` must strip it first.
 *
 * Implemented as a manual scan rather than a regular expression
 * (`/\.+$/`) — CodeQL's `js/polynomial-redos` flags an unanchored trailing
 * quantifier applied to operator-controlled input, since a naive backtracking
 * engine can attempt the match starting at every position in the string.
 *
 * @param hostedZoneName - The raw hosted-zone name, with or without a
 *   trailing dot.
 * @returns `hostedZoneName` with every trailing `.` removed.
 */
export function stripTrailingDots(hostedZoneName: string): string {
  let end = hostedZoneName.length;
  while (end > 0 && hostedZoneName[end - 1] === '.') {
    end--;
  }
  return hostedZoneName.slice(0, end);
}
