/**
 * IP destinations that are NEVER reachable, regardless of admin allowlist.
 * Adding any of these to `SafeHttpPolicy.allowedHosts` or `allowedCidrs`
 * has no effect — the permanent denylist is evaluated before admin allowlists.
 *
 * Cloud instance metadata endpoints are the highest-value SSRF targets:
 * reaching them typically yields temporary IAM credentials, kubelet tokens,
 * or other secrets. The AWS/Alibaba endpoint also covers Oracle Cloud and
 * DigitalOcean which proxy through `169.254.169.254`.
 *
 * The unspecified and broadcast addresses are listed because some platforms
 * route `0.0.0.0` to loopback ("listen everywhere"); blocking it directly
 * removes a fallback evasion path.
 */
export const PERMANENT_BLOCKED_CIDRS: readonly string[] = Object.freeze([
  // ── Cloud metadata (IPv4) ─────────────────────────────────
  '169.254.169.254/32', // AWS, Azure, GCP, Alibaba, DigitalOcean, Oracle
  '169.254.170.2/32', // ECS task metadata
  // ── Cloud metadata (IPv6) ─────────────────────────────────
  'fd00:ec2::254/128', // AWS IPv6 IMDS
  // ── Unspecified / broadcast ───────────────────────────────
  '0.0.0.0/32',
  '255.255.255.255/32',
  '::/128',
]);

/**
 * Hostnames that resolve to instance metadata endpoints on various clouds.
 * Lower-cased, exact match. Admin allowlists do not override this.
 *
 * Defense in depth alongside the IP block above — some clouds resolve these
 * to public-looking addresses behind DNS-only routing tricks.
 */
export const PERMANENT_BLOCKED_HOSTNAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.azure.com',
    'metadata.ec2.internal',
    'instance-data',
    'instance-data.ec2.internal',
  ]),
);
