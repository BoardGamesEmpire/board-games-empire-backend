import { createHash } from 'node:crypto';

/**
 * The name of the upstream fixture that answers an IGDB query: the endpoint
 * without its leading slash, then the first 12 hex characters of the SHA-1
 * of the query's clauses, trimmed and sorted. Sorting makes the name depend
 * on what the query asks for, not the order a client writes its clauses in,
 * so the old client and the new one share one set of fixtures (#1082).
 */
export function igdbFixtureKey(endpoint: string, body: string): string {
  const clauses = body
    .split(';')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .sort();

  const hash = createHash('sha1').update(clauses.join(';')).digest('hex').slice(0, 12);

  return `${endpoint.replace(/^\//, '')}-${hash}`;
}
