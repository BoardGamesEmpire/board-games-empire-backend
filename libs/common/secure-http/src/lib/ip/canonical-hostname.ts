/**
 * The form of a hostname that host lists are compared in: lower-case, with
 * one trailing dot removed, since `example.com.` (rooted at the DNS root)
 * names the same host as `example.com`.
 *
 * The outbound HTTP policy compares its host lists in this form, and a
 * plugin's HTTP client compares its plugin manifest's outbound domains in it.
 * Both must agree: if they differed, a name one of them takes for a listed
 * host the other wouldn't, and a host could slip past one list while
 * passing the other (#1083).
 *
 * Compare in this form only. A lookup or a request uses the name as written.
 */
export function canonicalHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}
