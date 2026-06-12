/**
 * Test whether a hostname matches any entry in a list. Hostnames are
 * normalized to lowercase by the caller; this function does not re-lower.
 *
 * - When `allowWildcards` is `false` (strict mode), only exact matches count.
 *   Wildcard entries in the list are silently ignored — they're invalid
 *   under strict mode and the admin controller's DTO validation rejects
 *   them at write time anyway; this is defense in depth at read time.
 *
 * - When `allowWildcards` is `true`, an entry of the form `*.suffix` matches
 *   any hostname that ends in `.suffix`. The apex domain `suffix` is NOT
 *   matched by `*.suffix` — they're different identities. To match both,
 *   the admin lists both entries.
 *
 * Right-anchored matching guards against hostname-confusion exploits:
 * `*.example.com` matches `a.example.com` and `a.b.example.com` but NOT
 * `evil-example.com`. The leading `.` is the anchor; entries without `*.`
 * prefix are treated as exact matches regardless of mode.
 */
export function hostnameMatchesAny(hostname: string, list: readonly string[], allowWildcards: boolean): boolean {
  for (const entry of list) {
    if (entry.startsWith('*.')) {
      if (!allowWildcards) {
        continue;
      }

      const suffix = entry.slice(1); // ".example.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return true;
      }

      continue;
    }

    if (entry === hostname) {
      return true;
    }
  }

  return false;
}
