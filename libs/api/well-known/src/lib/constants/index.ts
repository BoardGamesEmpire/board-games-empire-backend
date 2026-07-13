/**
 * Discriminant values for auth strategy DTOs.
 *
 * Values use snake_case to be consistent with the snake_case wire format
 * produced by SnakeCaseInterceptor
 */
export enum AuthStrategyType {
  EmailAndPassword = 'email_and_password',
  Oidc = 'oidc',
}

/**
 * The base path for all BetterAuth endpoints. Must be root-relative (leading
 * slash) — every BGE endpoint in the discovery document is built from it and
 * resolved by clients against the server's base URL. The invariant is enforced
 * by a test in strategy.service.spec.ts.
 */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Build a root-relative BGE auth endpoint from a path segment. Centralizes the
 * relative-path contract so new endpoints can't accidentally drift back to
 * absolute URLs or lose the leading slash. A missing leading slash is added, so
 * `authPath('device')` and `authPath('/device')` both yield `/api/auth/device`.
 *
 * @param segment endpoint segment, with or without a leading slash, e.g. `/get-session`
 */
export const authPath = (segment: string): string => {
  const normalized = segment.startsWith('/') ? segment : `/${segment}`;
  return `${AUTH_BASE_PATH}${normalized}`;
};

/**
 * Schema version of the /.well-known/bge-identity document. Clients parse
 * known fields and ignore unknown ones gracefully; this is bumped only on a
 * breaking change to the document's shape.
 */
export const WELL_KNOWN_SCHEMA_VERSION = 1;
