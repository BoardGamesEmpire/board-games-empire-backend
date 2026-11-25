import type { IpFamily, ParsedIp } from './ip';
import { parseIp } from './ip';

/**
 * A parsed CIDR notation entry. `family` lets callers skip mismatched-family
 * comparisons; `prefixLength` is the number of significant bits.
 */
export interface ParsedCidr {
  /**
   * Network base bytes, with all bits beyond `prefixLength` zeroed.
   */
  baseBytes: Uint8Array;

  family: IpFamily;
  prefixLength: number;
}

/** A plain decimal number of up to three digits: `0`, or no leading zero. */
const PREFIX_DIGITS = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Parse a CIDR string (`10.0.0.0/8`, `fc00::/7`) into an internal form.
 * Returns `null` for malformed input; admin-supplied entries that fail to
 * parse are logged once at policy load time and skipped.
 *
 * A bare IP literal without `/N` is rejected — admins must be explicit
 * about prefix length to avoid `10.0.0.5` being silently interpreted as
 * `10.0.0.5/32`. Use `allowedHosts` for single-IP entries by hostname or
 * an exact `/32` / `/128` CIDR.
 */
export function parseCidr(input: string): ParsedCidr | null {
  const slashIndex = input.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  const addrPart = input.slice(0, slashIndex);
  const prefixPart = input.slice(slashIndex + 1);
  // Digits only (#1519): parseInt alone reads `/0x10` as `/0` and `/8abc`
  // as `/8`, turning a typo into a different, possibly match-all, entry.
  // A leading zero is refused for the same reason: `/00` would be read as
  // `/0`, every address, though it may be a mistyped `/10`.
  if (!PREFIX_DIGITS.test(prefixPart)) {
    return null;
  }

  const prefixLength = Number.parseInt(prefixPart, 10);

  // An IPv6 zone ID (`fe80::1%eth0`) names an interface on one host, which
  // no rule can match on. `parseIp` reads past it, so refuse it here rather
  // than apply the entry as if the zone weren't there (#1525).
  if (addrPart.includes('%')) {
    return null;
  }

  const ip = parseIp(addrPart);
  if (!ip) {
    return null;
  }

  const maxPrefix = ip.family === 4 ? 32 : 128;
  if (prefixLength > maxPrefix) {
    return null;
  }

  const baseBytes = applyPrefixMask(ip.bytes, prefixLength);
  return { family: ip.family, baseBytes, prefixLength };
}

/**
 * Test whether a parsed IP falls inside a parsed CIDR. Family mismatches
 * are non-matches by definition (an IPv4 IP never falls inside an IPv6
 * CIDR even if the bit pattern would match).
 */
export function cidrContains(cidr: ParsedCidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) {
    return false;
  }

  const masked = applyPrefixMask(ip.bytes, cidr.prefixLength);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== cidr.baseBytes[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Convenience: parse a list of CIDR strings, returning successfully parsed
 * entries. The caller is expected to log skipped (invalid) entries
 * separately — this function is silent on failure to keep it pure.
 */
export function parseCidrList(input: readonly string[]): ParsedCidr[] {
  const result: ParsedCidr[] = [];
  for (const entry of input) {
    const parsed = parseCidr(entry);
    if (parsed) {
      result.push(parsed);
    }
  }

  return result;
}

/**
 * Test whether a parsed IP falls inside any CIDR in a list. Returns the
 * first matching CIDR (for diagnostic reporting) or `null` for no match.
 */
export function findContainingCidr(cidrs: readonly ParsedCidr[], ip: ParsedIp): ParsedCidr | null {
  for (const cidr of cidrs) {
    if (cidrContains(cidr, ip)) {
      return cidr;
    }
  }

  return null;
}

/**
 * Zero out all bits beyond `prefixLength` in a byte array, returning a new
 * array. Used both for canonicalizing CIDR base bytes and for masking a
 * candidate IP before comparison.
 */
function applyPrefixMask(bytes: Uint8Array, prefixLength: number): Uint8Array {
  const masked = new Uint8Array(bytes);
  let bitsRemaining = prefixLength;
  for (let i = 0; i < masked.length; i++) {
    if (bitsRemaining >= 8) {
      bitsRemaining -= 8;
      continue;
    }

    if (bitsRemaining === 0) {
      masked[i] = 0;
      continue;
    }

    // Keep the top `bitsRemaining` bits, zero the rest.
    const mask = (0xff << (8 - bitsRemaining)) & 0xff;
    masked[i] = masked[i] & mask;
    bitsRemaining = 0;
  }

  return masked;
}
