/** The namespace an OpenID 2.0 message carries in `openid.ns` (#935). */
export const OPENID_2_NAMESPACE = 'http://specs.openid.net/auth/2.0';

/**
 * What a sign-in sends as both `openid.identity` and `openid.claimed_id` when
 * the user picks their account at Steam rather than naming it here (#935).
 */
export const OPENID_IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

/**
 * The fields of a positive answer that its signature must cover, so the check
 * Steam makes of the signature vouches for each one (OpenID 2.0, sections 10.1
 * and 11.4; #935). Steam signs these and `signed` itself.
 */
export const OPENID_REQUIRED_SIGNED_FIELDS: readonly string[] = [
  'op_endpoint',
  'return_to',
  'response_nonce',
  'assoc_handle',
  'claimed_id',
  'identity',
];

/** Where a Steam sign-in goes, and the form of the id Steam answers with (#935). */
export interface SteamOpenIdEndpoints {
  /**
   * The id an answer claims is this prefix followed by the 17-digit SteamID,
   * with nothing after it.
   */
  readonly claimedIdPrefix: string;

  /** Steam's OpenID endpoint: the sign-in goes here, and so does the check of its answer. */
  readonly endpoint: string;
}

/** Steam's own OpenID endpoints (#935). Specs pass a local server's instead. */
export const STEAM_OPENID_ENDPOINTS: SteamOpenIdEndpoints = {
  endpoint: 'https://steamcommunity.com/openid/login',
  claimedIdPrefix: 'https://steamcommunity.com/openid/id/',
};

/** A Steam account's profile address is this followed by its SteamID (#935). */
export const STEAM_PROFILE_URL_PREFIX = 'https://steamcommunity.com/profiles/';

/**
 * How long checking Steam's answer may take before the link answers that Steam
 * could not be reached (#935). The `openid` library's requests have no timeout
 * of their own.
 */
export const STEAM_VERIFY_TIMEOUT_MS = 10_000;
