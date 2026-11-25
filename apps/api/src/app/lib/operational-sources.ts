import { findContainingCidr, parseCidrList, parseIp } from '@bge/secure-http';

/**
 * The networks that may reach the operational port when the operator names
 * none (#1511): loopback, the private ranges, unique-local IPv6 and link-local
 * addresses. A container network or a reverse proxy on the same host sits in
 * one of them, and the open internet in none.
 */
export const DEFAULT_OPERATIONAL_SOURCES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  '169.254.0.0/16',
  'fe80::/10',
];

/**
 * Builds the check the operational port runs on each connection's peer address
 * (#1511). It takes `req.socket.remoteAddress` and nothing else: a forwarded
 * header is the caller's to set, so reading one would let any client claim an
 * allowed source.
 *
 * `parseIp` reads an IPv4-mapped IPv6 address (`::ffff:10.0.0.5`, how Node
 * reports an IPv4 peer on a dual-stack socket) as the IPv4 address it carries,
 * so the one IPv4 range covers both spellings.
 *
 * The list is parsed once, here. `parseCidrList` skips an entry it can't read,
 * which would quietly narrow the rule, so the configuration's schema rejects
 * such an entry before this runs.
 */
export function createSourceRule(cidrs: readonly string[]): (peer: string | undefined) => boolean {
  const allowed = parseCidrList(cidrs);

  return (peer) => {
    if (!peer) {
      return false;
    }

    const ip = parseIp(peer);

    return ip !== null && findContainingCidr(allowed, ip) !== null;
  };
}
