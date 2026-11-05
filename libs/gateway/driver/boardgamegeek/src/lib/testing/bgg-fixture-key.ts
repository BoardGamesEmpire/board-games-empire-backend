/**
 * The name of the upstream fixture that answers a BGG request: the URL's
 * endpoint, then its parameters as `name=value`, sorted by name and decoded,
 * joined by `__`, with any character a file name can't safely hold replaced
 * by `_`. Sorting and decoding make the name depend on what the URL asks
 * for, not how a client spells it, so the old client and the new one share
 * one set of fixtures (#1082).
 */
export function bggFixtureKey(url: string | URL): string {
  const parsed = new URL(url);
  const endpoint = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  const parameters = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`);

  return [endpoint, ...parameters].join('__').replace(/[^A-Za-z0-9=,._-]/g, '_');
}
