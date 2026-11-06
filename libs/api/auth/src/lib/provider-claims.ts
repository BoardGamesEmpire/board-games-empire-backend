/** What a sign-in provider says about a user, from its ID token or its UserInfo answer (#993). */
export type ProviderClaims = Readonly<Record<string, unknown>>;

/**
 * What better-auth's genericOAuth reads from a provider's `getUserInfo` (#993):
 * the merged claims themselves, which `mapOidcProfile` and `accountSubject`
 * read, plus the four fields it builds the user row from.
 */
export interface ProviderProfile extends Record<string, unknown> {
  email?: string;
  emailVerified: boolean;
  image?: string;
  name?: string;
}

/** What {@link mergeProviderClaims} answers: what to sign the user in with, or why there is nothing (#993). */
export type MergedProviderClaims =
  | {
      readonly outcome: 'profile';
      readonly profile: ProviderProfile;
      /** Whether a UserInfo answer was there but left out, because it named no subject that could be read. */
      readonly userInfoSetAside: boolean;
    }
  | { readonly outcome: 'subject-mismatch' }
  | { readonly outcome: 'none' };

/** A claim that is text, or `undefined` (#993). */
function textClaim(claims: ProviderClaims, key: string): string | undefined {
  const value = claims[key];

  return typeof value === 'string' ? value : undefined;
}

/** Whether `claims` names a subject: a `sub` that is non-empty text (#993). */
function hasSubject(claims: ProviderClaims): boolean {
  return Boolean(textClaim(claims, 'sub'));
}

/**
 * A UserInfo `sub` as the text it reads as, or `undefined` when it can't be
 * read exactly (#993). Some providers send it as a JSON number, which counts as
 * its text. One past `Number.MAX_SAFE_INTEGER` was rounded when the answer was
 * parsed, so its text could name another subject, or miss the user's own.
 */
function userInfoSubject(value: unknown): unknown {
  if (typeof value !== 'number') {
    return value;
  }

  return Number.isSafeInteger(value) ? String(value) : undefined;
}

/** Whether a claim says nothing: missing, `null` or empty text (#993). */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** The claims that say something, leaving out the blank ones (#993). */
function statedClaims(claims: ProviderClaims): ProviderClaims {
  return Object.fromEntries(Object.entries(claims).filter(([, value]) => !isBlank(value)));
}

/**
 * Whether one source confirms `email`: its own `email` is that address, with
 * case ignored, and its `email_verified` is the boolean `true` (#993).
 */
function confirms(source: ProviderClaims | undefined, email: string | undefined): boolean {
  const own = source === undefined ? undefined : textClaim(source, 'email');

  return (
    source?.['email_verified'] === true &&
    own !== undefined &&
    email !== undefined &&
    own.toLowerCase() === email.toLowerCase()
  );
}

/**
 * Merges a sign-in provider's ID-token claims with its UserInfo answer into
 * what better-auth signs the user in with (#993).
 *
 * Where both give a claim, the ID token's wins, and UserInfo fills the rest.
 * A claim the ID token gives as `null` or empty text says nothing, so it
 * doesn't hide UserInfo's. An ID token counts only when it names a subject.
 * OpenID Connect Core 5.3.2 lets a UserInfo answer be used only when its `sub`
 * is the ID token's, so another subject refuses the sign-in, and an answer
 * with none is set aside. A UserInfo `sub` sent as a number counts as the text
 * it reads as: some providers send one, and before #993 an ID token with an
 * email kept UserInfo from being asked at all, so they signed users in. A
 * number too large to have been read exactly is set aside too, since it can't
 * be told apart from a neighbouring subject's.
 *
 * `email_verified` counts only beside its own email. A source confirming an
 * address that isn't the one kept has not confirmed that one: counting it
 * would let one source's confirmation vouch for the other source's address.
 *
 * Without an ID token, UserInfo answers alone, as better-auth's own reading
 * does, even without a subject: `accountSubject` then refuses the sign-in, as
 * better-auth refuses a blank key.
 */
export function mergeProviderClaims(
  idToken: ProviderClaims | undefined,
  userInfo: ProviderClaims | undefined,
): MergedProviderClaims {
  const token = idToken !== undefined && hasSubject(idToken) ? idToken : undefined;
  if (token === undefined && userInfo === undefined) {
    return { outcome: 'none' };
  }

  let counted = userInfo;
  let userInfoSetAside = false;
  if (token !== undefined && userInfo !== undefined) {
    const subject = userInfoSubject(userInfo['sub']);
    if (isBlank(subject)) {
      counted = undefined;
      userInfoSetAside = true;
    } else if (subject !== token['sub']) {
      return { outcome: 'subject-mismatch' };
    }
  }

  const claims: ProviderClaims = { ...counted, ...(token === undefined ? {} : statedClaims(token)) };
  const email = textClaim(claims, 'email') || undefined;

  return {
    outcome: 'profile',
    userInfoSetAside,
    profile: {
      ...claims,
      email,
      emailVerified: confirms(token, email) || confirms(counted, email),
      image: textClaim(claims, 'picture'),
      name: textClaim(claims, 'name'),
    },
  };
}
