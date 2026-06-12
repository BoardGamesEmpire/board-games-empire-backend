/**
 * IP ranges that are rejected by default but CAN be overridden by adding
 * matching entries to `SafeHttpPolicy.allowedHosts` or `allowedCidrs`.
 *
 * This is the "default private ranges" set. A self-hoster running entirely
 * inside `10.0.0.0/8` adds that CIDR to the admin allowlist and resumes
 * normal operation; a SaaS deployment leaves the admin allowlist empty and
 * these ranges remain blocked.
 *
 * Distinct from {@link PERMANENT_BLOCKED_CIDRS}, which the admin allowlist
 * cannot override. The link-local prefix `169.254.0.0/16` overlaps with the
 * cloud-metadata IPs in the permanent list — those IPs remain blocked even
 * if an admin allowlists `169.254.0.0/16`, because the permanent list runs
 * first.
 */
export const DEFAULT_PRIVATE_CIDRS: readonly string[] = Object.freeze([
  // ── IPv4 private (RFC 1918) ───────────────────────────────
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // ── IPv4 loopback (RFC 1122) ──────────────────────────────
  '127.0.0.0/8',
  // ── IPv4 link-local (RFC 3927) ────────────────────────────
  '169.254.0.0/16',
  // ── IPv4 shared address space (RFC 6598, CGNAT) ───────────
  '100.64.0.0/10',
  // ── IPv4 multicast / reserved ─────────────────────────────
  '224.0.0.0/4',
  '240.0.0.0/4',
  // ── IPv6 loopback ─────────────────────────────────────────
  '::1/128',
  // ── IPv6 link-local (RFC 4291) ────────────────────────────
  'fe80::/10',
  // ── IPv6 unique local (RFC 4193) ──────────────────────────
  'fc00::/7',
  // ── IPv6 multicast ────────────────────────────────────────
  'ff00::/8',
  // ── IPv6 discard prefix (RFC 6666) ────────────────────────
  '100::/64',
]);
