import { isIPv4, isIPv6 } from 'node:net';

export type IpFamily = 4 | 6;

/**
 * Internal representation of a parsed IP address. The discriminated `family`
 * lets callers branch without re-parsing; `bytes` holds the canonical byte
 * representation (4 bytes for IPv4, 16 for IPv6) used by CIDR matching.
 */
export interface ParsedIp {
  family: IpFamily;

  /**
   * Original string form, lower-cased. IPv4 addresses are dot-quad; IPv6 is canonical compact form.
   */
  canonical: string;

  /** Canonical bytes. Length 4 for IPv4, 16 for IPv6. */
  bytes: Uint8Array;

  /**
   * True when this IP was an IPv4-mapped IPv6 (`::ffff:x.x.x.x`) that the
   * parser normalized to IPv4. `IpPolicyService` reports rejections of
   * these as `ipv4-mapped-evasion` rather than `private-range`.
   */
  wasIpv4Mapped: boolean;
}

/**
 * Parse an IP literal into canonical form. Returns `null` for invalid input;
 * callers can branch without exceptions for the common "not an IP" case.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is normalized to IPv4 form so the
 * standard IPv4 deny rules apply. The `wasIpv4Mapped` flag is preserved on
 * the returned `ParsedIp` for evasion telemetry.
 */
export function parseIp(input: string): ParsedIp | null {
  const lower = input.toLowerCase();

  if (isIPv4(lower)) {
    return {
      family: 4,
      canonical: lower,
      bytes: ipv4ToBytes(lower),
      wasIpv4Mapped: false,
    } satisfies ParsedIp;
  }

  if (isIPv6(lower)) {
    const v6Bytes = ipv6ToBytes(lower);

    // IPv4-mapped IPv6: first 10 bytes zero, bytes 10-11 are 0xff,
    // bytes 12-15 are the IPv4 address.
    if (isIpv4Mapped(v6Bytes)) {
      const v4Bytes = v6Bytes.slice(12);
      const v4Canonical = `${v4Bytes[0]}.${v4Bytes[1]}.${v4Bytes[2]}.${v4Bytes[3]}`;
      return {
        family: 4,
        canonical: v4Canonical,
        bytes: v4Bytes,
        wasIpv4Mapped: true,
      } satisfies ParsedIp;
    }

    return {
      family: 6,
      canonical: lower,
      bytes: v6Bytes,
      wasIpv4Mapped: false,
    } satisfies ParsedIp;
  }

  return null;
}

/** Convert dotted-quad IPv4 to 4 canonical bytes. Assumes input already passed `isIPv4`. */
function ipv4ToBytes(input: string): Uint8Array {
  const parts = input.split('.');
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    bytes[i] = Number.parseInt(parts[i], 10);
  }

  return bytes;
}

/**
 * Convert canonical IPv6 string to 16 canonical bytes. Assumes input already
 * passed `isIPv6`. Handles `::` zero-compression and embedded IPv4 dotted-quad
 * tails (`::ffff:1.2.3.4`).
 */
function ipv6ToBytes(input: string): Uint8Array {
  // Split off an embedded IPv4 tail, if any, and replace with two hex groups.
  let normalized = input;

  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBytes(tail);
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);

    normalized = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  let groups: string[];

  // Expand `::` to the appropriate number of zero groups.
  const doubleColonIndex = normalized.indexOf('::');
  if (doubleColonIndex === -1) {
    groups = normalized.split(':');
  } else {
    const left = normalized.slice(0, doubleColonIndex);
    const right = normalized.slice(doubleColonIndex + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const zerosNeeded = 8 - leftGroups.length - rightGroups.length;

    groups = [...leftGroups, ...Array(zerosNeeded).fill('0'), ...rightGroups];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i] || '0', 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }

  return bytes;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }

  return bytes[10] === 0xff && bytes[11] === 0xff;
}
