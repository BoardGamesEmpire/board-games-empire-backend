/**
 * Import specifiers the install-time static analysis (#59)
 * screens plugin code for. Lives in this framework-free lib so the server
 * installer and the #84 `bge-plugin validate` CLI share ONE reviewed list —
 * the two surfaces can never disagree about what is forbidden.
 *
 * Static analysis is defense-in-depth, and the honest limit is worth
 * stating plainly: no specifier list is a network or filesystem sandbox.
 * `fetch` has been a global since Node 18 and needs no import at all, raw
 * sockets can carry a hand-rolled HTTP client, and `eval`-shaped access
 * defeats every static pass. The real isolation is that plugins are never
 * mounted into host DI (so a forbidden import resolves to nothing useful)
 * and, in worker mode (#197), that they run behind a message channel. This
 * list exists to fail installs LOUDLY on the ERGONOMIC paths — the ones an
 * author reaches for without meaning to smuggle anything — and to give
 * authors the same signal offline.
 */

/**
 * Rejected outright when imported by plugin code or declared as a
 * dependency.
 *
 * Two families:
 *
 * - Raw infrastructure the `PluginContext` capability surface exists to
 *   mediate: database client, cache/Redis clients, plus process spawning.
 * - Request-shaped outbound APIs. `SafeHttpService` (#55) is scoped to the
 *   manifest's `outboundDomains`, so that list IS the network consent
 *   surface, and anything whose purpose is issuing requests bypasses it
 *   wholesale. Node's own `http`/`https`/`http2` belong here for exactly
 *   the reason `axios` and `undici` do — screening the libraries while
 *   leaving the builtins they wrap unlisted would be incoherent.
 */
export const FORBIDDEN_IMPORT_SPECIFIERS: readonly string[] = [
  '@bge/database',
  '@prisma/client',
  '.prisma/client',
  '@nestjs/axios',
  'axios',
  'undici',
  'cache-manager',
  'ioredis',
  'iovalkey',
  'child_process',
  'node:child_process',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
];

/**
 * Flagged as warnings, never rejected — tier-1 honesty: these are
 * PRIMITIVES with legitimate plugin-local uses (reading a bundled asset,
 * talking to a sidecar the admin configured), they are reachable in-process
 * regardless, and rejection would ban that legitimate use. The line against
 * the forbidden list above is capability SHAPE, not danger level: a socket
 * or a file handle is a primitive, an HTTP client is a request.
 *
 * Both the `node:`-prefixed and bare forms are listed because CJS
 * `require('fs')` resolves the same module.
 */
export const WARNED_IMPORT_SPECIFIERS: readonly string[] = [
  'fs',
  'node:fs',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
];

export type ImportSpecifierVerdict = 'forbidden' | 'warning';

const matches = (specifier: string, entry: string): boolean => specifier === entry || specifier.startsWith(`${entry}/`);

/**
 * Classify one import specifier against the lists. Subpaths match their
 * root entry (`axios/lib/adapters/http` is still `axios`;
 * `@bge/database/anything` is still `@bge/database`), which is why matching
 * is prefix-per-entry rather than root-extraction — `.prisma/client` is a
 * real on-disk package name that no generic root rule handles cleanly.
 * Returns `null` for specifiers outside both lists (including all relative
 * imports, which can never name a host package).
 */
export const classifyImportSpecifier = (specifier: string): ImportSpecifierVerdict | null => {
  if (FORBIDDEN_IMPORT_SPECIFIERS.some((entry) => matches(specifier, entry))) {
    return 'forbidden';
  }

  if (WARNED_IMPORT_SPECIFIERS.some((entry) => matches(specifier, entry))) {
    return 'warning';
  }

  return null;
};

/** npm's alias protocol: `"my-http": "npm:axios@^1.7.0"` installs axios under the local name. */
export const NPM_ALIAS_PREFIX = 'npm:';

/**
 * Resolve the REAL package name behind an npm alias range, or `null` for an
 * ordinary range. Without this, name-level dependency screening is trivially
 * defeated: `"my-http": "npm:axios@^1"` puts axios in the tree under a name
 * no list contains, and the call site `require('my-http')` is unlisted too,
 * so all three screens come back clean. Shared with the #84 CLI, which
 * has to reach the same verdict offline.
 */
export const resolveAliasedPackageName = (range: string): string | null => {
  if (!range.startsWith(NPM_ALIAS_PREFIX)) {
    return null;
  }

  const target = range.slice(NPM_ALIAS_PREFIX.length);

  if (target.length === 0) {
    return null;
  }

  // Split on the LAST `@` so scoped targets survive: `@scope/pkg@^1` keeps
  // its leading `@`, and an index of 0 means there is no range to strip.
  const separator = target.lastIndexOf('@');

  return separator <= 0 ? target : target.slice(0, separator);
};
