/** What each sign-in provider is asked for: the claims the profile mapping reads (#912). */
export const OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

export interface OidcProfileFields {
  name?: string;
  firstName?: string;
  lastName?: string;
}

/** A claim as trimmed text; blank, or not text, counts as absent. */
function claim(profile: Record<string, unknown>, key: string): string | undefined {
  const value = profile[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim() || undefined;
}

/**
 * Everything before the last `@`. An address with no `@`, or nothing before
 * it, has none: a name cut from a mangled address is worse than no name.
 */
function localPart(email: string | undefined): string | undefined {
  if (!email?.includes('@')) {
    return undefined;
  }

  return email.slice(0, email.lastIndexOf('@')).trim() || undefined;
}

/**
 * Maps a sign-in provider's claims onto the user row (#912). Raw claims are
 * present whether better-auth got the profile from the userinfo endpoint or
 * from the ID token.
 *
 * The username falls back to the email's local part last because better-auth
 * redirects with `name_is_missing` when it has no name at all. better-auth
 * applies this at the first sign-in only, since `overrideUserInfo` is unset,
 * so a later rename on the server survives.
 *
 * The picture is not mapped: better-auth already takes `image` from the
 * `picture` claim on both paths, and two sources for it could drift.
 */
export function mapOidcProfile(profile: Record<string, unknown>): OidcProfileFields {
  const fields: OidcProfileFields = {
    name: claim(profile, 'preferred_username') ?? claim(profile, 'name') ?? localPart(claim(profile, 'email')),
    firstName: claim(profile, 'given_name'),
    lastName: claim(profile, 'family_name'),
  };

  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as OidcProfileFields;
}
