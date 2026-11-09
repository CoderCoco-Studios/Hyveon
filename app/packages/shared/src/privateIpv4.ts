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

/**
 * Whether `ip` is a well-formed dotted-decimal IPv4 literal inside the IPv4 CIDR block `cidr`.
 *
 * @remarks
 * Both operands are parsed strictly (see {@link isPrivateIPv4}); the prefix length is a decimal integer 0-32 with no
 * sign, leading zero or whitespace. Host bits in `cidr` are ignored, so `10.0.0.77/24` matches `10.0.0.0/24`.
 * A malformed `ip` or `cidr` never matches, so a corrupt bound fails closed.
 *
 * @param ip - The candidate address.
 * @param cidr - The bounding block in `a.b.c.d/n` form.
 * @returns `true` only when both parse and `ip` lies inside `cidr`.
 */
export function isIPv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    return false;
  }
  const prefixText = cidr.slice(slash + 1);
  if (!/^(?:0|[1-9]\d?)$/.test(prefixText)) {
    return false;
  }
  const prefix = Number(prefixText);
  const addr = parseIPv4(ip);
  const base = parseIPv4(cidr.slice(0, slash));
  if (addr === null || base === null || prefix > 32) {
    return false;
  }
  const toInt = (o: [number, number, number, number]): number => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((toInt(addr) ^ toInt(base)) & mask) === 0;
}
