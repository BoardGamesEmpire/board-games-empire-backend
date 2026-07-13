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
 * The base path for all BetterAuth endpoints
 */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Schema version of the /.well-known/bge-identity document. Clients parse
 * known fields and ignore unknown ones gracefully; this is bumped only on a
 * breaking change to the document's shape.
 */
export const WELL_KNOWN_SCHEMA_VERSION = 1;
