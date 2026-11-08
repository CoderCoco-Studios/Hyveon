import { isIPv4 } from 'node:net';

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
  if (!isIPv4(value)) {
    return false;
  }
  const [a, b] = value.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
