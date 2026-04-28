/**
 * Injection token for the underlying BoardGameGeek client. Bound to the
 * concrete `BggClient` instance returned by `BggClient.Create(config)`
 * inside `BggModule`. Tests inject a typed mock against this token.
 */
export const BGG_CLIENT = Symbol('BGG_CLIENT');
