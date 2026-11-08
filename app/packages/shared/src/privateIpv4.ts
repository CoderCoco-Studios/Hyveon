const DOTTED_DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Parses a strict dotted-decimal IPv4 literal into its four octets, or `null` when `value` is not one.
 *
 * @remarks
 * Equivalent to `net.isIPv4` without importing it, because this module is re-exported from the `@hyveon/shared`
 * barrel and the renderer bundle cannot resolve Node built-ins. Exactly four decimal octets 0-255, no leading zeros,
 * no sign, whitespace, hex, octal, integer or short forms.
 *
 * @param value - The candidate address.
 * @returns The four octets, or `null`.
 */
function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every((part) => DOTTED_DECIMAL_OCTET.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

/**
 * Whether `value` is a well-formed dotted-decimal IPv4 literal inside an RFC 1918 private range
 * (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
 *
 * @remarks
 * Loopback, `0.0.0.0/8`, link-local, multicast, broadcast and public addresses are all outside those ranges.
 * Applied to the value as received, with no trimming. The VPC CIDR is operator configuration, not a constant, so
 * the private ranges are the tightest fixed bound a function without VPC configuration can enforce.
 *
 * @param value - The candidate address.
 * @returns `true` only for an RFC 1918 IPv4 literal.
 */
export function isPrivateIPv4(value: string): boolean {
  const octets = parseIPv4(value);
  if (octets === null) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
