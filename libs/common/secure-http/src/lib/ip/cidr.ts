import { IpFamily, parseIp, type ParsedIp } from './ip';

/**
 * A parsed CIDR notation entry. `family` lets callers skip mismatched-family
 * comparisons; `prefixLength` is the number of significant bits.
 */
export interface ParsedCidr {
  family: IpFamily;

  /**
   * Network base bytes, with all bits beyond `prefixLength` zeroed.
   */
  baseBytes: Uint8Array;

  prefixLength: number;
}

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
  if (slashIndex === -1) return null;

  const addrPart = input.slice(0, slashIndex);
  const prefixPart = input.slice(slashIndex + 1);
  const prefixLength = Number.parseInt(prefixPart, 10);
  if (!Number.isInteger(prefixLength) || prefixLength < 0) return null;

  const ip = parseIp(addrPart);
  if (!ip) return null;

  const maxPrefix = ip.family === 4 ? 32 : 128;
  if (prefixLength > maxPrefix) return null;

  const baseBytes = applyPrefixMask(ip.bytes, prefixLength);
  return { family: ip.family, baseBytes, prefixLength };
}

/**
 * Test whether a parsed IP falls inside a parsed CIDR. Family mismatches
 * are non-matches by definition (an IPv4 IP never falls inside an IPv6
 * CIDR even if the bit pattern would match).
 */
export function cidrContains(cidr: ParsedCidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;

  const masked = applyPrefixMask(ip.bytes, cidr.prefixLength);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== cidr.baseBytes[i]) return false;
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
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * Test whether a parsed IP falls inside any CIDR in a list. Returns the
 * first matching CIDR (for diagnostic reporting) or `null` for no match.
 */
export function findContainingCidr(cidrs: readonly ParsedCidr[], ip: ParsedIp): ParsedCidr | null {
  for (const cidr of cidrs) {
    if (cidrContains(cidr, ip)) return cidr;
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
